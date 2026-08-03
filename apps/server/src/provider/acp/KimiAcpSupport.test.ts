import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type * as EffectAcpSchema from "effect-acp/schema";

import { applyKimiAcpModelSelection, buildKimiAcpSpawnInput } from "./KimiAcpSupport.ts";

const kimiConfigOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> = [
  {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: "kimi-code/k3",
    options: [
      { value: "kimi-code/kimi-for-coding", name: "K2.7 Coding" },
      { value: "kimi-code/kimi-for-coding-highspeed", name: "K2.7 Coding Highspeed" },
      { value: "kimi-code/k3", name: "K3" },
      { value: "kimi-code/k3-256k", name: "K3-256k" },
    ],
  },
  {
    id: "thinking",
    name: "Thinking",
    category: "thought_level",
    type: "select",
    currentValue: "high",
    options: [
      { value: "low", name: "Low" },
      { value: "high", name: "High" },
      { value: "max", name: "Max" },
    ],
  },
  {
    id: "mode",
    name: "Mode",
    category: "mode",
    type: "select",
    currentValue: "default",
    options: [
      { value: "default", name: "Default" },
      { value: "plan", name: "Plan" },
      { value: "auto", name: "Auto" },
      { value: "yolo", name: "Yolo" },
    ],
  },
];

describe("buildKimiAcpSpawnInput", () => {
  it("builds the default Kimi ACP command", () => {
    expect(buildKimiAcpSpawnInput(undefined, "/tmp/project")).toEqual({
      command: "kimi",
      args: ["acp"],
      cwd: "/tmp/project",
    });
  });

  it("uses the configured binary path when present", () => {
    expect(
      buildKimiAcpSpawnInput(
        {
          binaryPath: "/usr/local/bin/kimi",
        },
        "/tmp/project",
      ),
    ).toEqual({
      command: "/usr/local/bin/kimi",
      args: ["acp"],
      cwd: "/tmp/project",
    });
  });

  it("passes the environment through when provided", () => {
    expect(buildKimiAcpSpawnInput(undefined, "/tmp/project", { FOO: "bar" })).toEqual({
      command: "kimi",
      args: ["acp"],
      cwd: "/tmp/project",
      env: { FOO: "bar" },
    });
  });
});

describe("applyKimiAcpModelSelection", () => {
  it.effect("sets the base model before applying separate config options", () =>
    Effect.gen(function* () {
      const calls: Array<
        | { readonly type: "model"; readonly value: string }
        | { readonly type: "config"; readonly configId: string; readonly value: string | boolean }
      > = [];

      const runtime = {
        getConfigOptions: Effect.succeed(kimiConfigOptions),
        setModel: (value: string) =>
          Effect.sync(() => {
            calls.push({ type: "model", value });
          }),
        setConfigOption: (configId: string, value: string | boolean) =>
          Effect.sync(() => {
            calls.push({ type: "config", configId, value });
          }),
      };

      yield* applyKimiAcpModelSelection({
        runtime,
        model: "kimi-code/k3-256k",
        selections: [{ id: "reasoning", value: "max" }],
        mapError: ({ step, configId, cause }) =>
          step === "set-config-option"
            ? `failed to set config option ${configId}: ${cause.message}`
            : `failed to set model: ${cause.message}`,
      });

      expect(calls).toEqual([
        { type: "model", value: "kimi-code/k3-256k" },
        { type: "config", configId: "thinking", value: "max" },
      ]);
    }),
  );

  it.effect("ignores reasoning selections Kimi does not support", () =>
    Effect.gen(function* () {
      const calls: Array<
        | { readonly type: "model"; readonly value: string }
        | { readonly type: "config"; readonly configId: string; readonly value: string | boolean }
      > = [];

      const runtime = {
        getConfigOptions: Effect.succeed(kimiConfigOptions),
        setModel: (value: string) =>
          Effect.sync(() => {
            calls.push({ type: "model", value });
          }),
        setConfigOption: (configId: string, value: string | boolean) =>
          Effect.sync(() => {
            calls.push({ type: "config", configId, value });
          }),
      };

      yield* applyKimiAcpModelSelection({
        runtime,
        model: null,
        selections: [{ id: "reasoning", value: "medium" }],
        mapError: ({ cause }) => `failed: ${cause.message}`,
      });

      expect(calls).toEqual([{ type: "model", value: "kimi-code/k3" }]);
    }),
  );
});
