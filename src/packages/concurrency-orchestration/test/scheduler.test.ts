import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DeterministicScheduler } from "../src/index.js";
import { asId } from "@deepseek/platform-contracts";

describe("deterministic scheduler", () => {
  it("serializes work through explicit locks", async () => {
    const scheduler = new DeterministicScheduler();
    const order: string[] = [];
    await Promise.all([
      scheduler.withLock({ kind: "workspace", key: "root" }, async () => {
        order.push("a");
      }),
      scheduler.withLock({ kind: "workspace", key: "root" }, async () => {
        order.push("b");
      })
    ]);
    await scheduler.run({ id: asId<"task">("task-1"), name: "work" }, async () => "done");
    assert.deepEqual(order, ["a", "b"]);
    assert.deepEqual(
      scheduler.events().map((event) => event.status),
      ["queued", "running", "completed"]
    );
  });

  it("serializes overlapping workspace path locks without blocking sibling files", async () => {
    const scheduler = new DeterministicScheduler();
    let active = 0;
    let maxActive = 0;
    const runWithLock = (key: string) => scheduler.withLock({ kind: "workspace", key }, async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
    });

    await Promise.all([
      runWithLock("src"),
      runWithLock("src/index.ts")
    ]);
    assert.equal(maxActive, 1);

    active = 0;
    maxActive = 0;
    await Promise.all([
      runWithLock("src/a.ts"),
      runWithLock("src/b.ts")
    ]);
    assert.equal(maxActive, 2);
  });

  it("serializes process cwd locks against overlapping workspace writes", async () => {
    const scheduler = new DeterministicScheduler();
    let active = 0;
    let maxActive = 0;
    const runWithLock = (kind: "process-slot" | "workspace", key: string) => scheduler.withLock({ kind, key }, async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
    });

    await Promise.all([
      runWithLock("process-slot", "."),
      runWithLock("workspace", "src/index.ts")
    ]);
    assert.equal(maxActive, 1);

    active = 0;
    maxActive = 0;
    await Promise.all([
      runWithLock("process-slot", "src"),
      runWithLock("workspace", "src")
    ]);
    assert.equal(maxActive, 1);

    active = 0;
    maxActive = 0;
    await Promise.all([
      runWithLock("process-slot", "packages/a"),
      runWithLock("workspace", "packages/b/index.ts")
    ]);
    assert.equal(maxActive, 2);
  });

  it("keeps non-path lock keys literal instead of path-normalizing them", async () => {
    const scheduler = new DeterministicScheduler();
    let active = 0;
    let maxActive = 0;
    const runWithLock = (key: string) => scheduler.withLock({ kind: "session", key }, async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
    });

    await Promise.all([
      runWithLock("tenant-a/../session-1"),
      runWithLock("session-1")
    ]);
    assert.equal(maxActive, 2);
  });

  it("queues work beyond the concurrency limit", async () => {
    const scheduler = new DeterministicScheduler({ maxConcurrency: 1 });
    let releaseFirst!: () => void;
    const first = scheduler.run({ id: asId<"task">("task-first"), name: "first" }, async () => {
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      return "first";
    });
    const second = scheduler.run({ id: asId<"task">("task-second"), name: "second" }, async () => "second");

    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(
      scheduler.events().map((event) => `${event.taskId}:${event.status}`),
      ["task-first:queued", "task-second:queued", "task-first:running"]
    );
    releaseFirst();
    assert.deepEqual(await Promise.all([first, second]), ["first", "second"]);
    assert.equal(scheduler.events().some((event) => event.taskId === "task-second" && event.status === "running"), true);
  });

  it("emits terminal events for deadlines and cancellation", async () => {
    const scheduler = new DeterministicScheduler();
    await assert.rejects(() => scheduler.run({ id: asId<"task">("task-timeout"), name: "timeout", deadlineMs: 0 }, async () => "nope"));
    await scheduler.cancel(asId<"task">("task-cancelled"), "user");
    await assert.rejects(() => scheduler.run({ id: asId<"task">("task-cancelled"), name: "cancelled" }, async () => "nope"));
    assert.ok(scheduler.events().some((event) => event.status === "timed-out"));
    assert.ok(scheduler.events().some((event) => event.status === "cancelled"));
  });

  it("cancels queued work without invoking its executor", async () => {
    const scheduler = new DeterministicScheduler({ maxConcurrency: 1 });
    let releaseFirst!: () => void;
    const first = scheduler.run({ id: asId<"task">("task-first"), name: "first" }, async () => {
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      return "first";
    });
    let called = false;
    const second = scheduler.run({ id: asId<"task">("task-second"), name: "second" }, async () => {
      called = true;
      return "second";
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    await scheduler.cancel(asId<"task">("task-second"), "user");
    releaseFirst();
    assert.equal(await first, "first");
    await assert.rejects(second, /Task cancelled: user/);
    assert.equal(called, false);
    assert.deepEqual(
      scheduler.events()
        .filter((event) => event.taskId === "task-second")
        .map((event) => event.status),
      ["queued", "cancelled"]
    );
  });

  it("aborts running work through AbortSignal on timeout without completing it", async () => {
    const scheduler = new DeterministicScheduler();
    let observedAbort = false;
    await assert.rejects(
      () => scheduler.run({ id: asId<"task">("task-timeout-running"), name: "timeout", deadlineMs: 1 }, async ({ signal }) => {
        await new Promise<void>((resolve) => {
          signal.addEventListener(
            "abort",
            () => {
              observedAbort = true;
              resolve();
            },
            { once: true }
          );
        });
        await new Promise((resolve) => setTimeout(resolve, 5));
      }),
      /Task cancelled: timeout/
    );

    assert.equal(observedAbort, true);
    assert.deepEqual(
      scheduler.events()
        .filter((event) => event.taskId === "task-timeout-running")
        .map((event) => event.status),
      ["queued", "running", "timed-out"]
    );
    assert.equal(scheduler.events().some((event) => event.taskId === "task-timeout-running" && event.status === "completed"), false);
  });

  it("fails queued submissions with typed backpressure instead of unbounded growth", async () => {
    const scheduler = new DeterministicScheduler({ maxConcurrency: 1, maxQueueSize: 1 });
    let releaseFirst!: () => void;
    const first = scheduler.run({ id: asId<"task">("task-first"), name: "first" }, async () => {
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
    });
    const second = scheduler.run({ id: asId<"task">("task-second"), name: "second" }, async () => undefined);
    await new Promise((resolve) => setTimeout(resolve, 0));

    await assert.rejects(
      () => scheduler.run({ id: asId<"task">("task-third"), name: "third" }, async () => undefined),
      (error) => error instanceof Error && error.name === "SCHEDULER_QUEUE_BACKPRESSURE"
    );

    releaseFirst();
    await first;
    await second;
    assert.deepEqual(
      scheduler.events()
        .filter((event) => event.taskId === "task-third")
        .map((event) => event.status),
      ["queued", "failed"]
    );
  });
});
