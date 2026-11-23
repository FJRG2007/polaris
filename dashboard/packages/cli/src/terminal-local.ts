/**
 * Polaris Terminal on this computer, reached without a server: the terminal's
 * own local-control protocol, spoken the way its bundled client speaks it.
 *
 * 1. Every running terminal with Scripting on publishes a JSON record in an
 *    owner-only discovery directory: its instance id, process id, the exact
 *    loopback endpoint (`127.0.0.1` only) and the name of its credential-broker
 *    socket, which is always `<instance id>.broker.sock` in that directory.
 * 2. For each request the client asks that socket for a credential scoped to
 *    the one action it is about to run (the terminal checks the caller's user
 *    id on the socket), writing the request and closing its half to mark the end.
 * 3. It sends the request with that credential to the loopback endpoint.
 *
 * A record is followed only if it is the shape the terminal writes, names
 * `127.0.0.1` and the socket its own id derives, and its process is alive, so a
 * stale or planted record cannot point a credential anywhere else. Credentials
 * are held in memory for one request and never printed.
 *
 * Both the Polaris names and the Rook names it had before are read, so a
 * terminal from before the rename is found too. The broker is a Unix socket:
 * on Windows the terminal does not offer one yet, and such a terminal is
 * reached through Polaris instead (`terminal-relay`).
 */

import { z } from "zod";
import { join } from "node:path";
import { connect } from "node:net";
import type { Fetch } from "./api.js";
import { CliError } from "./errors.js";
import type { Host } from "./paths.js";
import { readdir, readFile } from "node:fs/promises";

/** The local-control protocol version this client speaks. */
export const PROTOCOL_VERSION = 1;

/** The largest record or broker answer read; a real one is a few KiB. */
const MAX_BYTES = 256 * 1024;

/** How long a broker or a loopback endpoint may take to answer. */
const LOCAL_TIMEOUT_MS = 15_000;

const INSTANCE_ID = /^inst_[0-9a-f]{32}$/;

const recordSchema = z.object({
    protocol_version: z.number().int(),
    instance_id: z.string().regex(INSTANCE_ID),
    pid: z.number().int().positive(),
    channel: z.string().max(64),
    app_id: z.string().max(200),
    app_version: z.string().max(100).nullish(),
    started_at: z.string().max(64),
    endpoint: z.object({ host: z.string(), port: z.number().int().min(1).max(65535) }).nullish(),
    credential_broker: z.object({ socket_path: z.string().max(200) }).nullish()
});

export type LocalRecord = z.infer<typeof recordSchema>;

export interface LocalTerminal {
    readonly record: LocalRecord;
    /** The directory the record was found in, where its broker socket lives. */
    readonly dir: string;
    /** Whether Scripting is on: without it the record names no endpoint. */
    readonly scripting: boolean;
}

/** Where one brand's terminals publish their records, the way the terminal
 *  itself decides it: its override variable, then the runtime directory, then
 *  the home directory. */
function brandDir(host: Host, envName: string, name: string, homeDir: string): string {
    const override = host.env[envName];
    if (override) return override;
    const runtime = host.env.XDG_RUNTIME_DIR;
    if (runtime) return join(runtime, name, "local-control");
    return join(host.env.HOME ?? host.home ?? ".", homeDir, "local-control");
}

/** The discovery directories to read: Polaris Terminal's, then Rook's. */
export function discoveryDirs(host: Host): string[] {
    const dirs = [
        brandDir(host, "POLARIS_TERMINAL_LOCAL_CONTROL_DISCOVERY_DIR", "polaris-terminal", ".polaris-terminal"),
        brandDir(host, "ROOK_LOCAL_CONTROL_DISCOVERY_DIR", "rook", ".rook")
    ];
    return [...new Set(dirs)];
}

function alive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        // ESRCH: gone. EPERM: somebody else's process, so not the terminal that
        // wrote a record in this user's own directory.
        return false;
    }
}

/** Whether a record may be followed: the terminal's own shape and authority. */
export function trustworthy(record: LocalRecord): boolean {
    if (record.protocol_version !== PROTOCOL_VERSION) return false;
    const endpoint = record.endpoint ?? null;
    const broker = record.credential_broker ?? null;
    if (Boolean(endpoint) !== Boolean(broker)) return false;
    if (endpoint && endpoint.host !== "127.0.0.1") return false;
    if (broker && broker.socket_path !== `${record.instance_id}.broker.sock`) return false;
    return true;
}

/** Every terminal running on this computer that published a usable record. */
export async function localTerminals(host: Host, isAlive: (pid: number) => boolean = alive): Promise<LocalTerminal[]> {
    const found = new Map<string, LocalTerminal>();
    for (const dir of discoveryDirs(host)) {
        const names = await readdir(dir).catch(() => [] as string[]);
        for (const name of names) {
            if (!name.endsWith(".json")) continue;
            const text = await readFile(join(dir, name), "utf8").catch(() => null);
            if (!text || text.length > MAX_BYTES) continue;
            let parsed: unknown;
            try {
                parsed = JSON.parse(text);
            } catch {
                continue;
            }
            const record = recordSchema.safeParse(parsed);
            if (!record.success || !trustworthy(record.data) || !isAlive(record.data.pid)) continue;
            if (found.has(record.data.instance_id)) continue;
            found.set(record.data.instance_id, { record: record.data, dir, scripting: Boolean(record.data.endpoint) });
        }
    }
    return [...found.values()];
}

const credentialSchema = z.object({ bearer_token: z.string().min(1).max(4096) });
const controlErrorSchema = z.object({ code: z.string(), message: z.string(), details: z.string().nullish() });
const errorEnvelopeSchema = z.object({ protocol_version: z.number(), error: controlErrorSchema });

/** A refusal from the terminal, in its own words. */
function refused(error: z.infer<typeof controlErrorSchema>): CliError {
    return new CliError(`The terminal refused: ${error.message} (${error.code}).`);
}

/** Ask the broker for a credential for one action. */
export function requestCredential(terminal: LocalTerminal, action: string, requestId: string): Promise<string> {
    if (!terminal.scripting)
        throw new CliError("That terminal has Scripting switched off. Switch it on in the terminal's Settings, under Scripting.");
    const path = join(terminal.dir, `${terminal.record.instance_id}.broker.sock`);
    return new Promise((resolve, reject) => {
        const socket = connect({ path });
        const chunks: Buffer[] = [];
        let size = 0;
        const fail = (message: string) => {
            socket.destroy();
            reject(new CliError(message));
        };
        socket.setTimeout(LOCAL_TIMEOUT_MS, () => fail("The terminal did not answer in time."));
        socket.on("error", () => fail("Could not reach the terminal on this computer. Check that it is still running."));
        socket.on("connect", () => {
            socket.end(JSON.stringify({ protocol_version: PROTOCOL_VERSION, request_id: requestId, action }));
        });
        socket.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > MAX_BYTES) return fail("The terminal answered with more than this CLI reads.");
            chunks.push(chunk);
        });
        socket.on("end", () => {
            let parsed: unknown;
            try {
                parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            } catch {
                return fail("The terminal answered in a shape this CLI does not understand.");
            }
            const credential = credentialSchema.safeParse(parsed);
            if (credential.success) return resolve(credential.data.bearer_token);
            const error = errorEnvelopeSchema.safeParse(parsed);
            socket.destroy();
            reject(error.success ? refused(error.data.error) : new CliError("The terminal answered in a shape this CLI does not understand."));
        });
    });
}

export interface Envelope {
    readonly protocol_version: number;
    readonly request_id: string;
    readonly target: Record<string, unknown>;
    readonly action: { readonly kind: string; readonly params: Record<string, unknown> };
}

export const responseSchema = z.object({
    protocol_version: z.number(),
    request_id: z.string(),
    response: z.discriminatedUnion("status", [
        z.object({ status: z.literal("ok"), data: z.unknown() }),
        z.object({ status: z.literal("error"), error: controlErrorSchema })
    ])
});

/** Run one request on a terminal here; the answer's data, or its refusal thrown. */
export async function sendLocal(
    terminal: LocalTerminal,
    envelope: Envelope,
    platform: NodeJS.Platform,
    doFetch: Fetch = fetch
): Promise<unknown> {
    if (platform === "win32")
        throw new CliError(
            "A terminal on Windows is not reachable without Polaris yet. Pick it by its Polaris id instead (polaris terminal list)."
        );
    const token = await requestCredential(terminal, envelope.action.kind, envelope.request_id);
    const endpoint = terminal.record.endpoint!;
    let response: Response;
    try {
        response = await doFetch(`http://127.0.0.1:${endpoint.port}/v1/control`, {
            method: "POST",
            headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
            body: JSON.stringify(envelope),
            redirect: "manual",
            signal: AbortSignal.timeout(LOCAL_TIMEOUT_MS)
        });
    } catch {
        throw new CliError("Could not reach the terminal on this computer. Check that it is still running.");
    }
    const body = await response.json().catch(() => undefined);
    return unwrap(body);
}

/** The data of a response envelope, or its refusal thrown. */
export function unwrap(body: unknown): unknown {
    const parsed = responseSchema.safeParse(body);
    if (parsed.success) {
        if (parsed.data.response.status === "error") throw refused(parsed.data.response.error);
        return parsed.data.response.data;
    }
    const error = errorEnvelopeSchema.safeParse(body);
    if (error.success) throw refused(error.data.error);
    throw new CliError("The terminal answered in a shape this CLI does not understand.");
}
