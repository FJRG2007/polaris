/**
 * The wire protocol between Polaris and a runner on somebody's own computer.
 *
 * A runner is the small daemon that lets Polar Code drive the Claude Code,
 * Codex or opencode installed on the operator's PC from a phone or the web. It
 * dials out to Polaris over one WebSocket and never listens on a port, the
 * shape Claude Code Remote Control, Omnara's `omnarad` and Happy's relay
 * converged on. Everything both ends say to each other is a JSON text frame
 * described here, validated on arrival by these schemas, so the daemon and the
 * server agree on one definition. `docs/runner-protocol.md` is the prose
 * version of this file.
 *
 * Every frame carries `v` (the protocol version it was written for) and `type`.
 * A frame that does not parse is answered with an `error` and otherwise
 * ignored; a frame larger than `RUNNER_LIMITS.frameBytes` closes the
 * connection, since it was never going to be read.
 */

import { z } from "zod";
import { AGENT_SESSION_EVENTS } from "./agent-sessions.js";
import { AGENT_EFFORT_LEVELS, SESSION_PERMISSION_MODES } from "./agent-clis.js";

/** The protocol version this build speaks. A runner announces the range it
 *  speaks in `hello`; the server refuses one that does not include this. */
export const RUNNER_PROTOCOL_VERSION = 1;

/** The path the runner dials, under the prefix the edge already forwards to the
 *  WebSocket sidecar (`/api/deploy/ws`, router priority 100), so an existing
 *  install needs no new route. */
export const RUNNER_SOCKET_PATH = "/api/deploy/ws/runner";

/** Every size and rate the relay enforces, in one place the runner can read. */
export const RUNNER_LIMITS = {
    /** Largest frame either side may send, in bytes. */
    frameBytes: 1024 * 1024,
    /** Largest prompt, in characters. */
    promptChars: 100_000,
    /** Largest raw hook payload, in bytes once serialised. Same as the HTTP
     *  hook route's body limit. */
    hookBytes: 256 * 1024,
    /** Largest terminal chunk, in bytes before base64. */
    terminalChunkBytes: 64 * 1024,
    /** How often the runner sends `heartbeat`, in milliseconds. */
    heartbeatMs: 20_000,
    /** Silence after which the server drops the connection. */
    heartbeatTimeoutMs: 60_000,
    /** How long the runner has to send `hello` after the socket opens. */
    helloTimeoutMs: 10_000,
    /** Frames per second a runner may send, averaged over `burst`. */
    framesPerSecond: 200,
    /** How many frames may arrive at once before the rate applies. */
    burst: 400,
    /** Bytes the server will hold unsent for one runner before it stops
     *  forwarding terminal output to it (back-pressure). */
    bufferedBytes: 4 * 1024 * 1024,
    /** Sessions one runner may hold. */
    sessions: 32
} as const;

/** Why the server closed the socket. 4000-4999 is the application range. */
export const RUNNER_CLOSE = {
    /** The credential is missing, wrong, or was revoked. Do not retry with it. */
    unauthorized: 4001,
    /** The runner's protocol range does not include the server's version, or it
     *  never said `hello`. Update the runner. */
    protocol: 4002,
    /** A newer connection of the same runner replaced this one. Do not
     *  reconnect from this process. */
    replaced: 4003,
    /** Nothing was heard for `heartbeatTimeoutMs`. Reconnect. */
    heartbeat: 4004,
    /** The runner was removed from the person's account. Forget the credential. */
    revoked: 4005,
    /** Too many frames. Reconnect after a pause. */
    rateLimited: 4008,
    /** A frame larger than `frameBytes`. */
    tooLarge: 4009
} as const;

const id = z.string().uuid();
const shortText = (max: number) => z.string().max(max);
/** A base64 chunk no larger than the terminal limit once decoded. */
const base64Chunk = z
    .string()
    .max(Math.ceil(RUNNER_LIMITS.terminalChunkBytes / 3) * 4)
    .regex(/^[A-Za-z0-9+/]*={0,2}$/);
const dimension = z.number().int().min(1).max(1000);
/** An agent CLI id, as `agent-clis.ts` names them. Kept loose (a slug) so a
 *  runner reporting a tool this server does not know yet still parses. */
const cliId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/);

const frame = <T extends string, S extends z.ZodRawShape>(type: T, shape: S) =>
    z.object({ v: z.number().int().min(1).max(1000), type: z.literal(type), ...shape });

// ---------------------------------------------------------------------------
// Runner -> server
// ---------------------------------------------------------------------------

export const runnerHelloSchema = frame("hello", {
    /** The runner's own release, shown on the computers screen. */
    runnerVersion: shortText(40).regex(/^[0-9A-Za-z.+-]+$/),
    /** The protocol versions this runner speaks, inclusive. */
    protocol: z
        .object({ min: z.number().int().min(1), max: z.number().int().min(1) })
        .refine((range) => range.min <= range.max, { path: ["max"] })
});

export const RUNNER_PLATFORMS = ["win32", "darwin", "linux", "freebsd", "openbsd"] as const;
export const RUNNER_SIGNED_IN = ["yes", "no", "unknown"] as const;

export const runnerCapabilitiesSchema = frame("capabilities", {
    os: z.object({
        platform: z.enum(RUNNER_PLATFORMS),
        release: shortText(80),
        arch: shortText(20)
    }),
    /** The machine's name, offered as the default name on the screen. */
    hostname: shortText(120),
    shells: z
        .array(
            z.object({
                /** `pwsh`, `powershell`, `bash`, `zsh`, `sh`, `cmd`, `wsl`... */
                id: shortText(20),
                path: shortText(400),
                version: shortText(40).optional()
            })
        )
        .max(20),
    clis: z
        .array(
            z.object({
                id: cliId,
                version: shortText(60),
                path: shortText(400).optional(),
                /** Whether the tool is signed in on this machine. `unknown` is
                 *  a tool the runner cannot ask, and is never an error. */
                signedIn: z.enum(RUNNER_SIGNED_IN)
            })
        )
        .max(40),
    /** How many sessions this runner will hold at once. */
    maxSessions: z.number().int().min(0).max(RUNNER_LIMITS.sessions)
});

export const runnerHeartbeatSchema = frame("heartbeat", {
    /** Sessions the runner is holding right now, so a session the server thinks
     *  is running and the runner lost is noticed. */
    sessions: z.array(id).max(RUNNER_LIMITS.sessions)
});

export const runnerSessionStartedSchema = frame("session.started", {
    sessionId: id,
    /** Where the agent runs, on the runner's machine. Shown, never used to
     *  build a command. */
    workdir: shortText(1000),
    branch: shortText(250).optional()
});

export const RUNNER_END_REASONS = ["exited", "stopped", "failed"] as const;

export const runnerSessionEndedSchema = frame("session.ended", {
    sessionId: id,
    reason: z.enum(RUNNER_END_REASONS),
    exitCode: z.number().int().optional(),
    /** One sentence for the session screen. */
    detail: shortText(500).optional()
});

/** A vendor hook payload, exactly as the CLI handed it to its hook, relayed
 *  instead of posted over HTTP. The server normalises it the same way the
 *  session's HTTP hook route does (`session-hooks.ts`). */
export const runnerHookSchema = frame("hook", {
    sessionId: id,
    /** The hook's sequence number, decimal, so a late duplicate is dropped. */
    seq: z.string().regex(/^\d{1,19}$/).optional(),
    payload: z.record(z.unknown())
});

/** An event the runner observed itself, for a CLI without hooks: already in
 *  the normalised vocabulary of `agent-sessions.ts`. */
export const runnerEventSchema = frame("event", {
    sessionId: id,
    kind: z.enum(AGENT_SESSION_EVENTS),
    detail: shortText(500)
});

/** A permission or question hook waiting on a person. Answered with
 *  `permission.decision` carrying the same `requestId`. */
export const runnerPermissionRequestSchema = frame("permission.request", {
    requestId: id,
    sessionId: id,
    payload: z.record(z.unknown())
});

export const runnerTerminalOutputSchema = frame("terminal.output", {
    sessionId: id,
    /** Increases by one per chunk per session, so a gap is visible. */
    seq: z.number().int().min(0),
    data: base64Chunk
});

export const runnerErrorSchema = frame("error", {
    code: shortText(60),
    message: shortText(500),
    sessionId: id.optional()
});

export const runnerMessageSchema = z.discriminatedUnion("type", [
    runnerHelloSchema,
    runnerCapabilitiesSchema,
    runnerHeartbeatSchema,
    runnerSessionStartedSchema,
    runnerSessionEndedSchema,
    runnerHookSchema,
    runnerEventSchema,
    runnerPermissionRequestSchema,
    runnerTerminalOutputSchema,
    runnerErrorSchema
]);
export type RunnerMessage = z.infer<typeof runnerMessageSchema>;
export type RunnerCapabilities = z.infer<typeof runnerCapabilitiesSchema>;

// ---------------------------------------------------------------------------
// Server -> runner
// ---------------------------------------------------------------------------

export const serverWelcomeSchema = frame("welcome", {
    runnerId: id,
    protocol: z.number().int().min(1),
    limits: z.object({
        frameBytes: z.number().int(),
        promptChars: z.number().int(),
        heartbeatMs: z.number().int(),
        heartbeatTimeoutMs: z.number().int()
    })
});

export const serverHeartbeatAckSchema = frame("heartbeat.ack", {});

/** Where the session's work comes from. */
export const runnerRepositorySchema = z.discriminatedUnion("kind", [
    /** Clone (or reuse a checkout of) this repository. The runner uses the
     *  machine's own git credentials; none are sent. */
    z.object({
        kind: z.literal("clone"),
        url: z.string().url().max(500).refine((url) => url.startsWith("https://"), {
            message: "Only https clone URLs"
        }),
        /** `owner/name`, for finding an existing checkout. */
        fullName: shortText(200)
    }),
    /** An existing directory on the runner's machine. */
    z.object({ kind: z.literal("path"), path: shortText(1000) }),
    /** A workspace with nothing checked out. */
    z.object({ kind: z.literal("none") })
]);

export const serverSessionStartSchema = frame("session.start", {
    sessionId: id,
    cli: cliId,
    /** The custom command, for the custom CLI only. */
    command: shortText(500).nullable(),
    model: shortText(200).nullable(),
    effort: z.enum(AGENT_EFFORT_LEVELS).nullable(),
    permissionMode: z.enum(SESSION_PERMISSION_MODES).nullable(),
    repository: runnerRepositorySchema,
    /** The branch the session works on, and what it starts from. */
    branch: shortText(250),
    baseRef: shortText(250),
    /** Whether to work in a git worktree of its own (always for a clone). */
    worktree: z.boolean(),
    /** The first prompt, when the session was started with one. */
    prompt: shortText(RUNNER_LIMITS.promptChars).nullable(),
    /** Where the CLI's hooks report and with what. The same reporting token a
     *  container session's hook script uses; it authenticates this one session
     *  and dies with it. The runner may post hooks here over HTTPS or relay them
     *  as `hook` frames. */
    report: z.object({
        url: z.string().url().max(500),
        token: shortText(200)
    }),
    cols: dimension,
    rows: dimension
});

export const serverPromptSchema = frame("prompt", {
    sessionId: id,
    text: shortText(RUNNER_LIMITS.promptChars).min(1)
});

export const serverInterruptSchema = frame("interrupt", { sessionId: id });

export const serverSessionStopSchema = frame("session.stop", { sessionId: id });

export const serverSessionSettingsSchema = frame("session.settings", {
    sessionId: id,
    permissionMode: z.enum(SESSION_PERMISSION_MODES).optional(),
    model: shortText(200).optional(),
    effort: z.enum(AGENT_EFFORT_LEVELS).optional()
});

/** The answer to a `permission.request`: the JSON the CLI's hook prints, built
 *  by the server from what the person chose (allow, deny, always, or the
 *  answers to a question). */
export const serverPermissionDecisionSchema = frame("permission.decision", {
    requestId: id,
    sessionId: id,
    decision: z.record(z.unknown())
});

export const serverTerminalAttachSchema = frame("terminal.attach", {
    sessionId: id,
    cols: dimension,
    rows: dimension
});

export const serverTerminalDetachSchema = frame("terminal.detach", { sessionId: id });

export const serverTerminalInputSchema = frame("terminal.input", {
    sessionId: id,
    data: base64Chunk
});

export const serverTerminalResizeSchema = frame("terminal.resize", {
    sessionId: id,
    cols: dimension,
    rows: dimension
});

export const serverErrorSchema = frame("error", {
    code: shortText(60),
    message: shortText(500)
});

export const serverMessageSchema = z.discriminatedUnion("type", [
    serverWelcomeSchema,
    serverHeartbeatAckSchema,
    serverSessionStartSchema,
    serverPromptSchema,
    serverInterruptSchema,
    serverSessionStopSchema,
    serverSessionSettingsSchema,
    serverPermissionDecisionSchema,
    serverTerminalAttachSchema,
    serverTerminalDetachSchema,
    serverTerminalInputSchema,
    serverTerminalResizeSchema,
    serverErrorSchema
]);
export type ServerMessage = z.infer<typeof serverMessageSchema>;

/** A server frame minus the envelope, for building one. */
export type ServerCommand = ServerMessage extends infer M
    ? M extends { v: number }
        ? Omit<M, "v">
        : never
    : never;

/** The frames a dashboard sends a runner through the relay (the rest are the
 *  relay's own). */
export const RELAYED_SERVER_TYPES = [
    "session.start",
    "prompt",
    "interrupt",
    "session.stop",
    "session.settings",
    "permission.decision",
    "terminal.attach",
    "terminal.detach",
    "terminal.input",
    "terminal.resize"
] as const;

/** Whether a runner speaking `range` can talk to this server. */
export function protocolCompatible(range: { min: number; max: number }): boolean {
    return range.min <= RUNNER_PROTOCOL_VERSION && RUNNER_PROTOCOL_VERSION <= range.max;
}

export type ParsedFrame<T> = { ok: true; message: T } | { ok: false; code: "too_large" | "not_json" | "invalid"; detail: string };

function parseWith<T>(schema: z.ZodType<T>, raw: string): ParsedFrame<T> {
    if (raw.length > RUNNER_LIMITS.frameBytes || new TextEncoder().encode(raw).length > RUNNER_LIMITS.frameBytes)
        return { ok: false, code: "too_large", detail: "frame larger than the limit" };
    let json: unknown;
    try {
        json = JSON.parse(raw);
    } catch {
        return { ok: false, code: "not_json", detail: "frame is not JSON" };
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
        const issue = parsed.error.issues[0];
        return { ok: false, code: "invalid", detail: `${issue?.path.join(".") || "frame"}: ${issue?.message ?? "invalid"}`.slice(0, 300) };
    }
    return { ok: true, message: parsed.data };
}

/** Read one frame a runner sent. */
export function parseRunnerFrame(raw: string): ParsedFrame<RunnerMessage> {
    return parseWith(runnerMessageSchema, raw);
}

/** Read one frame the server sent (the runner's side). */
export function parseServerFrame(raw: string): ParsedFrame<ServerMessage> {
    return parseWith(serverMessageSchema, raw);
}

/** Serialise a server frame, validated, with the envelope filled in. Throws on
 *  a frame this build would itself refuse, so a bug never reaches a runner. */
export function encodeServerFrame(command: ServerCommand): string {
    return JSON.stringify(serverMessageSchema.parse({ v: RUNNER_PROTOCOL_VERSION, ...command }));
}
