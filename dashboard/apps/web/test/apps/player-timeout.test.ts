/**
 * A ban that lifts itself, over whichever game asked for it.
 *
 * The shape is the same everywhere and the failures are the expensive kind: a
 * note written for a ban the server refused reports somebody as excluded who is
 * still playing, and a note forgotten before it was lifted leaves a ten-minute
 * cool-off in place for good. Both are invisible from the screen, which is why
 * they are asserted here rather than trusted to a read of the code.
 *
 * Driven through a fake pair of commands, because that is exactly what a game
 * supplies - Minecraft's `ban`/`pardon`, ARK's `BanPlayer`/`UnbanPlayer` - and
 * nothing else about a game reaches this.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TimeoutCommands } from "@/lib/apps/player-timeout-service";

const OWNER = "11111111-1111-4111-8111-111111111111";
const INSTALL = "aaaaaaaa-1111-4111-8111-111111111111";

/** The install row the service reads and patches, rewritten by every patch so a
 *  second pass sees what the first one wrote. */
let install: { id: string; config: string };

vi.mock("@polaris/db", () => ({
    prisma: {
        installedApp: {
            findUnique: async () => install,
            findFirst: async () => install,
            update: async ({ data }: { data: { config: string } }) => {
                install = { ...install, config: data.config };
                return install;
            }
        }
    }
}));

const { grantTimeout, liftTimeout, sweepTimeouts, readPlayerTimeouts } = await import(
    "@/lib/apps/player-timeout-service"
);
const { timeoutFor, timeoutRemaining } = await import("@/lib/apps/player-timeout");

/** A game that accepts everything, and remembers what it was told. */
function game(overrides: Partial<TimeoutCommands> = {}): TimeoutCommands & {
    banned: { player: string; reason: string }[];
    pardoned: string[];
} {
    const banned: { player: string; reason: string }[] = [];
    const pardoned: string[] = [];
    return {
        banned,
        pardoned,
        ban: async (_owner, _install, player, reason) => void banned.push({ player, reason }),
        pardon: async (_owner, _install, player) => void pardoned.push(player),
        ...overrides
    };
}

beforeEach(() => {
    install = { id: INSTALL, config: "{}" };
});

describe("granting one", () => {
    it("bans first and only then writes the note", async () => {
        const ark = game();
        const entry = await grantTimeout(ark, OWNER, INSTALL, "76561198000000001", 15, "spawn camping");
        expect(ark.banned).toEqual([{ player: "76561198000000001", reason: "spawn camping" }]);
        expect(await readPlayerTimeouts(INSTALL)).toEqual([entry]);
        expect(Date.parse(entry.until) - Date.now()).toBeGreaterThan(14 * 60_000);
    });

    it("says how long it is for when nobody gave a reason", async () => {
        const mc = game();
        await grantTimeout(mc, OWNER, INSTALL, "Alice", 5);
        expect(mc.banned[0]?.reason).toBe("Timed out for 5 minutes");
    });

    it("writes nothing when the server refused the ban", async () => {
        // The one that matters: a note without a ban is the screen reporting
        // somebody as excluded who is still playing.
        const refuses = game({
            ban: async () => {
                throw new Error("The server is not answering");
            }
        });
        await expect(grantTimeout(refuses, OWNER, INSTALL, "Alice", 5)).rejects.toThrow();
        expect(await readPlayerTimeouts(INSTALL)).toEqual([]);
    });

    it("replaces the one already on that player rather than stacking", async () => {
        const mc = game();
        await grantTimeout(mc, OWNER, INSTALL, "Alice", 5);
        await grantTimeout(mc, OWNER, INSTALL, "alice", 60);
        const held = await readPlayerTimeouts(INSTALL);
        expect(held).toHaveLength(1);
        expect(held[0]?.player).toBe("alice");
    });
});

describe("lifting one", () => {
    it("pardons and forgets the note", async () => {
        const mc = game();
        await grantTimeout(mc, OWNER, INSTALL, "Alice", 60);
        await liftTimeout(mc, OWNER, INSTALL, "Alice");
        expect(mc.pardoned).toEqual(["Alice"]);
        expect(await readPlayerTimeouts(INSTALL)).toEqual([]);
    });

    it("forgets the note even when the pardon could not be sent", async () => {
        // Somebody who has already been pardoned by hand. Refusing to forget the
        // note would leave the row claiming a timeout nobody is serving.
        const mc = game({
            pardon: async () => {
                throw new Error("not answering");
            }
        });
        install = { id: INSTALL, config: JSON.stringify({ playerTimeouts: [{ player: "Alice", until: future() }] }) };
        await liftTimeout(mc, OWNER, INSTALL, "Alice");
        expect(await readPlayerTimeouts(INSTALL)).toEqual([]);
    });
});

describe("sweeping", () => {
    it("lifts what has run out and leaves what has not", async () => {
        install = {
            id: INSTALL,
            config: JSON.stringify({
                playerTimeouts: [
                    { player: "Expired", until: past() },
                    { player: "Serving", until: future() }
                ]
            })
        };
        const mc = game();
        expect(await sweepTimeouts(mc, OWNER, INSTALL)).toBe(1);
        expect(mc.pardoned).toEqual(["Expired"]);
        expect((await readPlayerTimeouts(INSTALL)).map((entry) => entry.player)).toEqual(["Serving"]);
    });

    it("keeps the note when the server could not be told", async () => {
        // The failure this whole thing exists to prevent: forget it here and the
        // ban stays on for good.
        install = { id: INSTALL, config: JSON.stringify({ playerTimeouts: [{ player: "Expired", until: past() }] }) };
        const down = game({
            pardon: async () => {
                throw new Error("not answering");
            }
        });
        expect(await sweepTimeouts(down, OWNER, INSTALL)).toBe(0);
        expect(await readPlayerTimeouts(INSTALL)).toHaveLength(1);
    });
});

describe("what a row reads", () => {
    it("finds a player's own timeout whatever case it was written in", () => {
        const held = [{ player: "76561198000000001", until: future() }];
        expect(timeoutFor(held, "76561198000000001")).not.toBeNull();
        expect(timeoutFor([{ player: "Alice", until: future() }], "alice")).not.toBeNull();
        expect(timeoutFor(held, "76561198000000009")).toBeNull();
    });

    it("says how much is left in the units somebody would say out loud", () => {
        const now = Date.parse("2026-08-12T12:00:00.000Z");
        expect(timeoutRemaining("2026-08-12T12:00:20.000Z", now)).toBe("lifting now");
        expect(timeoutRemaining("2026-08-12T12:40:00.000Z", now)).toBe("40m left");
        expect(timeoutRemaining("2026-08-12T20:00:00.000Z", now)).toBe("8h left");
        expect(timeoutRemaining("2026-08-15T12:00:00.000Z", now)).toBe("3d left");
        // Already over, from a sweep that has not run yet.
        expect(timeoutRemaining("2026-08-12T11:00:00.000Z", now)).toBe("lifting now");
    });
});

function future(): string {
    return new Date(Date.now() + 3_600_000).toISOString();
}

function past(): string {
    return new Date(Date.now() - 60_000).toISOString();
}
