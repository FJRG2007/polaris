import { performance } from "node:perf_hooks";

/**
 * whether the operator asked for debug output - GitHub's own "re-run with debug
 * logging" (`RUNNER_DEBUG=1`), the `ACTIONS_STEP_DEBUG=true` repo secret, or a
 * local `LOG_LEVEL=debug`. lives here rather than in `log.ts` because this
 * module imports only `node:perf_hooks`, so every other util can depend on it
 * without a cycle. one switch raises every diagnostic we own.
 */
export function isDebugEnabled(): boolean {
  return (
    process.env.ACTIONS_STEP_DEBUG === "true" ||
    process.env.RUNNER_DEBUG === "1" ||
    process.env.LOG_LEVEL === "debug"
  );
}

/**
 * generic `spawn()` idle default for ordinary short-lived subprocesses (prep
 * probes, package-manager invocations, dependency installs). these should be
 * producing output steadily, so a comparatively tight budget catches a wedged
 * command promptly. the long-silent-tool tolerance the agent harnesses need
 * lives in AGENT_ACTIVITY_TIMEOUT_MS, applied explicitly at those sites.
 */
export const DEFAULT_ACTIVITY_TIMEOUT_MS = 300_000;

/**
 * flat idle budget for the agent activity watchdog (the outer process-output
 * monitor, the v1 harness spawns, and the v2 inner event-silence watchdog).
 * sized to exceed the worst-case legitimate silent tool window (issue #760:
 * `checkout_pr` git fetch+deepen on a large monorepo, ~4-5min) with generous
 * headroom, so no single in-flight tool call can be mistaken for a stall. a
 * timeout this generous needs no suspend/resume bracketing - the cost of a
 * genuinely hung run is only GitHub Actions minutes, not tokens.
 */
export const AGENT_ACTIVITY_TIMEOUT_MS = 900_000;

/**
 * Budget for the window before the agent's FIRST streamed event, which the flat
 * budget above cannot justify: no tool has been called yet, so there is no
 * in-flight tool call to protect (#1120).
 *
 * The window it guards is a provider that accepts the request and then never
 * completes the stream. Reproduced against a stalling endpoint: the request goes
 * out (81KB of prompt accepted), and opencode emits neither `part.updated` nor
 * `session.error` - so the run looks alive while doing nothing. A per-request
 * client timeout does NOT help; measured, opencode reacts to one by silently
 * RETRYING (4 requests in 85s against an 8s budget vs 1 with none), so only a
 * total-elapsed bound ends it.
 *
 * Sized off a direct measurement of time-to-first-model-part over 83 successful
 * runs across 60+ repos (2026-07-30 onward): p50 5.6s, p90 8.4s, max 39.0s, and
 * ZERO runs above 60s. 120s is ~3x the observed max and ~14x p90.
 *
 * Note this is NOT the "520s legitimate outlier" figure quoted in #1120 - that
 * measured time to the first LOGGED line (`» thinking` is emitted when the
 * reasoning block *ends*, carrying its own duration), on a runner concurrently
 * busy with `npm ci`. The clock here starts on the first streamed part, which
 * lands much earlier. Upstream's own proposal for this bug used a 30s
 * first-byte budget (anomalyco/opencode#29420), so 120s stays conservative.
 */
export const AGENT_FIRST_EVENT_TIMEOUT_MS = 120_000;
export const DEFAULT_ACTIVITY_CHECK_INTERVAL_MS = 5_000;

/**
 * chunks whose every non-empty line matches one of these patterns do not
 * count as agent activity. mcp-proxy SSE reconnects and provider-error
 * retries happen on their own schedule and were keeping the outer activity
 * timer alive long after the agent subprocess had been killed for inactivity,
 * producing multi-hour zombie runs.
 *
 * both patterns anchor to the start of the (optionally debug-timestamped)
 * log line so they don't accidentally match agent output that happens to
 * mention "[mcp-proxy]" or "provider error detected" in analysis text.
 */
const DEBUG_TS_PREFIX = /^(?:\[\d{4}-\d{2}-\d{2}T[^\]]+\]\s+)?/.source;
// our own internal monitors (this file's bypass + subprocess.ts's spawn
// activity timer) emit high-frequency diagnostic logs when debug logging is
// enabled. in the past those lines reached the wrapped process.stdout.write,
// missed the noise check, and marked activity every interval - which in
// debug-enabled runs kept the outer timer alive after the agent subprocess
// was already dead, re-creating the #12 zombie-run bug. the `(?:spawn|process)
// activity ` patterns below explicitly filter our own diagnostic lines in both
// local-debug (`[DEBUG] …`) and GH-runner-debug (`::debug::…`) formats.
export const ACTIVITY_NOISE_PATTERNS: readonly RegExp[] = [
  new RegExp(`${DEBUG_TS_PREFIX}\\[mcp-proxy\\]`),
  new RegExp(`${DEBUG_TS_PREFIX}» provider error detected`),
  new RegExp(`${DEBUG_TS_PREFIX}\\[DEBUG\\]\\s+(?:spawn|process) activity `),
  /^::debug::(?:spawn|process) activity /,
];

export function isActivityNoise(chunk: string | Uint8Array): boolean {
  const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
  if (!text.trim()) return true;
  return text.split("\n").every((line) => {
    const trimmed = line.trim();
    if (!trimmed) return true;
    return ACTIVITY_NOISE_PATTERNS.some((pattern) => pattern.test(trimmed));
  });
}

type ActivityTimeoutContext = {
  timeoutMs: number;
  checkIntervalMs: number;
};

export type ActivityTimeout = {
  promise: Promise<never>;
  stop: () => void;
  /** force the timeout to reject immediately with a custom reason */
  forceReject: (reason: string) => void;
};

type OutputMonitorContext = {
  timeoutMs: number;
  checkIntervalMs: number;
  onTimeout: (idleMs: number) => void;
};

type OutputMonitor = {
  stop: () => void;
};

type WriteCallback = (error?: Error | null) => void;
type WriteFunction = {
  (chunk: string | Uint8Array, cb?: WriteCallback): boolean;
  (chunk: string | Uint8Array, encoding?: BufferEncoding, cb?: WriteCallback): boolean;
};

// module-level activity tracking - allows agents to mark activity on any event
let _lastActivity = performance.now();

/**
 * mark activity to reset the no-output timeout.
 * call this whenever the agent emits any event, even if it isn't logged to stdout.
 */
export function markActivity(): void {
  _lastActivity = performance.now();
}

/** get the time since last activity in milliseconds. */
export function getIdleMs(): number {
  return Math.round(performance.now() - _lastActivity);
}

function wrapWrite(original: WriteFunction, onActivity: () => void): WriteFunction {
  const wrapped: WriteFunction = (
    chunk: string | Uint8Array,
    encodingOrCb?: BufferEncoding | WriteCallback,
    cb?: WriteCallback
  ): boolean => {
    if (!isActivityNoise(chunk)) {
      onActivity();
    }
    if (typeof encodingOrCb === "function") {
      return original(chunk, encodingOrCb);
    }
    return original(chunk, encodingOrCb, cb);
  };
  return wrapped;
}

function startProcessOutputMonitor(ctx: OutputMonitorContext): OutputMonitor {
  let timedOut = false;

  const originalStdoutWrite: WriteFunction = process.stdout.write.bind(process.stdout);
  const originalStderrWrite: WriteFunction = process.stderr.write.bind(process.stderr);

  // stdout/stderr writes also mark activity
  process.stdout.write = wrapWrite(originalStdoutWrite, markActivity);
  process.stderr.write = wrapWrite(originalStderrWrite, markActivity);

  // route the monitor's own diagnostics through the captured original write
  // instead of log.debug - otherwise those lines feed back through the
  // wrapped process.stdout.write, miss isActivityNoise, and call
  // markActivity() themselves. in debug mode the periodic check below would
  // then reset the timer every interval and the timeout would never fire,
  // re-creating the exact zombie-run bug #12 was meant to kill.
  const debugBypass = (msg: string): void => {
    if (!isDebugEnabled()) return;
    originalStdoutWrite(`[${new Date().toISOString()}] [DEBUG] ${msg}\n`);
  };

  debugBypass(`process activity monitor started: timeout=${ctx.timeoutMs}ms`);

  const intervalId = setInterval(() => {
    const idleMs = getIdleMs();
    debugBypass(`process activity check: idle=${idleMs}ms / ${ctx.timeoutMs}ms`);
    if (timedOut || idleMs <= ctx.timeoutMs) return;
    timedOut = true;
    ctx.onTimeout(idleMs);
  }, ctx.checkIntervalMs);

  function stop(): void {
    clearInterval(intervalId);
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
  }

  return { stop };
}

export function createProcessOutputActivityTimeout(ctx: ActivityTimeoutContext): ActivityTimeout {
  markActivity(); // reset baseline

  let rejectFn: ((error: Error) => void) | null = null;
  const promise = new Promise<never>((_, reject) => {
    rejectFn = reject;
  });

  let monitor: OutputMonitor | null = null;
  monitor = startProcessOutputMonitor({
    timeoutMs: ctx.timeoutMs,
    checkIntervalMs: ctx.checkIntervalMs,
    onTimeout: (idleMs) => {
      if (!rejectFn) return;
      const idleSec = Math.round(idleMs / 1000);
      if (monitor) {
        monitor.stop();
      }
      const reject = rejectFn;
      rejectFn = null;
      reject(new Error(`activity timeout: no output for ${idleSec}s`));
    },
  });

  return {
    promise,
    // stop() also disarms forceReject so a late safety-net fire can't reject
    // the promise after the run has already succeeded.
    stop: () => {
      monitor?.stop();
      rejectFn = null;
    },
    forceReject: (reason: string) => {
      if (!rejectFn) return;
      monitor?.stop();
      const reject = rejectFn;
      rejectFn = null;
      reject(new Error(reason));
    },
  };
}
