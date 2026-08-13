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
 */

import { stripFormatting } from "./parse";
import { withServerContainer, type ServerContainer } from "./service";
import {
    GAME_RULES,
    findRule,
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
    if (server.edition !== "java") return { values: {}, difficulty: null };
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
            throw new Error("The server is not accepting commands yet - start it first");
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
            return { values: {}, difficulty: parseDifficulty(output) };
        }
        throw new Error(`The server did not answer: ${said}`);
    }
    return { values: Object.fromEntries(values), difficulty: parseDifficulty(output) };
}

/** The same, opening the machine for it. */
export async function readRulesFor(ownerId: string, installedAppId: string): Promise<WorldRules> {
    return withServerContainer(ownerId, installedAppId, readWorldRules);
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
}
