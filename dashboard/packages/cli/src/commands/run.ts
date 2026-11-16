/**
 * `plr run "<prompt>"`: put a coding agent on a piece of work and follow it to
 * the end of its turn, the way `opencode run` does - which is what a CI step or
 * a script needs. The agent's answer goes to stdout, what it does along the way
 * to stderr, so `plr run ... > answer.md` keeps only the answer.
 *
 * Exit codes a script can branch on: 0 when the turn ends, 1 when it fails or
 * the session ends without finishing it, 3 when the agent stops to ask
 * somebody something.
 *
 * Runs on an API key with agents.manage (POLARIS_TOKEN). The key `plr login`
 * stores is scoped to deploying, so an older Polaris that never heard of
 * sessions is not asked for more than it grants.
 */

import type { Flags } from "../args.js";
import { unreachableReason } from "../api.js";
import { CliError, usage } from "../errors.js";
import { requireSession, type Context } from "../context.js";
import { createPolarisClient, PolarisApiError, type StreamFrame } from "@polaris/sdk";

/** The agent stopped to ask somebody something. */
export const EXIT_WAITING = 3;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function explain(caught: unknown, url: string): never {
    if (caught instanceof PolarisApiError) {
        if (caught.status === 401 || caught.status === 403)
            throw new CliError(
                `${caught.message}\nplr run needs an API key with the agents.manage permission: create one under Account > API keys and set it as POLARIS_TOKEN (with POLARIS_URL).`
            );
        if (caught.status === 404)
            throw new CliError(
                `${caught.message}\nThis Polaris may predate the session API: update it from Settings.`
            );
        throw new CliError(caught.message);
    }
    // Checked here before it is sent: a --title or prompt past what the API takes.
    if (caught instanceof Error && caught.name === "ZodError") {
        const first = (caught as { issues?: { path: (string | number)[]; message: string }[] }).issues?.[0];
        throw usage(first ? `${first.path.join(".") || "input"}: ${first.message}` : caught.message);
    }
    // Never answered at all: a refused connection, a timeout, a name that does not resolve.
    throw new CliError(`Could not reach ${url}: ${unreachableReason(caught)}.`);
}

/** How a frame ends the run: an exit code, or null to keep following. */
export function outcomeOf(frame: StreamFrame): number | null {
    if (frame.type === "event" && frame.data.kind === "turn.end") return 0;
    if (frame.type === "event" && frame.data.kind === "turn.failed") return 1;
    if (frame.type === "session" && frame.data.state === "waiting") return EXIT_WAITING;
    if (frame.type === "end") return 1;
    return null;
}

function show(context: Context, frame: StreamFrame, json: boolean): void {
    if (json) {
        context.io.out(`${JSON.stringify(frame)}\n`);
        return;
    }
    if (frame.type === "message") {
        // The prompt this run sent is not news to whoever ran it.
        if (frame.data.role === "user") return;
        if (frame.data.role === "agent" && frame.data.kind === "text") {
            context.io.out(frame.data.body.endsWith("\n") ? frame.data.body : `${frame.data.body}\n`);
            return;
        }
        context.io.err(`- ${frame.data.kind}${frame.data.subject ? ` ${frame.data.subject}` : ""}\n`);
        return;
    }
    if (frame.type === "event") {
        context.io.err(`- ${frame.data.kind}${frame.data.detail ? ` ${frame.data.detail}` : ""}\n`);
        return;
    }
    if (frame.type === "session") {
        context.io.err(`[${frame.data.state}]${frame.data.detail ? ` ${frame.data.detail}` : ""}\n`);
        return;
    }
    context.io.err(`[ended: ${frame.data.state}]\n`);
}

export async function run(context: Context, flags: Flags, args: readonly string[]): Promise<void> {
    const prompt = args.join(" ").trim();
    if (!prompt) throw usage('plr run needs a prompt: plr run "what to do".');
    if (flags.continue !== undefined && !UUID.test(flags.continue))
        throw usage("--continue takes a session id, as plr run --format json prints it.");
    const json = flags.format === "json";
    const { connection } = await requireSession(context, flags);
    if (!connection.token) throw new CliError("Not signed in. Set POLARIS_TOKEN and POLARIS_URL.");
    const client = createPolarisClient({
        baseUrl: connection.url,
        token: connection.token,
        fetch: context.fetch
    });

    let id: string;
    let after: string | undefined;
    try {
        if (flags.continue !== undefined) {
            const detail = await client.sessions.get(flags.continue);
            id = detail.session.id;
            // Only what this prompt starts, not the session's whole history.
            after = detail.cursor;
            await client.sessions.prompt(id, { text: prompt });
        } else {
            const started = await client.sessions.create({
                prompt,
                repo: flags.repo ?? "",
                agent: flags.agent ?? "claude",
                title: flags.title ?? "",
                model: flags.model ?? ""
            });
            id = started.session.id;
            if (!json)
                context.io.err(
                    started.queuedAt === null
                        ? `Started ${id}.\n`
                        : `Queued ${id}: number ${started.queuedAt} in line.\n`
                );
        }
    } catch (caught) {
        explain(caught, connection.url);
    }
    if (json) context.io.out(`${JSON.stringify({ type: "started", session: id })}\n`);

    let code = 1;
    // The first session frame is the state it had when the stream opened -
    // still "waiting" on a session this run just answered - not news.
    let opened = false;
    try {
        for await (const frame of client.sessions.events(id, { after })) {
            show(context, frame, json);
            const snapshot = frame.type === "session" && !opened;
            if (frame.type === "session") opened = true;
            const outcome = snapshot ? null : outcomeOf(frame);
            if (outcome !== null) {
                code = outcome;
                break;
            }
        }
    } catch (caught) {
        explain(caught, connection.url);
    }
    if (flags.stop) {
        try {
            await client.sessions.stop(id);
        } catch (caught) {
            explain(caught, connection.url);
        }
    }
    if (code === EXIT_WAITING)
        throw new CliError(
            `The agent is waiting for an answer. Reply with: plr run --continue ${id} "<answer>"`,
            EXIT_WAITING
        );
    if (code !== 0) throw new CliError(`Session ${id} did not finish its turn.`);
}
