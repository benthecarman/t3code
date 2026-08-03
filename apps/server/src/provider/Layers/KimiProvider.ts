import type {
  KimiSettings,
  ModelCapabilities,
  ProviderOptionSelection,
  ServerProvider,
  ServerProviderModel,
} from "@t3tools/contracts";
import type * as EffectAcpSchema from "effect-acp/schema";
import { causeErrorTag } from "@t3tools/shared/observability";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { HttpClient } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import {
  createModelCapabilities,
  getProviderOptionStringSelectionValue,
} from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import {
  buildSelectOptionDescriptor,
  buildServerProvider,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  type ProviderMaintenanceCapabilities,
} from "../providerMaintenance.ts";
import * as AcpSessionRuntime from "../acp/AcpSessionRuntime.ts";
import type { AcpSessionMode, AcpSessionModeState } from "../acp/AcpRuntimeModel.ts";

/**
 * `kimi acp` does not exit on SIGTERM (verified against v0.31.1 — the process
 * stays alive until SIGKILL). Without a grace-based escalation the runtime
 * scope close would wait for the child exit forever, hanging `stopSession`
 * and provider-check teardown.
 */
export const KIMI_FORCE_KILL_AFTER = "3 seconds" as const;

const KIMI_PRESENTATION = {
  displayName: "Kimi",
  badgeLabel: "Early Access",
  showInteractionModeToggle: true,
} as const;
const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

const VERSION_PROBE_TIMEOUT_MS = 4_000;
const KIMI_ACP_MODEL_DISCOVERY_TIMEOUT_MS = 15_000;

const KIMI_DEFAULT_MODEL = "kimi-code/k3";

const KIMI_BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: KIMI_DEFAULT_MODEL,
    name: "K3",
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
  },
];

// Kimi's single auth method (`login`) is terminal-type, so the client must
// advertise terminal capability for the agent to drive `kimi login` when no
// credentials exist yet.
export const KIMI_ACP_CLIENT_CAPABILITIES = {
  terminal: true,
} satisfies NonNullable<EffectAcpSchema.InitializeRequest["clientCapabilities"]>;

export function buildInitialKimiProviderSnapshot(
  kimiSettings: KimiSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models = kimiModelsFromSettings(kimiSettings.customModels);

    if (!kimiSettings.enabled) {
      return buildServerProvider({
        presentation: KIMI_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Kimi is disabled in T3 Code settings.",
        },
      });
    }

    return buildServerProvider({
      presentation: KIMI_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Checking Kimi CLI availability...",
      },
    });
  });
}

function kimiModelsFromSettings(
  customModels: ReadonlyArray<string> | undefined,
  builtInModels: ReadonlyArray<ServerProviderModel> = KIMI_BUILT_IN_MODELS,
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(builtInModels, customModels ?? [], EMPTY_CAPABILITIES);
}

interface KimiSessionSelectOption {
  readonly value: string;
  readonly name: string;
}

function flattenKimiSessionConfigSelectOptions(
  configOption: EffectAcpSchema.SessionConfigOption | undefined,
): ReadonlyArray<KimiSessionSelectOption> {
  if (!configOption || configOption.type !== "select") {
    return [];
  }
  return configOption.options.flatMap((entry) =>
    "value" in entry
      ? [
          {
            value: entry.value.trim(),
            name: entry.name.trim(),
          } satisfies KimiSessionSelectOption,
        ]
      : entry.options.map(
          (option) =>
            ({
              value: option.value.trim(),
              name: option.name.trim(),
            }) satisfies KimiSessionSelectOption,
        ),
  );
}

function normalizeKimiReasoningValue(value: string | null | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  switch (normalized) {
    case "low":
    case "high":
    case "max":
      return normalized;
    default:
      return undefined;
  }
}

function getKimiConfigOptionCategory(option: EffectAcpSchema.SessionConfigOption): string {
  return option.category?.trim().toLowerCase() ?? "";
}

function findKimiReasoningConfigOption(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
): EffectAcpSchema.SessionConfigOption | undefined {
  return configOptions.find(
    (option) => option.type === "select" && getKimiConfigOptionCategory(option) === "thought_level",
  );
}

function findKimiModelConfigOption(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
): EffectAcpSchema.SessionConfigOption | undefined {
  return configOptions.find(
    (option) => option.type === "select" && getKimiConfigOptionCategory(option) === "model",
  );
}

/**
 * Kimi advertises session modes only through the `mode`-category config
 * option — `session/new` has no legacy `modes` field, so
 * `AcpSessionRuntime.getModeState` stays `undefined`. Derive an equivalent
 * mode state from the config option so the adapter's plan/full-access alias
 * mapping has something to resolve against.
 */
export function kimiModeStateFromConfigOptions(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
): AcpSessionModeState | undefined {
  const modeOption = configOptions.find(
    (option) => option.type === "select" && getKimiConfigOptionCategory(option) === "mode",
  );
  if (!modeOption || modeOption.type !== "select") {
    return undefined;
  }
  const availableModes = flattenKimiSessionConfigSelectOptions(modeOption).flatMap((entry) => {
    if (!entry.value) {
      return [];
    }
    return [{ id: entry.value, name: entry.name || entry.value } satisfies AcpSessionMode];
  });
  if (availableModes.length === 0) {
    return undefined;
  }
  const currentModeId = modeOption.currentValue?.trim() || availableModes[0]!.id;
  return { currentModeId, availableModes };
}

export function buildKimiCapabilitiesFromConfigOptions(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined,
): ModelCapabilities {
  if (!configOptions || configOptions.length === 0) {
    return EMPTY_CAPABILITIES;
  }

  const reasoningConfig = findKimiReasoningConfigOption(configOptions);
  const reasoningEffortLevels =
    reasoningConfig?.type === "select"
      ? flattenKimiSessionConfigSelectOptions(reasoningConfig).flatMap((entry) => {
          const normalizedValue = normalizeKimiReasoningValue(entry.value);
          if (!normalizedValue) {
            return [];
          }
          return [
            {
              value: normalizedValue,
              label: entry.name,
              ...(normalizeKimiReasoningValue(reasoningConfig.currentValue) === normalizedValue
                ? { isDefault: true }
                : {}),
            },
          ];
        })
      : [];

  return createModelCapabilities({
    optionDescriptors:
      reasoningEffortLevels.length > 0
        ? [
            buildSelectOptionDescriptor({
              id: "reasoning",
              label: reasoningConfig?.name?.trim() || "Reasoning",
              options: reasoningEffortLevels,
            }),
          ]
        : [],
  });
}

function buildKimiDiscoveredModelsFromConfigOptions(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined,
): ReadonlyArray<ServerProviderModel> {
  const modelOption = configOptions ? findKimiModelConfigOption(configOptions) : undefined;
  if (!modelOption) {
    return [];
  }
  const capabilities = buildKimiCapabilitiesFromConfigOptions(configOptions);
  const seen = new Set<string>();
  return flattenKimiSessionConfigSelectOptions(modelOption).flatMap((entry) => {
    const slug = resolveKimiAcpBaseModelId(entry.value);
    if (!slug || seen.has(slug)) {
      return [];
    }
    seen.add(slug);
    return [
      {
        slug,
        name: entry.name || slug,
        isCustom: false,
        capabilities,
      } satisfies ServerProviderModel,
    ];
  });
}

const makeKimiAcpProbeRuntime = (kimiSettings: KimiSettings, environment?: NodeJS.ProcessEnv) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        spawn: {
          command: kimiSettings.binaryPath,
          args: ["acp"],
          cwd: process.cwd(),
          ...(environment ? { env: environment } : {}),
        },
        cwd: process.cwd(),
        clientInfo: { name: "t3-code-provider-probe", version: "0.0.0" },
        authMethodId: "login",
        clientCapabilities: KIMI_ACP_CLIENT_CAPABILITIES,
        forceKillAfter: KIMI_FORCE_KILL_AFTER,
      }).pipe(Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner))),
    );
    return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
      Effect.provide(acpContext),
    );
  });

const withKimiAcpProbeRuntime = <A, E, R>(
  kimiSettings: KimiSettings,
  useRuntime: (acp: AcpSessionRuntime.AcpSessionRuntime["Service"]) => Effect.Effect<A, E, R>,
  environment?: NodeJS.ProcessEnv,
) =>
  makeKimiAcpProbeRuntime(kimiSettings, environment).pipe(
    Effect.flatMap(useRuntime),
    Effect.scoped,
  );

export const discoverKimiModelsViaAcp = (
  kimiSettings: KimiSettings,
  environment?: NodeJS.ProcessEnv,
) =>
  withKimiAcpProbeRuntime(
    kimiSettings,
    (acp) =>
      Effect.gen(function* () {
        const started = yield* acp.start();
        return buildKimiDiscoveredModelsFromConfigOptions(started.sessionSetupResult.configOptions);
      }),
    environment,
  );

export function getKimiFallbackModels(
  kimiSettings: Pick<KimiSettings, "customModels">,
): ReadonlyArray<ServerProviderModel> {
  return kimiModelsFromSettings(kimiSettings.customModels);
}

export function resolveKimiAcpBaseModelId(model: string | null | undefined): string {
  const trimmed = model?.trim();
  const base = trimmed && trimmed.length > 0 ? trimmed : KIMI_DEFAULT_MODEL;
  return base.includes("[") ? base.slice(0, base.indexOf("[")) : base;
}

export function resolveKimiAcpConfigUpdates(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined,
  selections: ReadonlyArray<ProviderOptionSelection> | null | undefined,
): ReadonlyArray<{
  readonly configId: string;
  readonly value: string | boolean;
}> {
  if (!configOptions || configOptions.length === 0) {
    return [];
  }

  const updates: Array<{
    readonly configId: string;
    readonly value: string | boolean;
  }> = [];

  const reasoningOption = findKimiReasoningConfigOption(configOptions);
  const requestedReasoning = normalizeKimiReasoningValue(
    getProviderOptionStringSelectionValue(selections, "reasoning"),
  );
  if (reasoningOption && requestedReasoning) {
    const value = flattenKimiSessionConfigSelectOptions(reasoningOption).find((option) => {
      const normalizedValue = normalizeKimiReasoningValue(option.value);
      const normalizedName = normalizeKimiReasoningValue(option.name);
      return normalizedValue === requestedReasoning || normalizedName === requestedReasoning;
    })?.value;
    if (value) {
      updates.push({ configId: reasoningOption.id, value });
    }
  }

  return updates;
}

const runKimiVersionCommand = (
  kimiSettings: KimiSettings,
  environment: NodeJS.ProcessEnv = process.env,
) =>
  Effect.gen(function* () {
    const command = kimiSettings.binaryPath || "kimi";
    const spawnCommand = yield* resolveSpawnCommand(command, ["--version"], {
      env: environment,
    });
    return yield* spawnAndCollect(
      command,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: environment,
        shell: spawnCommand.shell,
      }),
    );
  });

export const checkKimiProviderStatus = Effect.fn("checkKimiProviderStatus")(function* (
  kimiSettings: KimiSettings,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto
> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const fallbackModels = kimiModelsFromSettings(kimiSettings.customModels);

  if (!kimiSettings.enabled) {
    return buildServerProvider({
      presentation: KIMI_PRESENTATION,
      enabled: false,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Kimi is disabled in T3 Code settings.",
      },
    });
  }

  const versionResult = yield* runKimiVersionCommand(kimiSettings, environment).pipe(
    Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(versionResult)) {
    const error = versionResult.failure;
    yield* Effect.logWarning("Kimi CLI health check failed.", {
      errorTag: error._tag,
    });
    return buildServerProvider({
      presentation: KIMI_PRESENTATION,
      enabled: kimiSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: !isCommandMissingCause(error),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(error)
          ? "Kimi CLI (`kimi`) is not installed or not on PATH."
          : "Failed to execute Kimi CLI health check.",
      },
    });
  }

  if (Option.isNone(versionResult.success)) {
    return buildServerProvider({
      presentation: KIMI_PRESENTATION,
      enabled: kimiSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "Kimi CLI is installed but timed out while running `kimi --version`.",
      },
    });
  }

  const versionOutput = versionResult.success.value;
  const version = parseGenericCliVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);
  if (versionOutput.code !== 0) {
    yield* Effect.logWarning("Kimi CLI version probe exited with a non-zero status.", {
      exitCode: versionOutput.code,
      stdoutLength: versionOutput.stdout.length,
      stderrLength: versionOutput.stderr.length,
    });
    return buildServerProvider({
      presentation: KIMI_PRESENTATION,
      enabled: kimiSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: "Kimi CLI is installed but failed to run.",
      },
    });
  }

  const discoveryExit = yield* discoverKimiModelsViaAcp(kimiSettings, environment).pipe(
    Effect.timeoutOption(KIMI_ACP_MODEL_DISCOVERY_TIMEOUT_MS),
    Effect.exit,
  );
  if (Exit.isFailure(discoveryExit)) {
    yield* Effect.logWarning("Kimi ACP model discovery failed", {
      errorTag: causeErrorTag(discoveryExit.cause),
    });
    return buildServerProvider({
      presentation: KIMI_PRESENTATION,
      enabled: kimiSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: "Kimi CLI is installed but ACP startup failed. Check server logs for details.",
      },
    });
  }
  if (Option.isNone(discoveryExit.value)) {
    yield* Effect.logWarning(
      `Kimi ACP model discovery timed out after ${KIMI_ACP_MODEL_DISCOVERY_TIMEOUT_MS}ms.`,
    );
    return buildServerProvider({
      presentation: KIMI_PRESENTATION,
      enabled: kimiSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: `Kimi CLI is installed but ACP startup timed out after ${KIMI_ACP_MODEL_DISCOVERY_TIMEOUT_MS}ms.`,
      },
    });
  }
  const discoveredModels = discoveryExit.value.value;
  const models =
    discoveredModels.length > 0
      ? kimiModelsFromSettings(kimiSettings.customModels, discoveredModels)
      : fallbackModels;

  return buildServerProvider({
    presentation: KIMI_PRESENTATION,
    enabled: kimiSettings.enabled,
    checkedAt,
    models,
    probe: {
      installed: true,
      version,
      status: "ready",
      auth: { status: "unknown" },
    },
  });
});

export const enrichKimiSnapshot = (input: {
  readonly snapshot: ServerProvider;
  readonly maintenanceCapabilities: ProviderMaintenanceCapabilities;
  readonly enableProviderUpdateChecks?: boolean;
  readonly publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>;
  readonly httpClient: HttpClient.HttpClient;
}): Effect.Effect<void> => {
  const { snapshot, publishSnapshot } = input;

  return enrichProviderSnapshotWithVersionAdvisory(snapshot, input.maintenanceCapabilities, {
    enableProviderUpdateChecks: input.enableProviderUpdateChecks,
  }).pipe(
    Effect.provideService(HttpClient.HttpClient, input.httpClient),
    Effect.flatMap((enrichedSnapshot) => publishSnapshot(enrichedSnapshot)),
    Effect.catchCause((cause) =>
      Effect.logWarning("Kimi version advisory enrichment failed", {
        errorTag: causeErrorTag(cause),
      }),
    ),
    Effect.asVoid,
  );
};
