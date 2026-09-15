/**
 * What the moderation screen can show about a server that is switched off.
 *
 * Who is an operator, who is whitelisted, who is banned and whether the
 * whitelist is enforced at all are read out of files inside the container. A
 * stopped server has no container, so the screen had none of it - and drew the
 * whitelist switch as off, because "we could not ask" and "the whitelist is off"
 * arrived looking exactly alike. For the ordinary Polaris server, which is closed
 * by default and lets nobody in who is not listed, that is the opposite of true.
 *
 * So the answer is kept whenever the server gives one. What is asserted here is
 * the round trip and its boundary: everything written comes back, a blob written
 * by an older Polaris or edited by hand cannot stop the screen opening, and
 * nothing is reported as enforced that was not actually stored as enforced.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

/** The install's config column, which is where the answer is kept. */
let stored: string | null = null;

/** How many times that column has been rewritten. The screen behind this polls
 *  every twelve seconds per reader, so how often it writes is as much a part of
 *  the behaviour as what it writes. */
let writes = 0;

vi.mock("@polaris/db", () => ({
    prisma: {
        installedApp: {
            findUnique: async () => ({ config: stored }),
            update: async (args: { data: { config: string } }) => {
                stored = args.data.config;
                writes += 1;
                return {};
            }
        }
    }
}));

const { rememberRoster, rememberedRoster } = await import("@/lib/apps/minecraft/roster-memory");

const SERVER = "0190c1d2-0000-7000-8000-0000000000a1";

/** What the roster is stored under, for the tests that write one by hand. */
function storeRoster(roster: Record<string, unknown>, at = "2026-09-01T10:00:00.000Z"): void {
    stored = JSON.stringify({ minecraftRoster: { at, roster } });
}

beforeEach(() => {
    stored = null;
    writes = 0;
});

describe("a server that has never answered", () => {
    it("is remembered as nothing rather than as an empty roster", async () => {
        // The difference that matters: nothing known is not the same as a server
        // with no operators and no whitelist, and the screen says different
        // things about the two.
        expect(await rememberedRoster(SERVER)).toBeNull();
    });

    it("is still nothing when the stored blob has no time on it", async () => {
        stored = JSON.stringify({ minecraftRoster: { roster: { ops: ["ada"] } } });
        expect(await rememberedRoster(SERVER)).toBeNull();
    });
});

describe("what a server said, once it is off", () => {
    it("comes back as it was given, with when it was given", async () => {
        await rememberRoster(SERVER, {
            ops: ["ada"],
            whitelist: ["ada", "grace"],
            bans: [{ name: "mallory", reason: "griefing", source: "console" }],
            whitelistEnforced: true
        });

        const kept = await rememberedRoster(SERVER);
        expect(kept?.roster.ops).toEqual(["ada"]);
        expect(kept?.roster.whitelist).toEqual(["ada", "grace"]);
        expect(kept?.roster.bans).toEqual([
            { name: "mallory", reason: "griefing", source: "console" }
        ]);
        expect(kept?.roster.whitelistEnforced).toBe(true);
        expect(kept?.at).toBeTruthy();
    });

    it("is replaced by the next answer rather than merged with it", async () => {
        // A roster is the whole picture of who may play. Merging two would leave
        // somebody on a list they were taken off.
        await rememberRoster(SERVER, {
            ops: ["ada"],
            whitelist: ["ada", "grace"],
            bans: [],
            whitelistEnforced: true
        });
        await rememberRoster(SERVER, {
            ops: [],
            whitelist: ["ada"],
            bans: [],
            whitelistEnforced: false
        });

        const kept = await rememberedRoster(SERVER);
        expect(kept?.roster.ops).toEqual([]);
        expect(kept?.roster.whitelist).toEqual(["ada"]);
        expect(kept?.roster.whitelistEnforced).toBe(false);
    });
});

describe("an answer that has not changed since the last poll", () => {
    const ROSTER = {
        ops: ["ada"],
        whitelist: ["ada", "grace"],
        bans: [],
        whitelistEnforced: true
    };

    it("is not written down again", async () => {
        // The config column is one blob several other things merge their own keys
        // into, a read and then a write apiece. Writing it on every poll rewrote
        // all of it for nothing, and gave two of those writers a window to land
        // on each other.
        await rememberRoster(SERVER, ROSTER);
        expect(writes).toBe(1);

        await rememberRoster(SERVER, ROSTER);
        await rememberRoster(SERVER, { ...ROSTER });
        expect(writes).toBe(1);
    });

    it("is the same answer whatever order the server listed people in", async () => {
        await rememberRoster(SERVER, ROSTER);
        await rememberRoster(SERVER, { ...ROSTER, whitelist: ["grace", "ada"] });
        expect(writes).toBe(1);
    });

    it("is written again once its date has aged enough to mislead", async () => {
        // `at` is read out as when Polaris last managed to ask. Left alone
        // forever it would date a server that stopped a minute ago to whenever
        // its roster was last edited, which is the opposite of what it says.
        storeRoster(ROSTER, "2020-01-01T00:00:00.000Z");
        await rememberRoster(SERVER, ROSTER);
        expect(writes).toBe(1);
    });
});

describe("an answer that has changed", () => {
    it("is written down", async () => {
        await rememberRoster(SERVER, {
            ops: ["ada"],
            whitelist: [],
            bans: [],
            whitelistEnforced: true
        });
        // The field somebody could be hurt by missing: a whitelist that has just
        // been switched off has to reach the note, however recently it was written.
        await rememberRoster(SERVER, {
            ops: ["ada"],
            whitelist: [],
            bans: [],
            whitelistEnforced: false
        });
        expect(writes).toBe(2);
        expect((await rememberedRoster(SERVER))?.roster.whitelistEnforced).toBe(false);
    });

    it("is written down for a ban nobody had before", async () => {
        const base = { ops: [], whitelist: ["ada"], bans: [], whitelistEnforced: true };
        await rememberRoster(SERVER, base);
        await rememberRoster(SERVER, {
            ...base,
            bans: [{ name: "mallory", reason: "griefing", source: "console" }]
        });
        expect(writes).toBe(2);
    });
});

describe("a stored blob nobody can vouch for", () => {
    it("reports a whitelist as enforced only where that was actually stored", async () => {
        // The one field somebody could be hurt by getting wrong: a server drawn
        // as enforcing a whitelist it is not enforcing is a server somebody
        // believes is closed and is not.
        storeRoster({ ops: [], whitelist: ["ada"], bans: [], whitelistEnforced: "true" });
        expect((await rememberedRoster(SERVER))?.roster.whitelistEnforced).toBe(false);

        storeRoster({ ops: [], whitelist: ["ada"], bans: [] });
        expect((await rememberedRoster(SERVER))?.roster.whitelistEnforced).toBe(false);
    });

    it("drops anything in a name list that is not a name", async () => {
        storeRoster({ ops: ["ada", 7, null, ""], whitelist: "everyone", bans: [] });

        const kept = await rememberedRoster(SERVER);
        expect(kept?.roster.ops).toEqual(["ada"]);
        expect(kept?.roster.whitelist).toEqual([]);
    });

    it("keeps a ban that has a name and fills in what it does not have", async () => {
        storeRoster({
            ops: [],
            whitelist: [],
            bans: [{ name: "mallory" }, { reason: "no name, so not a ban" }]
        });

        expect((await rememberedRoster(SERVER))?.roster.bans).toEqual([
            { name: "mallory", reason: null, source: null }
        ]);
    });
});
