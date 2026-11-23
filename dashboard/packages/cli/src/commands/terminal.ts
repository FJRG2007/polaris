/**
 * `plr terminal list` and `plr terminal run ACTION`: Polaris Terminal from the
 * command line, on this computer or anywhere the account has one signed in.
 *
 * A terminal on this computer is reached directly through its local-control
 * protocol (`terminal-local.ts`), with no server and no sign-in. Any other is
 * reached through Polaris: one WebSocket to the remote-control relay as a
 * controller (`/api/deploy/ws/terminal?role=controller`, the CLI's key, which
 * needs `terminal.control`), one request, one answer. The request is the same
 * envelope either way - `{ protocol_version, request_id, target, action }` - so
 * every action the terminal implements works the same in both places.
 */

import { z } from "zod";
import type { Flags } from "../args.js";
import { randomUUID } from "node:crypto";
import { CliError, usage } from "../errors.js";
import { line, printJson, table } from "../output.js";
import { send, answer, type Connection } from "../api.js";
import { requireSession, type Context } from "../context.js";
import {
    PROTOCOL_VERSION,
    localTerminals,
    sendLocal,
    unwrap,
    type Envelope,
    type LocalTerminal
} from "../terminal-local.js";

/** How long the relay is given to bring an answer back; it gives up at 60 s. */
const REMOTE_TIMEOUT_MS = 65_000;

/** An action name as the terminal spells them: `pane.list`, `input.insert`. */
const ACTION = /^[a-z][a-z_]*(\.[a-z][a-z_]*)+$/;

const remoteSchema = z.object({
    terminals: z
        .array(
            z.object({
                id: z.string(),
                name: z.string().nullable(),
                os: z.string().nullable(),
                version: z.string().nullable(),
                online: z.boolean(),
                access: z.enum(["owner", "view", "control"]),
                ownerName: z.string().nullable().optional()
            })
        )
        .max(1000)
});

type RemoteTerminal = z.infer<typeof remoteSchema>["terminals"][number];

/** The account's terminals through Polaris, or why they could not be listed. */
async function remoteTerminals(
    context: Context,
    connection: Connection
): Promise<{ terminals: RemoteTerminal[]; problem: string | null }> {
    const response = await send(connection, "GET", "/api/terminal/instances", { fetch: context.fetch });
    if (response.status === 404)
        return { terminals: [], problem: `${connection.url} does not reach terminals yet. Update Polaris from Settings.` };
    if (response.status === 403)
        return {
            terminals: [],
            problem: "This sign-in cannot reach terminals. Run plr login again and approve terminal control."
        };
    return { terminals: (await answer(connection, response, remoteSchema)).terminals, problem: null };
}

/** The session, or null when nobody is signed in (a local terminal needs none). */
async function maybeSession(context: Context, flags: Flags) {
    try {
        return await requireSession(context, flags);
    } catch (caught) {
        if (caught instanceof CliError && caught.message.startsWith("Not signed in")) return null;
        throw caught;
    }
}

export async function list(context: Context, flags: Flags): Promise<void> {
    const local = await localTerminals(context.host);
    const session = await maybeSession(context, flags);
    const remote = session ? await remoteTerminals(context, session.connection) : null;
    if (flags.json) {
        printJson(context.io, {
            local: local.map(({ record, scripting }) => ({
                id: record.instance_id,
                channel: record.channel,
                version: record.app_version ?? null,
                pid: record.pid,
                scripting
            })),
            remote: remote?.terminals ?? [],
            problem: remote?.problem ?? null
        });
        return;
    }
    const rows = [
        ...local.map(({ record, scripting }) => [
            record.instance_id,
            "this computer",
            record.app_version ?? "",
            scripting ? "ready" : "Scripting off"
        ]),
        ...(remote?.terminals ?? []).map((one) => [
            one.id,
            one.name ?? "Unnamed terminal",
            one.version ?? "",
            `${one.online ? "online" : "offline"}${one.access === "owner" ? "" : `, shared (${one.access})`}`
        ])
    ];
    if (rows.length === 0) line(context.io, "No terminals found.");
    else context.io.out(table(["ID", "WHERE", "VERSION", "STATE"], rows));
    if (!session) line(context.io, "Sign in with plr login to see your terminals on other computers too.");
    if (remote?.problem) line(context.io, remote.problem);
}

/** A `--window`/`--tab`/`--pane` value as the terminal's target selector. */
export function selector(value: string): Record<string, unknown> {
    if (value === "active") return { type: "active" };
    if (/^\d{1,6}$/.test(value)) return { type: "index", index: Number(value) };
    return { type: "id", id: value };
}

/** The request envelope for `ACTION` with the command line's target and params. */
export function envelopeFor(action: string | undefined, flags: Flags, requestId: string = randomUUID()): Envelope {
    if (!action || !ACTION.test(action))
        throw usage("Name the action to run, e.g. plr terminal run pane.list (the terminal's Scripting settings list them).");
    let params: Record<string, unknown> = {};
    if (flags.params !== undefined) {
        let parsed: unknown;
        try {
            parsed = JSON.parse(flags.params);
        } catch {
            throw usage("--params takes a JSON object, e.g. --params '{\"text\":\"ls\"}'.");
        }
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
            throw usage("--params takes a JSON object, e.g. --params '{\"text\":\"ls\"}'.");
        params = parsed as Record<string, unknown>;
    }
    const target: Record<string, unknown> = {};
    for (const key of ["window", "tab", "pane"] as const) {
        const value = flags[key];
        if (value !== undefined) target[key] = selector(value);
    }
    return { protocol_version: PROTOCOL_VERSION, request_id: requestId, target, action: { kind: action, params } };
}

/** What a relay refusal means, in the reader's terms. */
const RELAY_WORDS: Record<string, string> = {
    not_found: "There is no terminal with that id that you can reach. plr terminal list shows yours.",
    offline: "That terminal is not connected to Polaris right now. Check that it is running and signed in.",
    busy: "That terminal has too many requests waiting. Try again in a moment.",
    timeout: "That terminal did not answer in time."
};

const relayFrame = z.object({
    type: z.string(),
    request_id: z.string().optional(),
    code: z.string().optional(),
    envelope: z.unknown().optional()
});

type SocketLike = {
    onopen: (() => void) | null;
    onmessage: ((event: { data: unknown }) => void) | null;
    onerror: (() => void) | null;
    onclose: ((event: { code: number }) => void) | null;
    send(data: string): void;
    close(): void;
};
type SocketFactory = (url: string, init: { headers: Record<string, string> }) => SocketLike;

/** The runtime's WebSocket, which takes headers (Node 22 and later). */
function nodeSocket(url: string, init: { headers: Record<string, string> }): SocketLike {
    const Socket = (globalThis as { WebSocket?: new (url: string, init: unknown) => SocketLike }).WebSocket;
    if (!Socket)
        throw new CliError("Reaching a terminal through Polaris needs Node.js 22 or newer. Update Node, then try again.");
    return new Socket(url, init);
}

/** One request through the relay, answered with the response envelope's data. */
export function sendRemote(
    connection: Connection,
    instance: string,
    envelope: Envelope,
    open: SocketFactory = nodeSocket,
    timeoutMs = REMOTE_TIMEOUT_MS
): Promise<unknown> {
    const url = new URL("/api/deploy/ws/terminal", connection.url);
    url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
    url.searchParams.set("role", "controller");
    return new Promise((resolve, reject) => {
        const socket = open(url.toString(), { headers: { authorization: `Bearer ${connection.token}` } });
        let settled = false;
        const finish = (outcome: () => void) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            socket.close();
            outcome();
        };
        const timer = setTimeout(() => finish(() => reject(new CliError(RELAY_WORDS.timeout!))), timeoutMs);
        socket.onopen = () => socket.send(JSON.stringify({ type: "request", instance, envelope }));
        socket.onmessage = (event) => {
            let frame: z.infer<typeof relayFrame>;
            try {
                frame = relayFrame.parse(JSON.parse(String(event.data)));
            } catch {
                return;
            }
            if (frame.request_id !== envelope.request_id) return;
            if (frame.type === "error")
                return finish(() =>
                    reject(new CliError(RELAY_WORDS[frame.code ?? ""] ?? "Polaris could not deliver that request."))
                );
            if (frame.type === "response") {
                finish(() => {
                    try {
                        resolve(unwrap(frame.envelope));
                    } catch (caught) {
                        reject(caught);
                    }
                });
            }
        };
        socket.onerror = () =>
            finish(() =>
                reject(
                    new CliError(
                        `Could not reach the terminal relay at ${connection.url}. If this sign-in predates terminal control, run plr login again.`
                    )
                )
            );
        socket.onclose = () =>
            finish(() => reject(new CliError("Polaris closed the connection before the terminal answered.")));
    });
}

/** Which terminal a command means: `--instance`, or the only one here. */
function pick(local: LocalTerminal[], instance: string | undefined): LocalTerminal | string {
    if (instance) return local.find((one) => one.record.instance_id === instance) ?? instance;
    const ready = local.filter((one) => one.scripting);
    if (ready.length === 1) return ready[0]!;
    if (ready.length === 0)
        throw new CliError(
            local.length > 0
                ? "The terminal on this computer has Scripting switched off. Switch it on in its Settings, under Scripting, or pick another with --instance."
                : "No terminal is running on this computer. Pick one elsewhere with --instance (plr terminal list shows them)."
        );
    throw usage("More than one terminal is running here. Pick one with --instance (plr terminal list shows them).");
}

export async function runAction(context: Context, flags: Flags, action: string | undefined): Promise<void> {
    const envelope = envelopeFor(action, flags);
    const local = await localTerminals(context.host);
    const chosen = pick(local, flags.instance);
    const data =
        typeof chosen === "string"
            ? await sendRemote((await requireSession(context, flags)).connection, chosen, envelope)
            : await sendLocal(chosen, envelope, context.host.platform, context.fetch);
    printJson(context.io, data ?? null);
}
