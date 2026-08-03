// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeFSP from "node:fs/promises";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import {
  ApprovalRequestId,
  KimiSettings,
  ProviderDriverKind,
  type ProviderRuntimeEvent,
  ThreadId,
  ProviderInstanceId,
} from "@t3tools/contracts";

import { ServerConfig } from "../../config.ts";
import { makeKimiAdapter } from "./KimiAdapter.ts";
const decodeKimiSettings = Schema.decodeSync(KimiSettings);

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../../scripts/acp-mock-agent.ts");
const mockAgentCommand = "node";
const mockAgentArgs = [mockAgentPath] as const;

async function makeMockAgentWrapper(extraEnv?: Record<string, string>) {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "kimi-acp-mock-"));
  const wrapperPath = NodePath.join(dir, "fake-kimi.sh");
  const envExports = Object.entries(extraEnv ?? {})
    .map(([key, value]) => `export ${key}=${JSON.stringify(value)}`)
    .join("\n");
  const script = `#!/bin/sh
${envExports}
exec ${JSON.stringify(mockAgentCommand)} ${mockAgentArgs.map((arg) => JSON.stringify(arg)).join(" ")} "$@"
`;
  await NodeFSP.writeFile(wrapperPath, script, "utf8");
  await NodeFSP.chmod(wrapperPath, 0o755);
  return wrapperPath;
}

const kimiAdapterTestLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-kimi-adapter-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

const makeTestAdapter = (binaryPath: string, options?: Parameters<typeof makeKimiAdapter>[1]) =>
  makeKimiAdapter(decodeKimiSettings({ binaryPath }), options).pipe(Effect.orDie);

it.layer(kimiAdapterTestLayer)("KimiAdapterLive", (it) => {
  it.effect("starts a session and maps mock ACP prompt flow to runtime events", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("kimi-mock-thread");
      const wrapperPath = yield* Effect.promise(() => makeMockAgentWrapper());
      const adapter = yield* makeTestAdapter(wrapperPath);

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 9).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("kimi"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("kimi"), model: "default" },
      });

      assert.equal(session.provider, "kimi");
      assert.deepStrictEqual(session.resumeCursor, {
        schemaVersion: 1,
        sessionId: "mock-session-1",
      });

      yield* adapter.sendTurn({
        threadId,
        input: "hello mock",
        attachments: [],
      });

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const types = runtimeEvents.map((e) => e.type);

      for (const t of [
        "session.started",
        "session.state.changed",
        "thread.started",
        "turn.started",
        "turn.plan.updated",
        "item.started",
        "content.delta",
        "item.completed",
        "turn.completed",
      ] as const) {
        assert.include(types, t);
      }

      const delta = runtimeEvents.find((e) => e.type === "content.delta");
      assert.isDefined(delta);
      if (delta?.type === "content.delta") {
        assert.equal(delta.payload.delta, "hello from mock");
        assert.match(String(delta.itemId), /^assistant:mock-session-1:runtime:[^:]+:segment:0$/);
      }

      const planUpdate = runtimeEvents.find((event) => event.type === "turn.plan.updated");
      assert.isDefined(planUpdate);
      if (planUpdate?.type === "turn.plan.updated") {
        assert.deepStrictEqual(planUpdate.payload.plan, [
          { step: "Inspect mock ACP state", status: "completed" },
          { step: "Implement the requested change", status: "inProgress" },
        ]);
      }

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("round-trips the resume cursor through session/load and ignores replayed updates", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("kimi-load-replay-filter");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockAgentWrapper({
          T3_ACP_EMIT_LOAD_REPLAY: "1",
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);

      const runtimeEvents: Array<ProviderRuntimeEvent> = [];
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
        }),
      ).pipe(Effect.forkChild);

      const session = yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("kimi"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("kimi"), model: "default" },
        resumeCursor: { schemaVersion: 1, sessionId: "mock-session-1" },
      });

      yield* adapter.sendTurn({
        threadId,
        input: "after resume",
        attachments: [],
      });

      assert.deepStrictEqual(session.resumeCursor, {
        schemaVersion: 1,
        sessionId: "mock-session-1",
      });
      assert.isFalse(
        runtimeEvents.some(
          (event) => event.type === "item.completed" && event.payload.title === "Replay tool",
        ),
      );
      assert.isFalse(
        runtimeEvents.some(
          (event) =>
            event.type === "content.delta" && event.payload.delta === "replayed assistant text",
        ),
      );

      yield* Fiber.interrupt(runtimeEventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect(
    "streams ACP tool calls and approvals on the active turn in approval-required mode",
    () =>
      Effect.gen(function* () {
        const threadId = ThreadId.make("kimi-tool-call-probe");
        const wrapperPath = yield* Effect.promise(() =>
          makeMockAgentWrapper({ T3_ACP_EMIT_TOOL_CALLS: "1" }),
        );
        const adapter = yield* makeTestAdapter(wrapperPath);

        const runtimeEvents: Array<ProviderRuntimeEvent> = [];
        const settledEventTypes = new Set<string>();
        const settledEventsReady = yield* Deferred.make<void>();

        yield* Stream.runForEach(adapter.streamEvents, (event) =>
          Effect.gen(function* () {
            runtimeEvents.push(event);
            if (String(event.threadId) !== String(threadId)) {
              return;
            }
            if (event.type === "request.opened" && event.requestId) {
              yield* adapter.respondToRequest(
                threadId,
                ApprovalRequestId.make(String(event.requestId)),
                "accept",
              );
            }
            if (
              event.type === "turn.completed" ||
              (event.type === "item.completed" && event.payload.itemType === "command_execution") ||
              event.type === "content.delta"
            ) {
              settledEventTypes.add(event.type);
              if (settledEventTypes.size === 3) {
                yield* Deferred.succeed(settledEventsReady, undefined).pipe(Effect.orDie);
              }
            }
          }),
        ).pipe(Effect.forkChild);

        yield* adapter.startSession({
          threadId,
          provider: ProviderDriverKind.make("kimi"),
          cwd: process.cwd(),
          runtimeMode: "approval-required",
          modelSelection: { instanceId: ProviderInstanceId.make("kimi"), model: "default" },
        });

        const turn = yield* adapter.sendTurn({
          threadId,
          input: "run a tool call",
          attachments: [],
        });
        yield* Deferred.await(settledEventsReady);

        const threadEvents = runtimeEvents.filter(
          (event) => String(event.threadId) === String(threadId),
        );
        assert.includeMembers(
          threadEvents.map((event) => event.type),
          [
            "session.started",
            "session.state.changed",
            "thread.started",
            "turn.started",
            "request.opened",
            "request.resolved",
            "item.updated",
            "item.completed",
            "content.delta",
            "turn.completed",
          ],
        );

        const turnEvents = threadEvents.filter(
          (event) => String(event.turnId) === String(turn.turnId),
        );

        const requestOpened = turnEvents.find((event) => event.type === "request.opened");
        assert.isDefined(requestOpened);
        if (requestOpened?.type === "request.opened") {
          assert.equal(String(requestOpened.turnId), String(turn.turnId));
          assert.equal(requestOpened.payload.requestType, "exec_command_approval");
          assert.equal(requestOpened.payload.detail, "cat server/package.json");
        }

        const requestResolved = turnEvents.find((event) => event.type === "request.resolved");
        assert.isDefined(requestResolved);
        if (requestResolved?.type === "request.resolved") {
          assert.equal(String(requestResolved.turnId), String(turn.turnId));
          assert.equal(requestResolved.payload.requestType, "exec_command_approval");
          assert.equal(requestResolved.payload.decision, "accept");
        }

        const toolCompleted = turnEvents.find(
          (event) =>
            event.type === "item.completed" && event.payload.itemType === "command_execution",
        );
        assert.isDefined(toolCompleted);
        if (toolCompleted?.type === "item.completed") {
          assert.equal(toolCompleted.payload.status, "completed");
          assert.equal(toolCompleted.payload.detail, "cat server/package.json");
        }

        yield* adapter.stopSession(threadId);
      }),
  );

  it.effect("cancels pending ACP approvals and marks the turn cancelled when interrupted", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("kimi-cancel-probe");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockAgentWrapper({ T3_ACP_EMIT_TOOL_CALLS: "1" }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);

      const requestResolvedReady = yield* Deferred.make<ProviderRuntimeEvent>();
      const turnCompletedReady = yield* Deferred.make<ProviderRuntimeEvent>();
      let interrupted = false;

      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.gen(function* () {
          if (String(event.threadId) !== String(threadId)) {
            return;
          }
          if (event.type === "request.opened" && event.requestId && !interrupted) {
            interrupted = true;
            yield* adapter.respondToRequest(
              threadId,
              ApprovalRequestId.make(String(event.requestId)),
              "cancel",
            );
            yield* adapter.interruptTurn(threadId);
            return;
          }
          if (event.type === "request.resolved") {
            yield* Deferred.succeed(requestResolvedReady, event).pipe(Effect.ignore);
            return;
          }
          if (event.type === "turn.completed") {
            yield* Deferred.succeed(turnCompletedReady, event).pipe(Effect.ignore);
          }
        }),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("kimi"),
        cwd: process.cwd(),
        runtimeMode: "approval-required",
        modelSelection: { instanceId: ProviderInstanceId.make("kimi"), model: "default" },
      });

      const sendTurnFiber = yield* adapter
        .sendTurn({
          threadId,
          input: "cancel this turn",
          attachments: [],
        })
        .pipe(Effect.forkChild);

      const requestResolved = yield* Deferred.await(requestResolvedReady);
      const turnCompleted = yield* Deferred.await(turnCompletedReady);
      yield* Fiber.join(sendTurnFiber);
      yield* Fiber.interrupt(runtimeEventsFiber);

      assert.equal(requestResolved.type, "request.resolved");
      if (requestResolved.type === "request.resolved") {
        assert.equal(requestResolved.payload.decision, "cancel");
      }

      assert.equal(turnCompleted.type, "turn.completed");
      if (turnCompleted.type === "turn.completed") {
        assert.equal(turnCompleted.payload.state, "cancelled");
        assert.equal(turnCompleted.payload.stopReason, "cancelled");
      }

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("truncates recorded turns on rollbackThread", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("kimi-rollback-thread");
      const wrapperPath = yield* Effect.promise(() => makeMockAgentWrapper());
      const adapter = yield* makeTestAdapter(wrapperPath);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("kimi"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("kimi"), model: "default" },
      });

      yield* adapter.sendTurn({
        threadId,
        input: "first turn",
        attachments: [],
      });
      yield* adapter.sendTurn({
        threadId,
        input: "second turn",
        attachments: [],
      });

      const beforeRollback = yield* adapter.readThread(threadId);
      assert.equal(beforeRollback.turns.length, 2);

      const afterRollback = yield* adapter.rollbackThread(threadId, 1);
      assert.equal(afterRollback.turns.length, 1);

      const invalidRollback = yield* adapter.rollbackThread(threadId, 0).pipe(Effect.result);
      assert.equal(invalidRollback._tag, "Failure");

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("rejects startSession when provider mismatches", () =>
    Effect.gen(function* () {
      const wrapperPath = yield* Effect.promise(() => makeMockAgentWrapper());
      const adapter = yield* makeTestAdapter(wrapperPath);

      const result = yield* adapter
        .startSession({
          threadId: ThreadId.make("kimi-bad-provider"),
          provider: ProviderDriverKind.make("codex"),
          cwd: process.cwd(),
          runtimeMode: "full-access",
        })
        .pipe(Effect.result);

      assert.equal(result._tag, "Failure");
    }),
  );
});
