/**
 * Reading and changing the rules a world is played under.
 *
 * Every one of these takes effect the moment the server is told, so nothing here
 * restarts anything and nobody playing is disconnected. That is the point: the
 * same settings live in `server.properties`, where changing one means rebuilding
 * the container, and an operator who only wants to stop deaths costing people
 * their inventory should not have to end everybody's session to do it.
 *
 * Reading is one exec rather than one per rule. Each `/gamerule x` is its own
 * round trip into the container, and two dozen of those on a remote machine is
 * two dozen SSH handshakes for one screen - so the commands are handed to a
 * single shell inside the container and the replies come back together. The rule
 * names are this module's own constants, never anything a caller supplied.
 *
 * **What the server last said is kept.** A stopped server answers nothing, and a
 * screen of empty switches says "this world has no rules" when what is true is
 * "nobody can ask right now". So every answer is written to the install's own
 * config blob and handed back when the server cannot be reached, marked with when
 * it was read and with everything on the screen locked - a remembered value is
 * something to look at, never something to appear to change.
 */

import { prisma } from "@polaris/db";
import { stripFormatting } from "./parse";
import { withServerContainer, type ServerContainer } from "./service";
import { patchInstallConfig, readInstallConfig } from "@/lib/apps/install-config";
import {
    GAME_RULES,
    findRule,
    isDifficulty,
    normalizeRuleValue,
    parseDifficulty,
    parseGameRules,
    type Difficulty
} from "./rules";

/** What one server is playing under right now. */
export interface WorldRules {
    /** Rule id to its value, holding only the rules this version has. */
    readonly values: Record<string, string>;
    /** Null when the server did not report one. */
    readonly difficulty: Difficulty | null;
    /**
     * Why there are no values, when there are none.
     *
     * A rule is a thing the game has, not a thing this server told us about: the
     * list of them is in Polaris and a stopped server does not change it. So a
     * failed read is a sentence to put above the rules rather than a reason to
     * draw nothing - the screen owes somebody the catalogue and an explanation,
     * not a daemon error about a container id they have never seen.
     */
    readonly reason: string | null;
    /**
     * When these values were read, for values that are remembered rather than
     * current. Null means the server answered just now.
     */
    readonly asOf: string | null;
    /**
     * Whether the game itself answered, which is the same question as whether
     * anything here can be changed. A server that is off, and a Bedrock one that
     * cannot be asked from here, both answer nothing - and a screen that offered
     * to change a rule in either case would be offering something that fails.
     */
    readonly answering: boolean;
}

/** A rule name is only ever one of ours, and this is what says so out loud before
 *  one is put in a shell command. */
function assertKnownRuleNames(): void {
    for (const rule of GAME_RULES) {
        if (!/^[A-Za-z]+$/.test(rule.id)) throw new Error(`Unusable game rule name: ${rule.id}`);
    }
}

/**
 * Ask the server what every rule is set to.
 *
 * A rule the server has never heard of answers with a parser error rather than a
 * value, so it is absent from the map and the screen does not draw it. That is
 * how one screen serves 1.13 and 1.21 without knowing which it is looking at.
 */
export async function readWorldRules(server: ServerContainer): Promise<WorldRules> {
    if (server.edition !== "java") {
        return {
            values: {},
            difficulty: null,
            reason: "Bedrock keeps its rules inside the world rather than answering for them.",
            asOf: null,
            answering: false
        };
    }
    assertKnownRuleNames();
    const script = [...GAME_RULES.map((rule) => `rcon-cli gamerule ${rule.id}`), "rcon-cli difficulty"].join(
        "; "
    );
    const result = await server.run(["sh", "-c", script]);
    const output = stripFormatting(result.output);
    const values = parseGameRules(output);
    // A server that is down answers every one of them with a refused connection,
    // which parses to no rules - and "this version has none of these" is a very
    // different thing to tell somebody than "it is not running".
    if (values.size === 0) {
        const said = output.trim().replace(/\s+/g, " ").slice(0, 200);
        if (!said || /connection refused/i.test(said)) {
            return {
                values: {},
                difficulty: null,
                reason: "Start the server to read what these are set to.",
                asOf: null,
                answering: false
            };
        }
        // It answered, and refused every one of them. Seen on Minecraft 26.2, which
        // will not read a rule back the way every release before it did - so the
        // question "what is this set to" has no answer here, while setting one still
        // works perfectly.
        //
        // Handing the operator the server's own parser errors is the worst of the
        // options: three lines of `<--[HERE]` in place of a screen, about a command
        // they never typed. An empty set says the same thing and lets the screen
        // draw, and the values it does not know are shown as unset rather than
        // invented.
        if (/incorrect argument|unknown or incomplete|<--\[HERE\]/i.test(said)) {
            return {
                values: {},
                difficulty: parseDifficulty(output),
                reason: "This server's version will not say what a rule is set to. Setting one still works.",
                asOf: null,
                answering: true
            };
        }
        // Whatever this is, it is not the game talking. The container being down is
        // one way here: the daemon answers in place of the server and names an id
        // nobody has ever seen, and quoting it back was this screen's own bug - the
        // reader gets a sentence about their server instead.
        return {
            values: {},
            difficulty: parseDifficulty(output),
            reason: "The server is not answering, so what these are set to cannot be read right now.",
            asOf: null,
            answering: false
        };
    }
    return {
        values: Object.fromEntries(values),
        difficulty: parseDifficulty(output),
        reason: null,
        asOf: null,
        answering: true
    };
}

/**
 * Where the last answer is kept.
 *
 * The install's own config blob, which is the game-servers app's store rather
 * than Polaris's: an optional app keeps its own notes, and they go when the
 * install does.
 */
const REMEMBERED_KEY = "minecraftRules";

/** The difficulty's key among the reading times, which it shares with the rule
 *  ids. No rule is spelled this way, so nothing collides. */
const DIFFICULTY_FIELD = "difficulty";

/**
 * How far a reading time may drift before a read that confirms what is already
 * kept is worth writing again.
 *
 * Reading runs on every view of the screen and this note lives in the blob
 * everything else about the install merges into, so confirming what is already
 * there must not put a read path in that queue of writers. The date is only ever
 * shown once the server has stopped answering, where being a few minutes out
 * changes nothing about what it tells the reader.
 */
const RESTAMP_AFTER_MS = 5 * 60_000;

interface RememberedRules {
    readonly values: Record<string, string>;
    readonly difficulty: Difficulty | null;
    /** The oldest of `times`: a blob written a field at a time is only as fresh as
     *  its stalest part, and that is all a screen showing the whole of it may
     *  claim. */
    readonly at: string;
    /**
     * When each field last came from the server, by rule id and by
     * `DIFFICULTY_FIELD`. A blob written by an older Polaris carries none, and
     * everything in it is as old as `at`.
     */
    readonly times?: Record<string, string>;
}

/** An instant as stored, or null for anything that is not one. This is a JSON
 *  column older code wrote, so nothing out of it is taken on trust. */
function readInstant(value: unknown): string | null {
    return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;
}

function oldestOf(times: Record<string, string>): string | null {
    let found: string | null = null;
    for (const time of Object.values(times)) {
        if (found === null || Date.parse(time) < Date.parse(found)) found = time;
    }
    return found;
}

/**
 * The last answer this server gave, or null when it has never given one.
 *
 * Everything read back is checked against the catalogue as it is now: this was
 * written by an older Polaris, against an older world, and a rule that has since
 * been dropped or a value that is no longer legal must not reach a screen as
 * though the server had just said it.
 */
async function remembered(installedAppId: string): Promise<RememberedRules | null> {
    const row = await prisma.installedApp.findUnique({
        where: { id: installedAppId },
        select: { config: true }
    });
    const stored = readInstallConfig(row?.config)[REMEMBERED_KEY];
    if (typeof stored !== "object" || stored === null || Array.isArray(stored)) return null;
    const blob = stored as Partial<RememberedRules>;
    const at = readInstant(blob.at);
    if (!at) return null;
    const storedTimes: Record<string, unknown> =
        typeof blob.times === "object" && blob.times !== null && !Array.isArray(blob.times)
            ? (blob.times as Record<string, unknown>)
            : {};
    const values: Record<string, string> = {};
    const times: Record<string, string> = {};
    for (const [id, value] of Object.entries(blob.values ?? {})) {
        const rule = findRule(id);
        if (!rule || typeof value !== "string") continue;
        if (normalizeRuleValue(rule, value) === null) continue;
        values[id] = value;
        times[id] = readInstant(storedTimes[id]) ?? at;
    }
    const difficulty = isDifficulty(blob.difficulty) ? blob.difficulty : null;
    if (difficulty) times[DIFFICULTY_FIELD] = readInstant(storedTimes[DIFFICULTY_FIELD]) ?? at;
    if (Object.keys(values).length === 0 && !difficulty) return null;
    return { values, difficulty, at: oldestOf(times) ?? at, times };
}

/**
 * Keep what the server just said.
 *
 * Merged rather than replaced, and for the same reason the config blob itself
 * merges: a single rule being set must not delete the two dozen that were read a
 * minute earlier. Each field carries its own reading time for that same reason -
 * stamping the whole blob on a one-field write is how values read three days ago
 * come to claim on screen that they were read just now.
 *
 * A difficulty is only ever given, never taken away: the type says so, because
 * the one caller holding a `Difficulty | null` is a live read that parsed rules
 * and no difficulty line, and letting its null through here would erase a
 * perfectly good remembered one.
 *
 * Nothing is written when nothing would change and the times are not drifting.
 */
async function remember(
    installedAppId: string,
    next: { values?: Record<string, string>; difficulty?: Difficulty }
): Promise<void> {
    const before = await remembered(installedAppId);
    const now = Date.now();
    const stamp = new Date(now).toISOString();
    const values = { ...(before?.values ?? {}), ...(next.values ?? {}) };
    const difficulty = next.difficulty ?? before?.difficulty ?? null;
    if (Object.keys(values).length === 0 && !difficulty) return;

    // Only the fields this call actually read carry a new time. Everything merged
    // in from the blob before keeps the one it had, being exactly as old as it was
    // a moment ago.
    const read = new Set(Object.keys(next.values ?? {}));
    if (next.difficulty !== undefined) read.add(DIFFICULTY_FIELD);

    const same =
        before !== null &&
        before.difficulty === difficulty &&
        Object.keys(values).length === Object.keys(before.values).length &&
        Object.entries(values).every(([id, value]) => before.values[id] === value);
    const fresh = [...read].every((field) => {
        const time = before?.times?.[field];
        return time !== undefined && now - Date.parse(time) <= RESTAMP_AFTER_MS;
    });
    if (same && fresh) return;

    const times: Record<string, string> = {};
    for (const id of Object.keys(values)) times[id] = read.has(id) ? stamp : (before?.times?.[id] ?? stamp);
    if (difficulty) {
        times[DIFFICULTY_FIELD] = read.has(DIFFICULTY_FIELD)
            ? stamp
            : (before?.times?.[DIFFICULTY_FIELD] ?? stamp);
    }
    const blob: RememberedRules = { values, difficulty, at: oldestOf(times) ?? stamp, times };
    await patchInstallConfig(installedAppId, { [REMEMBERED_KEY]: blob });
}

/** Keeping a note is never worth failing the thing it is a note about. */
async function rememberQuietly(
    installedAppId: string,
    next: { values?: Record<string, string>; difficulty?: Difficulty }
): Promise<void> {
    await remember(installedAppId, next).catch(() => undefined);
}

/** The difficulty, remembered from wherever it was changed - the settings form
 *  writes the same value into the container's environment and would otherwise
 *  leave this screen showing the one before it. */
export async function rememberDifficulty(installedAppId: string, difficulty: Difficulty): Promise<void> {
    await rememberQuietly(installedAppId, { difficulty });
}

/**
 * The same, opening the machine for it.
 *
 * A server that is off cannot be opened at all, and the daemon says so by naming a
 * container id nobody has ever seen. That is not an answer to put on a screen, and
 * it is not a reason to withhold the rules either: they are the game's, they are in
 * Polaris, and the only thing a stopped server changes is that none of them can be
 * read or set right now - so what it last said is what the screen shows, locked and
 * dated.
 */
export async function readRulesFor(ownerId: string, installedAppId: string): Promise<WorldRules> {
    const live = await withServerContainer(ownerId, installedAppId, readWorldRules).catch(() => null);
    if (live && Object.keys(live.values).length > 0) {
        await rememberQuietly(installedAppId, { values: live.values, difficulty: live.difficulty ?? undefined });
        return live;
    }
    // It read no rules back, which does not mean it said nothing: a server that
    // will not answer for a rule still answers for the difficulty. That is worth
    // keeping on its own, and it is not worth throwing away the rules kept from
    // when the server was more forthcoming.
    if (live?.difficulty) await rememberQuietly(installedAppId, { difficulty: live.difficulty });
    const kept = await remembered(installedAppId).catch(() => null);
    if (kept) {
        return {
            values: kept.values,
            difficulty: live?.difficulty ?? kept.difficulty,
            // A server that is up but will not read a rule back keeps its own
            // explanation: those values are old, and setting one still works.
            reason:
                live?.answering === true
                    ? live.reason
                    : "The server is not running. These are the values Polaris last read from it, and nothing here can be changed until it starts.",
            asOf: kept.at,
            answering: live?.answering === true
        };
    }
    return (
        live ?? {
            values: {},
            difficulty: null,
            reason: "The server is stopped, so its rules cannot be read or changed yet.",
            asOf: null,
            answering: false
        }
    );
}

/**
 * Set one rule, and hand back what it ended up as.
 *
 * The server's own reply is read back rather than the value being assumed: a
 * server that clamped or refused it is the one case where believing the form
 * would leave a screen showing a setting that is not in force.
 */
export async function setWorldRule(
    ownerId: string,
    installedAppId: string,
    id: string,
    value: string
): Promise<string> {
    const rule = findRule(id);
    if (!rule) throw new Error("That is not a rule Polaris can set");
    const normalized = normalizeRuleValue(rule, value);
    if (normalized === null) throw new Error(`${rule.label} does not take that value`);
    const reply = await withServerContainer(ownerId, installedAppId, (server) => {
        if (server.edition !== "java") throw new Error("Bedrock servers cannot be asked this from here");
        return server.say(["gamerule", rule.id, normalized]);
    });
    const said = parseGameRules(stripFormatting(reply)).get(rule.id);
    if (said === undefined) {
        const trimmed = stripFormatting(reply).trim().replace(/\s+/g, " ").slice(0, 160);
        throw new Error(trimmed ? `The server refused it: ${trimmed}` : "The server did not accept that");
    }
    await rememberQuietly(installedAppId, { values: { [rule.id]: said } });
    return said;
}

/** Change the difficulty, live. */
export async function setWorldDifficulty(
    ownerId: string,
    installedAppId: string,
    difficulty: Difficulty
): Promise<void> {
    await withServerContainer(ownerId, installedAppId, (server) => {
        if (server.edition !== "java") throw new Error("Bedrock servers cannot be asked this from here");
        return server.say(["difficulty", difficulty]);
    });
    await rememberQuietly(installedAppId, { difficulty });
}
