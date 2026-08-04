import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createProcessOutputActivityTimeout, isActivityNoise } from "./activity.ts";

describe("isActivityNoise", () => {
  it("flags empty and whitespace-only chunks as noise", () => {
    expect(isActivityNoise("")).toBe(true);
    expect(isActivityNoise("   \n\t\n")).toBe(true);
  });

  it("flags pure mcp-proxy reconnect chatter as noise", () => {
    expect(
      isActivityNoise("[mcp-proxy] establishing new SSE stream for session ID abc-123\n")
    ).toBe(true);
    expect(
      isActivityNoise(
        "[mcp-proxy] establishing new SSE stream for session ID a\n[mcp-proxy] received delete request\n"
      )
    ).toBe(true);
  });

  it("flags provider-error retry lines as noise", () => {
    expect(isActivityNoise("» provider error detected (rate_limit): ...\n")).toBe(true);
  });

  it("treats real agent output as activity", () => {
    expect(isActivityNoise('{"type":"tool_use","id":"toolu_01"}\n')).toBe(false);
    expect(isActivityNoise("Working on it...\n")).toBe(false);
  });

  it("treats mixed chunks (some noise + some real output) as activity", () => {
    const mixed =
      "[mcp-proxy] establishing new SSE stream for session ID abc\n" +
      '{"type":"assistant_message"}\n';
    expect(isActivityNoise(mixed)).toBe(false);
  });

  it("accepts Buffer input", () => {
    expect(isActivityNoise(Buffer.from("[mcp-proxy] received delete request\n"))).toBe(true);
    expect(isActivityNoise(Buffer.from('{"type":"tool_use"}\n'))).toBe(false);
  });

  it("flags chunks with only noise + blank lines as noise", () => {
    const noiseWithBlanks =
      "\n[mcp-proxy] establishing new SSE stream for session ID abc\n\n" +
      "[mcp-proxy] received delete request\n\n";
    expect(isActivityNoise(noiseWithBlanks)).toBe(true);
  });

  it("does not match the noise pattern mid-line", () => {
    // `[mcp-proxy]` must anchor at start; embedded in agent output it's activity
    expect(isActivityNoise("agent said: [mcp-proxy] was there\n")).toBe(false);
    expect(isActivityNoise("context: provider error detected in log\n")).toBe(false);
  });

  it("flags debug-timestamp-prefixed noise lines", () => {
    expect(
      isActivityNoise("[2026-04-18T17:00:00.000Z] [mcp-proxy] establishing new SSE stream\n")
    ).toBe(true);
    expect(
      isActivityNoise("[2026-04-18T17:00:00.000Z] » provider error detected (rate_limit)\n")
    ).toBe(true);
  });

  it("flags our own monitor debug output (local-debug format)", () => {
    // subprocess.ts's spawn activity check fires every 5s when debug is on;
    // without this filter the outer timer would be reset each interval and
    // the agent-hang detection (#12) silently fails in debug-enabled runs.
    expect(
      isActivityNoise(
        "[2026-04-18T17:00:00.000Z] [DEBUG] spawn activity check: pid=123 idle=5000ms / 300000ms\n"
      )
    ).toBe(true);
    expect(
      isActivityNoise(
        "[2026-04-18T17:00:00.000Z] [DEBUG] spawn activity timer: pid=123 cmd=claude timeout=300000ms\n"
      )
    ).toBe(true);
    expect(
      isActivityNoise(
        "[2026-04-18T17:00:00.000Z] [DEBUG] process activity check: idle=120ms / 300000ms\n"
      )
    ).toBe(true);
  });

  it("flags our own monitor debug output (GH-runner-debug ::debug:: format)", () => {
    expect(isActivityNoise("::debug::spawn activity check: pid=123 idle=5000ms / 300000ms\n")).toBe(
      true
    );
    expect(isActivityNoise("::debug::process activity check: idle=120ms / 300000ms\n")).toBe(true);
  });

  it("does not blanket-filter other debug-prefixed lines", () => {
    // the filter is scoped to our own monitor diagnostics so genuine agent
    // output that coincidentally starts with [DEBUG] still counts as activity.
    expect(isActivityNoise("[2026-04-18T17:00:00.000Z] [DEBUG] git auth server listening\n")).toBe(
      false
    );
    expect(isActivityNoise("::debug::agent stream chunk\n")).toBe(false);
  });
});

describe("createProcessOutputActivityTimeout (debug-mode feedback loop)", () => {
  // the monitor's own periodic diagnostic log used to travel through the
  // wrapped process.stdout.write - in debug mode that meant the interval
  // callback kept resetting the activity timer, so the timeout could never
  // fire. guard against that regression by running the monitor under a
  // simulated debug env with a tight timeout and confirming it still rejects.
  const previousStepDebug = process.env.ACTIONS_STEP_DEBUG;

  beforeEach(() => {
    process.env.ACTIONS_STEP_DEBUG = "true";
  });

  afterEach(() => {
    if (previousStepDebug === undefined) delete process.env.ACTIONS_STEP_DEBUG;
    else process.env.ACTIONS_STEP_DEBUG = previousStepDebug;
  });

  it("still times out in debug mode even though the monitor emits periodic diagnostics", async () => {
    const timeout = createProcessOutputActivityTimeout({
      timeoutMs: 150,
      checkIntervalMs: 20,
    });
    try {
      await expect(timeout.promise).rejects.toThrow(/activity timeout/);
    } finally {
      timeout.stop();
    }
  });
});

describe("createProcessOutputActivityTimeout forceReject / stop disarming", () => {
  // main.ts arms a 5min safety-net timer on inner-activity kill that later
  // calls forceReject. when the agent succeeds first, main.ts calls stop().
  // stop() must disarm forceReject - otherwise a late safety-net fire would
  // reject a promise nothing is awaiting, re-creating the #12 zombie-run
  // shape (unhandledRejection) or worse, failing a successful run.
  it("forceReject rejects the promise with the given reason", async () => {
    const timeout = createProcessOutputActivityTimeout({
      timeoutMs: 60_000,
      checkIntervalMs: 10_000,
    });
    try {
      timeout.forceReject("safety-net fired");
      await expect(timeout.promise).rejects.toThrow(/safety-net fired/);
    } finally {
      timeout.stop();
    }
  });

  it("stop() disarms forceReject so a late safety-net fire is a no-op", async () => {
    const timeout = createProcessOutputActivityTimeout({
      timeoutMs: 60_000,
      checkIntervalMs: 10_000,
    });
    // prevent unhandled-rejection noise if the assertion below ever regresses
    timeout.promise.catch(() => {});

    timeout.stop();
    timeout.forceReject("late safety-net fire after run succeeded");

    // race the promise against a short sleep; if forceReject reopened the
    // rejection it would win the race. the sleep should always win.
    const sentinel = Symbol("still-pending");
    const winner = await Promise.race([
      timeout.promise.then(
        () => "resolved",
        () => "rejected"
      ),
      new Promise((resolve) => setTimeout(() => resolve(sentinel), 50)),
    ]);
    expect(winner).toBe(sentinel);
  });

  it("forceReject is a no-op if the promise already rejected via the timer", async () => {
    const timeout = createProcessOutputActivityTimeout({
      timeoutMs: 60,
      checkIntervalMs: 10,
    });
    try {
      await expect(timeout.promise).rejects.toThrow(/activity timeout/);
      // forceReject after timer rejection must not throw or double-reject
      expect(() => timeout.forceReject("should be ignored")).not.toThrow();
    } finally {
      timeout.stop();
    }
  });
});
