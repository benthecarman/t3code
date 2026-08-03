import * as NodeOS from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type * as EffectAcpSchema from "effect-acp/schema";
import { KimiSettings } from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";

import {
  buildInitialKimiProviderSnapshot,
  buildKimiCapabilitiesFromConfigOptions,
  checkKimiProviderStatus,
  discoverKimiModelsViaAcp,
  getKimiFallbackModels,
  kimiModeStateFromConfigOptions,
  resolveKimiAcpBaseModelId,
  resolveKimiAcpConfigUpdates,
} from "./KimiProvider.ts";

const decodeKimiSettings = Schema.decodeSync(KimiSettings);

const kimiConfigOptions = [
  {
    type: "select",
    id: "model",
    name: "Model",
    category: "model",
    currentValue: "kimi-code/k3",
    options: [
      { value: "kimi-code/kimi-for-coding", name: "K2.7 Coding" },
      { value: "kimi-code/kimi-for-coding-highspeed", name: "K2.7 Coding Highspeed" },
      { value: "kimi-code/k3", name: "K3" },
      { value: "kimi-code/k3-256k", name: "K3-256k" },
    ],
  },
  {
    type: "select",
    id: "thinking",
    name: "Thinking",
    category: "thought_level",
    currentValue: "high",
    options: [
      { value: "low", name: "Low" },
      { value: "high", name: "High" },
      { value: "max", name: "Max" },
    ],
  },
  {
    type: "select",
    id: "mode",
    name: "Mode",
    category: "mode",
    currentValue: "default",
    options: [
      { value: "default", name: "Default" },
      { value: "plan", name: "Plan" },
      { value: "auto", name: "Auto" },
      { value: "yolo", name: "Yolo" },
    ],
  },
] satisfies ReadonlyArray<EffectAcpSchema.SessionConfigOption>;

const resolveMockAgentPath = Effect.fn("resolveMockAgentPath")(function* () {
  const path = yield* Path.Path;
  return yield* path.fromFileUrl(new URL("../../../scripts/acp-mock-agent.ts", import.meta.url));
});

const makeMockAgentWrapper = Effect.fn("makeMockAgentWrapper")(function* (
  extraEnv?: Record<string, string>,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const mockAgentPath = yield* resolveMockAgentPath();
  const dir = yield* fileSystem.makeTempDirectory({
    directory: NodeOS.tmpdir(),
    prefix: "kimi-provider-mock-",
  });
  const wrapperPath = path.join(dir, "fake-kimi.sh");
  const mockAgentCommand = ["node", mockAgentPath].map((arg) => JSON.stringify(arg)).join(" ");
  const envExports = Object.entries(extraEnv ?? {})
    .map(([key, value]) => `export ${key}=${JSON.stringify(value)}`)
    .join("\n");
  const script = `#!/bin/sh
${envExports}
exec ${mockAgentCommand} "$@"
`;
  yield* fileSystem.writeFileString(wrapperPath, script);
  yield* fileSystem.chmod(wrapperPath, 0o755);
  return wrapperPath;
});

const makeMockAgentWithVersionWrapper = Effect.fn("makeMockAgentWithVersionWrapper")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const mockAgentPath = yield* resolveMockAgentPath();
  const dir = yield* fileSystem.makeTempDirectory({
    directory: NodeOS.tmpdir(),
    prefix: "kimi-provider-version-mock-",
  });
  const wrapperPath = path.join(dir, "fake-kimi.sh");
  const mockAgentCommand = ["node", mockAgentPath].map((arg) => JSON.stringify(arg)).join(" ");
  const script = `#!/bin/sh
if [ "$1" = "--version" ]; then
  printf 'kimi-cli 0.31.1\\n'
  exit 0
fi
exec ${mockAgentCommand} "$@"
`;
  yield* fileSystem.writeFileString(wrapperPath, script);
  yield* fileSystem.chmod(wrapperPath, 0o755);
  return wrapperPath;
});

const waitForFileContent = Effect.fn("waitForFileContent")(function* (
  filePath: string,
  attempts = 40,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const content = yield* fileSystem
      .readFileString(filePath)
      .pipe(Effect.catch(() => Effect.void));
    if (content !== undefined) {
      if (content.trim().length > 0) {
        return content;
      }
    }
    yield* Effect.sleep("50 millis");
  }
  return yield* Effect.die(`Timed out waiting for file content at ${filePath}`);
});

describe("buildInitialKimiProviderSnapshot", () => {
  it.effect("returns a disabled snapshot when settings.enabled is false", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialKimiProviderSnapshot(
        decodeKimiSettings({ enabled: false }),
      );
      expect(snapshot.enabled).toBe(false);
      expect(snapshot.status).toBe("disabled");
      expect(snapshot.installed).toBe(false);
      expect(snapshot.message).toContain("disabled");
    }),
  );

  it.effect("returns a pending snapshot by default", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialKimiProviderSnapshot(decodeKimiSettings({}));
      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(true);
      expect(snapshot.status).toBe("warning");
      expect(snapshot.version).toBeNull();
      expect(snapshot.message).toContain("Checking Kimi");
      expect(snapshot.showInteractionModeToggle).toBe(true);
    }),
  );
});

describe("getKimiFallbackModels", () => {
  it("publishes the built-in default model plus custom models before ACP discovery", () => {
    expect(
      getKimiFallbackModels({
        customModels: ["internal/kimi-model"],
      }).map((model) => model.slug),
    ).toEqual(["kimi-code/k3", "internal/kimi-model"]);
  });
});

describe("buildKimiCapabilitiesFromConfigOptions", () => {
  it("derives a reasoning descriptor from the thought_level config option", () => {
    expect(buildKimiCapabilitiesFromConfigOptions(kimiConfigOptions)).toEqual(
      createModelCapabilities({
        optionDescriptors: [
          {
            id: "reasoning",
            label: "Thinking",
            type: "select" as const,
            options: [
              { id: "low", label: "Low" },
              { id: "high", label: "High", isDefault: true },
              { id: "max", label: "Max" },
            ],
            currentValue: "high",
          },
        ],
      }),
    );
  });

  it("returns empty capabilities when no config options are present", () => {
    expect(buildKimiCapabilitiesFromConfigOptions(undefined)).toEqual(
      createModelCapabilities({ optionDescriptors: [] }),
    );
  });
});

describe("kimiModeStateFromConfigOptions", () => {
  it("derives a mode state from the mode-category config option", () => {
    expect(kimiModeStateFromConfigOptions(kimiConfigOptions)).toEqual({
      currentModeId: "default",
      availableModes: [
        { id: "default", name: "Default" },
        { id: "plan", name: "Plan" },
        { id: "auto", name: "Auto" },
        { id: "yolo", name: "Yolo" },
      ],
    });
  });

  it("returns undefined when no mode config option is present", () => {
    expect(kimiModeStateFromConfigOptions([])).toBeUndefined();
    expect(kimiModeStateFromConfigOptions(kimiConfigOptions.slice(0, 2))).toBeUndefined();
  });
});

describe("resolveKimiAcpBaseModelId", () => {
  it("drops bracket traits without rewriting raw ACP model ids", () => {
    expect(resolveKimiAcpBaseModelId("kimi-code/k3[thinking=high]")).toBe("kimi-code/k3");
    expect(resolveKimiAcpBaseModelId("kimi-code/k3-256k")).toBe("kimi-code/k3-256k");
    expect(resolveKimiAcpBaseModelId(undefined)).toBe("kimi-code/k3");
    expect(resolveKimiAcpBaseModelId("  ")).toBe("kimi-code/k3");
  });
});

describe("resolveKimiAcpConfigUpdates", () => {
  it("maps the reasoning selection onto the thought_level config option", () => {
    expect(
      resolveKimiAcpConfigUpdates(kimiConfigOptions, [{ id: "reasoning", value: "max" }]),
    ).toEqual([{ configId: "thinking", value: "max" }]);
  });

  it("drops reasoning values Kimi does not support", () => {
    expect(
      resolveKimiAcpConfigUpdates(kimiConfigOptions, [{ id: "reasoning", value: "medium" }]),
    ).toEqual([]);
    expect(
      resolveKimiAcpConfigUpdates(kimiConfigOptions, [{ id: "reasoning", value: "xhigh" }]),
    ).toEqual([]);
  });
});

it.layer(NodeServices.layer)("checkKimiProviderStatus", (it) => {
  it.effect("reports the binary as missing when the binary path does not resolve", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkKimiProviderStatus(
        decodeKimiSettings({
          enabled: true,
          binaryPath: "/definitely/not/installed/kimi-binary",
        }),
      );
      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(false);
      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toMatch(/not installed|not on PATH|Failed to execute/);
    }),
  );

  it.effect("reports an installed CLI as unhealthy when --version exits non-zero", () =>
    Effect.gen(function* () {
      const secretStderr = "broken kimi install: secret-token-value";
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-kimi-version-" });
          const kimiPath = path.join(dir, "kimi");
          yield* fs.writeFileString(
            kimiPath,
            ["#!/bin/sh", `printf "%s\\n" "${secretStderr}" >&2`, "exit 2", ""].join("\n"),
          );
          yield* fs.chmod(kimiPath, 0o755);

          return yield* checkKimiProviderStatus(
            decodeKimiSettings({ enabled: true, binaryPath: kimiPath }),
          );
        }),
      );

      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(true);
      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toBe("Kimi CLI is installed but failed to run.");
      expect(snapshot.message).not.toContain(secretStderr);
    }),
  );

  it.effect("reports an error when ACP model discovery is unavailable", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-kimi-success-" });
          const kimiPath = path.join(dir, "kimi");
          yield* fs.writeFileString(
            kimiPath,
            ["#!/bin/sh", 'printf "kimi-cli 0.0.99\\n"', "exit 0", ""].join("\n"),
          );
          yield* fs.chmod(kimiPath, 0o755);

          return yield* checkKimiProviderStatus(
            decodeKimiSettings({ enabled: true, binaryPath: kimiPath }),
          );
        }),
      );

      expect(snapshot.status).toBe("error");
      expect(snapshot.installed).toBe(true);
      expect(snapshot.models.map((model) => model.slug)).toEqual(["kimi-code/k3"]);
      expect(snapshot.message).toContain("ACP startup failed");
    }),
  );

  it.effect("discovers models and reasoning capabilities through the ACP probe", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fileSystem.makeTempDirectory({
        directory: NodeOS.tmpdir(),
        prefix: "kimi-provider-status-env-",
      });
      const requestLogPath = path.join(tempDir, "requests.ndjson");
      const wrapperPath = yield* makeMockAgentWithVersionWrapper();

      const snapshot = yield* checkKimiProviderStatus(
        decodeKimiSettings({ enabled: true, binaryPath: wrapperPath }),
        {
          ...process.env,
          T3_ACP_REQUEST_LOG_PATH: requestLogPath,
        },
      );

      expect(snapshot.status).toBe("ready");
      expect(snapshot.version).toBe("0.31.1");
      expect(snapshot.models.map((model) => model.slug)).toEqual([
        "default",
        "composer-2",
        "gpt-5.3-codex",
      ]);

      const requestLog = yield* waitForFileContent(requestLogPath);
      expect(requestLog).toContain("initialize");
      expect(requestLog).toContain("terminal");
    }),
  );
});

it.layer(NodeServices.layer)("discoverKimiModelsViaAcp", (it) => {
  it.effect("reads the model select from session configOptions", () =>
    Effect.gen(function* () {
      const wrapperPath = yield* makeMockAgentWrapper();

      const models = yield* discoverKimiModelsViaAcp(
        decodeKimiSettings({ enabled: true, binaryPath: wrapperPath }),
      );

      expect(models.map((model) => model.slug)).toEqual(["default", "composer-2", "gpt-5.3-codex"]);
    }),
  );
});
