/**
 * A timeout, in ARK's own commands.
 *
 * Two things about this game make the binding worth asserting rather than
 * reading. Its ban takes an id and nothing else, so the reason somebody typed has
 * to be said to the player before they are thrown out or it is silently dropped -
 * and it has to be best effort, because somebody who is not on the server cannot
 * be told anything and that must not stop the ban. And everything is keyed by
 * Steam id: a character can be renamed at will, so a timeout keyed by name would
 * lift for whoever holds that name a week later.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const OWNER = "11111111-1111-4111-8111-111111111111";
const INSTALL = "aaaaaaaa-1111-4111-8111-111111111111";
const STEAM_ID = "76561198000000001";

let install: { id: string; config: string };
/** Every command the binding sent, in order. The order is the point. */
let sent: string[];
/** Whether the player can be reached in chat at all. */
let reachable: boolean;

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

vi.mock("@/lib/apps/ark/service", () => ({
    messageArkPlayer: async (_owner: string, _install: string, steamId: string, message: string) => {
        if (!reachable) throw new Error("Nobody by that id is on the server");
        sent.push(`ServerChatTo ${steamId} ${message}`);
    },
    banArkPlayer: async (_owner: string, _install: string, steamId: string) => void sent.push(`BanPlayer ${steamId}`),
    unbanArkPlayer: async (_owner: string, _install: string, steamId: string) => void sent.push(`UnbanPlayer ${steamId}`)
}));

const { timeoutArkPlayer, liftArkTimeout, sweepArkTimeouts } = await import("@/lib/apps/ark/timeout-service");
const { readPlayerTimeouts } = await import("@/lib/apps/player-timeout-service");

beforeEach(() => {
    install = { id: INSTALL, config: "{}" };
    sent = [];
    reachable = true;
});

describe("timing an ARK player out", () => {
    it("tells them why before it throws them out", async () => {
        await timeoutArkPlayer(OWNER, INSTALL, STEAM_ID, 15, "spawn camping");
        expect(sent).toEqual([`ServerChatTo ${STEAM_ID} spawn camping`, `BanPlayer ${STEAM_ID}`]);
    });

    it("bans anyway when they cannot be told", async () => {
        reachable = false;
        await timeoutArkPlayer(OWNER, INSTALL, STEAM_ID, 15, "spawn camping");
        expect(sent).toEqual([`BanPlayer ${STEAM_ID}`]);
        expect(await readPlayerTimeouts(INSTALL)).toHaveLength(1);
    });

    it("records it against the Steam id, not the name they were playing under", async () => {
        await timeoutArkPlayer(OWNER, INSTALL, STEAM_ID, 60);
        expect((await readPlayerTimeouts(INSTALL))[0]?.player).toBe(STEAM_ID);
    });
});

describe("ending one", () => {
    it("unbans and forgets the note when it is lifted early", async () => {
        await timeoutArkPlayer(OWNER, INSTALL, STEAM_ID, 60);
        sent = [];
        await liftArkTimeout(OWNER, INSTALL, STEAM_ID);
        expect(sent).toEqual([`UnbanPlayer ${STEAM_ID}`]);
        expect(await readPlayerTimeouts(INSTALL)).toEqual([]);
    });

    it("unbans by itself once it has run out", async () => {
        install = {
            id: INSTALL,
            config: JSON.stringify({
                playerTimeouts: [{ player: STEAM_ID, until: new Date(Date.now() - 60_000).toISOString() }]
            })
        };
        expect(await sweepArkTimeouts(OWNER, INSTALL)).toBe(1);
        expect(sent).toEqual([`UnbanPlayer ${STEAM_ID}`]);
        expect(await readPlayerTimeouts(INSTALL)).toEqual([]);
    });
});
