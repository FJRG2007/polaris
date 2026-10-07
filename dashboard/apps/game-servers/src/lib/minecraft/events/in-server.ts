/**
 * The Polaris mod's event commands, used where the server has them.
 *
 * A server running the Polaris NeoForge mod can keep a player's things and
 * build an arena inside the game, in one tick or paced over a few, instead of
 * over many console trips (`polaris stash`, `polaris batch`). Whether it can is
 * asked, never assumed: the mod answers `polaris caps` with what it can do, and
 * any other answer - vanilla, Paper, Fabric, Forge, an older jar a server has not
 * restarted onto - means the plain-command path every server keeps. The answer
 * is remembered for a minute per server, so a restart onto a new jar is picked
 * up soon after.
 *
 * Hide and seek needs nothing from here: the mod hides a hider from seekers who
 * cannot see them on its own, by the event's teams.
 */

import { z } from "zod";
import { createHash } from "node:crypto";
import { stripFormatting } from "../parse";
import type { ServerContainer } from "../service";
import { COMMAND_BYTES_MAX, commandBytes } from "../command-size";

export type Capability = "stash" | "batch" | "seek";

const capsSchema = z.object({
    ok: z.literal(true),
    polaris: z.string(),
    caps: z.array(z.string())
});

/** The JSON object a mod command answered, or null for anything else. */
export function replyObject(reply: string): Record<string, unknown> | null {
    const line = stripFormatting(reply)
        .split("\n")
        .map((one) => one.trim())
        .find((one) => one.startsWith("{"));
    if (!line) return null;
    try {
        const value: unknown = JSON.parse(line);
        return value !== null && typeof value === "object" && !Array.isArray(value)
            ? (value as Record<string, unknown>)
            : null;
    } catch {
        return null;
    }
}

/** What `polaris caps` says this server can do; nothing for any other answer. */
export function parseCaps(reply: string): ReadonlySet<Capability> {
    const parsed = capsSchema.safeParse(replyObject(reply));
    if (!parsed.success) return new Set();
    return new Set(
        parsed.data.caps.filter((cap): cap is Capability =>
            ["stash", "batch", "seek"].includes(cap)
        )
    );
}

const CAPS_TTL_MS = 60_000;
/** Per server, the answer - or the question still out, so players stashed at
 *  once share one ask rather than a trip each. */
const known = new Map<
    string,
    { readonly at: number; readonly caps: Promise<ReadonlySet<Capability>> }
>();

/** What this server's Polaris mod can do now; empty where it has none. */
export async function capabilities(
    server: ServerContainer,
    now: number = Date.now()
): Promise<ReadonlySet<Capability>> {
    if (server.edition !== "java") return new Set();
    const cached = known.get(server.installedAppId);
    if (cached && now - cached.at < CAPS_TTL_MS) return cached.caps;
    const caps = server
        .say(["polaris caps"])
        .catch(() => "")
        .then(parseCaps);
    known.set(server.installedAppId, { at: now, caps });
    return caps;
}

/** Forget what a server could do: it is restarting, or answered as if it could not. */
export function forgetCapabilities(installedAppId: string): void {
    known.delete(installedAppId);
}

// ------------------------------------------------------------------ stash

/** A name the mod's commands take as one word. */
const WORD = /^[A-Za-z0-9_]{1,16}$/;

/**
 * The key a player's stash is kept under for one run: the same for the same run
 * and player, so asking again is answered as already done. `round` names a
 * second look, for what they picked up on the way in.
 */
export function stashKey(runId: string, name: string, round = 0): string {
    const digest = createHash("sha256")
        .update(`${runId}:${name.toLowerCase()}`)
        .digest("hex")
        .slice(0, 24);
    return round > 0 ? `pe${digest}-${round}` : `pe${digest}`;
}

/** The command, or null for a name the mod cannot take (the old path then). */
export function stashLine(action: "save" | "restore", name: string, key: string): string | null {
    return WORD.test(name) ? `polaris stash ${action} ${name} ${key}` : null;
}

const stashReplySchema = z.object({
    ok: z.boolean(),
    why: z.string().optional(),
    already: z.boolean().optional(),
    restored: z.boolean().optional(),
    items: z.number().int().optional(),
    dropped: z.number().int().optional()
});

export type StashReply = z.infer<typeof stashReplySchema>;

/** The mod's answer to a stash command; null when it did not answer as the mod. */
export function parseStashReply(reply: string): StashReply | null {
    const parsed = stashReplySchema.safeParse(replyObject(reply));
    return parsed.success ? parsed.data : null;
}

// ------------------------------------------------------------------ batch

/** Blocks a tick a batch may change: an arena of 50,000 goes up in seven ticks. */
export const BLOCKS_PER_TICK = 8192;
/** How long a build is waited for before it is called off. */
const BATCH_WAIT_MS = 30_000;
const BATCH_POLL_MS = 100;

/** An SNBT string holding `value` exactly. */
function snbtString(value: string): string {
    return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * The lines that write `commands` to the batch's storage and start it, or null
 * when one would be longer than a command can be (the old path then).
 */
export function batchLines(
    key: string,
    commands: readonly string[],
    blocksPerTick: number = BLOCKS_PER_TICK
): string[] | null {
    const lines = [
        `data remove storage polaris:batch ${key}`,
        ...commands.map(
            (command) => `data modify storage polaris:batch ${key} append value ${snbtString(command)}`
        ),
        `polaris batch run ${key} ${blocksPerTick}`
    ];
    return lines.every((line) => !line.includes("\n") && commandBytes(line) <= COMMAND_BYTES_MAX)
        ? lines
        : null;
}

const batchStatusSchema = z.object({
    ok: z.literal(true),
    done: z.boolean(),
    total: z.number().int(),
    ran: z.number().int(),
    failed: z.number().int()
});

export type BatchStatus = z.infer<typeof batchStatusSchema>;

export function parseBatchStatus(reply: string): BatchStatus | null {
    const parsed = batchStatusSchema.safeParse(replyObject(reply));
    return parsed.success ? parsed.data : null;
}

let batches = 0;

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run `lines` the fastest way this server allows without freezing it: through
 * the mod's paced batch where it can, waited for until every line has run;
 * through `plain` - the paced console trips every server has - otherwise.
 * Either way the lines have all been run when this answers. A batch that will
 * not finish in time is cancelled and answered as false, and the caller treats
 * it as a build that did not go in.
 */
export async function build(
    server: ServerContainer,
    lines: readonly string[],
    plain: (lines: readonly string[]) => Promise<unknown> = (all) => server.sayAll(all),
    wait: (ms: number) => Promise<unknown> = pause
): Promise<boolean> {
    if (lines.length === 0) return true;
    const caps = await capabilities(server);
    batches = (batches + 1) % 1_000_000;
    const key = `pb${Date.now().toString(36)}${batches.toString(36)}`;
    const written = caps.has("batch") ? batchLines(key, lines) : null;
    if (!written) {
        await plain(lines);
        return true;
    }
    await server.sayAll(written.slice(0, -1));
    let status = parseBatchStatus(await server.say([written.at(-1)!]));
    if (!status) {
        // It answered as something else: not the mod after all.
        forgetCapabilities(server.installedAppId);
        await plain(lines);
        return true;
    }
    const until = Date.now() + BATCH_WAIT_MS;
    while (!status.done && Date.now() < until) {
        await wait(BATCH_POLL_MS);
        status = parseBatchStatus(await server.say([`polaris batch status ${key}`])) ?? status;
    }
    if (status.done) return true;
    await server.say([`polaris batch cancel ${key}`]);
    return false;
}
