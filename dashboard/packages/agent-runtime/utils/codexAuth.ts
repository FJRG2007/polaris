import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CodexAuthBody, refreshCodexAuthBody, stringifyCodexAuthBody } from "./codexOAuth.ts";

/**
 * minted Codex subscription credential. raw `auth.json` body that Codex CLI /
 * OpenCode plugins consume. validated to be `auth_mode: "chatgpt"` with a
 * refresh token before being returned. caller is responsible for storing it
 * (typically as the `CODEX_AUTH_JSON` Polaris secret).
 */
export interface CodexAuth {
  /** raw JSON body of the minted `auth.json`; safe to persist verbatim. */
  json: string;
  /** parsed for caller convenience; mirrors the shape Codex CLI writes. */
  parsed: CodexAuthJson;
}

export type CodexAuthJson = CodexAuthBody;

/** force one refresh round-trip against the OAuth provider so the saved
 * credential carries the freshest refresh token. used right after `codex
 * login --device-auth` and again any time we want to bump the chain before
 * persisting (avoids the user's laptop refreshing first and burning ours).
 * Server-side rotation at run-context uses `refreshCodexAuthBody` directly. */
export async function refreshCodexAuth(auth: CodexAuth): Promise<CodexAuth> {
  const refreshed = await refreshCodexAuthBody(auth.parsed);
  return { json: stringifyCodexAuthBody(refreshed), parsed: refreshed };
}

export type ProgressEvent =
  | { kind: "start"; attempt: number }
  | { kind: "exit"; exitCode: number; signal: NodeJS.Signals | null; timedOut: boolean }
  | { kind: "retry"; reason: "user-request" | "no-auth-written" }
  | { kind: "cancel" };

interface RunOptions {
  /** abort the whole flow when true is returned. polled before each retry. */
  shouldRetry: () => Promise<boolean>;
  /** observe progress for UI rendering. */
  onProgress?: (event: ProgressEvent) => void;
  /**
   * pass-through control over the child's stdio. `inherit` streams Codex's
   * own UI directly to the user's terminal. `pipe` is what `polaris auth
   * codex` uses so it can re-render each line with a Polaris-styled rail
   * + dim formatting via `onChildLine`.
   */
  childStdio?: "inherit" | "pipe";
  /**
   * called once per line of Codex's stdout/stderr when `childStdio` is
   * "pipe". raw line text is passed through unmodified (including any ANSI
   * escapes Codex emitted); the caller is responsible for stripping/styling.
   */
  onChildLine?: (line: string, stream: "stdout" | "stderr") => void;
  /** how long a single device-auth attempt is allowed to run. */
  perAttemptTimeoutMs?: number;
}

/**
 * mint a fresh Codex subscription credential by running `codex login
 * --device-auth` against an isolated `CODEX_HOME`. the user's global
 * `~/.codex/auth.json` is never touched; on success or failure, the
 * temporary home is cleaned up.
 *
 * the caller controls retry behavior via `shouldRetry`: when device auth
 * exits without writing `auth.json` (most commonly because the user needed
 * to enable device-code auth on their ChatGPT account first), the function
 * invokes `shouldRetry()` to decide whether to spin up another attempt.
 */
export async function mintCodexAuth(options: RunOptions): Promise<CodexAuth> {
  // mkdtempSync already creates the dir with the default 0o700 perms on
  // posix; an extra mkdirSync would just be ceremony.
  const codexHome = mkdtempSync(join(tmpdir(), "polaris-codex-"));
  try {
    // device auth requires file-backed credentials; otherwise Codex routes the
    // refresh token into the OS keyring and we can't observe / persist it.
    writeFileSync(join(codexHome, "config.toml"), 'cli_auth_credentials_store = "file"\n', {
      mode: 0o600,
    });

    const authPath = join(codexHome, "auth.json");
    let attempt = 1;

    while (true) {
      options.onProgress?.({ kind: "start", attempt });
      const result = await runDeviceAuth({
        codexHome,
        timeoutMs: options.perAttemptTimeoutMs ?? 15 * 60 * 1000,
        childStdio: options.childStdio ?? "inherit",
        onChildLine: options.onChildLine,
      });
      options.onProgress?.({
        kind: "exit",
        exitCode: result.exitCode,
        signal: result.signal,
        timedOut: result.timedOut,
      });

      const auth = readAuthIfPresent(authPath);
      if (auth) return auth;

      if (!(await options.shouldRetry())) {
        options.onProgress?.({ kind: "cancel" });
        throw new Error("Codex login did not produce auth.json (no retry requested)");
      }
      options.onProgress?.({ kind: "retry", reason: "no-auth-written" });
      attempt += 1;
    }
  } finally {
    rmSync(codexHome, { recursive: true, force: true });
  }
}

interface DeviceAuthResult {
  exitCode: number;
  signal: NodeJS.Signals | null;
  /** true if the attempt was killed by our per-attempt timeout (vs. exited
   * naturally or was interrupted by the user). lets callers distinguish
   * "user walked away" from "user closed the device flow early". */
  timedOut: boolean;
}

interface DeviceAuthInput {
  codexHome: string;
  timeoutMs: number;
  childStdio: "inherit" | "pipe";
  onChildLine?: ((line: string, stream: "stdout" | "stderr") => void) | undefined;
}

/** how long to wait between SIGTERM and SIGKILL when killing a stuck `codex`
 * subprocess. Codex usually exits cleanly on SIGTERM, but if it ignores it we
 * don't want the CLI pinned forever. */
const SIGTERM_GRACE_MS = 5_000;

/** spawn `codex login --device-auth` with stdin closed so Codex doesn't hang
 * waiting for input. by default inherits stdout/stderr so the user sees the
 * device URL + one-time code Codex prints; when `pipe`d, lines are forwarded
 * to `onChildLine` so the caller can re-style them. on per-attempt timeout,
 * sends SIGTERM and escalates to SIGKILL after a short grace.
 */
function runDeviceAuth(input: DeviceAuthInput): Promise<DeviceAuthResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("codex", ["login", "--device-auth"], {
      env: { ...process.env, CODEX_HOME: input.codexHome },
      stdio: ["ignore", input.childStdio, input.childStdio],
    });

    if (input.childStdio === "pipe") {
      const onLine = input.onChildLine ?? (() => {});
      if (child.stdout) pipeLines(child.stdout, (line) => onLine(line, "stdout"));
      if (child.stderr) pipeLines(child.stderr, (line) => onLine(line, "stderr"));
    }

    let killTimer: NodeJS.Timeout | null = null;
    let timedOut = false;
    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      // give Codex a grace window to exit cleanly on SIGTERM. if it ignores
      // it, force SIGKILL so we don't pin the CLI on a stuck child.
      killTimer = setTimeout(() => child.kill("SIGKILL"), SIGTERM_GRACE_MS);
    }, input.timeoutMs);

    // `spawn` emits 'error' (not 'close') when the binary can't be found
    // (ENOENT) or otherwise fails to start. without a listener, Node crashes
    // the process with an unhandled 'error' event.
    child.on("error", (err) => {
      clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      const errno = err as NodeJS.ErrnoException;
      const message =
        errno.code === "ENOENT"
          ? "codex CLI not found on PATH. install it with `npm i -g @openai/codex` or see https://developers.openai.com/codex/cli for other install options."
          : `failed to spawn codex: ${errno.message}`;
      reject(new Error(message));
    });

    child.on("close", (code, signal) => {
      clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      resolve({ exitCode: code ?? 1, signal, timedOut });
    });
  });
}

/** byte-stream → newline-delimited line callback. emits any final partial
 * line on stream end so trailing content (e.g. a prompt with no newline)
 * still surfaces to the renderer.
 */
function pipeLines(stream: NodeJS.ReadableStream, onLine: (line: string) => void): void {
  let buffer = "";
  stream.on("data", (chunk: Buffer | string) => {
    buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    let idx = buffer.indexOf("\n");
    while (idx !== -1) {
      const line = buffer.slice(0, idx).replace(/\r$/, "");
      buffer = buffer.slice(idx + 1);
      onLine(line);
      idx = buffer.indexOf("\n");
    }
  });
  stream.on("end", () => {
    if (buffer.length > 0) {
      onLine(buffer);
      buffer = "";
    }
  });
}

function readAuthIfPresent(authPath: string): CodexAuth | null {
  let raw: string;
  try {
    raw = readFileSync(authPath, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isCodexAuthJson(parsed)) return null;
  return { json: raw, parsed };
}

function isCodexAuthJson(value: unknown): value is CodexAuthJson {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (v.auth_mode !== "chatgpt") return false;
  const tokens = v.tokens;
  if (!tokens || typeof tokens !== "object") return false;
  const t = tokens as Record<string, unknown>;
  if (typeof t.access_token !== "string" || t.access_token.length === 0) return false;
  if (typeof t.refresh_token !== "string" || t.refresh_token.length === 0) return false;
  return true;
}
