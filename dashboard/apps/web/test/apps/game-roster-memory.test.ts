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

vi.mock("@polaris/db", () => ({
    prisma: {
        installedApp: {
            findUnique: async () => ({ config: stored }),
            update: async (args: { data: { config: string } }) => {
                stored = args.data.config;
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
