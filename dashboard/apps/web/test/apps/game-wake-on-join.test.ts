/**
 * A sleeping server started by somebody trying to join it.
 *
 * This is the half of "sleep when nobody is playing" that was missing: the
 * schedule could stop a server and nothing could bring it back except a person
 * opening Polaris. A stopped server has no port open, so the only thing that can
 * see the attempt is the router in front of it - a Java client names the address
 * it dialled in the handshake, in the clear, before it logs in.
 *
 * Run end to end on real Docker on 2026-09-23 - a Paper 1.21.4 server stopped
 * behind itzg/mc-router 1.46.2, with the knock answered by a stand-in that did
 * what `wakeForJoin` does:
 *
 *   - a status ping while it slept was answered by the router itself, with the
 *     asleep message and no webhook at all. That is why a client sitting on the
 *     multiplayer screen does not keep starting an empty world.
 *   - a login attempt posted `{"action":"up","serverAddress":"sleepy.example.com",
 *     "backend":"127.0.0.1:25777"}` and the container was running a moment later.
 *   - that player's own connection ended straight away rather than waiting, so
 *     what they do is join again once it has loaded. The screen says so.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GameSchedule } from "@polaris-app/game-servers/src/lib/minecraft/schedule";

const OWNER = "11111111-1111-4111-8111-111111111111";
const INSTALL = "aaaaaaaa-1111-4111-8111-111111111111";
const APPLICATION = "bbbbbbbb-1111-4111-8111-111111111111";

let install: {
    id: string;
    ownerId: string;
    applicationId: string | null;
    catalogId: string;
    config: string;
};
let desiredState: string;
let ran: { applicationId: string; running: boolean; }[] = [];

vi.mock("@polaris/db", () => ({
    prisma: {
        installedApp: {
            findMany: async () => [install],
            findUnique: async () => install,
            update: async ({ data }: { data: { config: string; }; }) => {
                install = { ...install, config: data.config };
                return install;
            },
            updateMany: async ({ data }: { data: { config: string; }; }) => {
                install = { ...install, config: data.config };
                return { count: 1 };
            }
        },
        application: {
            findUnique: async () => ({ desiredState })
        }
    }
}));

vi.mock("@/lib/deploy-service", () => ({
    setApplicationRunning: async (applicationId: string, _ownerId: string, running: boolean) => {
        ran.push({ applicationId, running });
    }
}));

const { wakeForJoin } = await import("@polaris-app/game-servers/src/lib/minecraft/wake-service");
const { WOKEN_AT_KEY } = await import("@polaris-app/game-servers/src/lib/minecraft/schedule");

/** Asleep overnight, which is the rule this feature exists for. */
const OVERNIGHT: GameSchedule = {
    enabled: true,
    timezone: "UTC",
    otherwise: "on",
    idleMinutes: 30,
    windows: [{ days: [], from: "00:00", to: "10:00", mode: "sleep" }]
};

function setUp(config: Record<string, unknown> = {}): void {
    install = {
        id: INSTALL,
        ownerId: OWNER,
        applicationId: APPLICATION,
        catalogId: "minecraft",
        config: JSON.stringify({ routed: true, hostname: "survival.mc.example.com", ...config })
    };
    desiredState = "stopped";
    ran = [];
}

beforeEach(() => setUp());

describe("somebody knocks on a server that is asleep", () => {
    it("starts it", async () => {
        expect(await wakeForJoin("survival.mc.example.com")).toBe("started");
        expect(ran).toEqual([{ applicationId: APPLICATION, running: true }]);
    });

    it("says so on the schedule screen, since nobody here pressed start", async () => {
        const at = new Date("2026-09-23T21:15:00.000Z");
        await wakeForJoin("survival.mc.example.com", at);
        expect(JSON.parse(install.config)[WOKEN_AT_KEY]).toBe(at.toISOString());
    });

    it("reads the name the player dialled however they typed it", async () => {
        expect(await wakeForJoin("  SURVIVAL.MC.EXAMPLE.COM  ")).toBe("started");
    });

    it("leaves a server that is already up alone", async () => {
        desiredState = "running";
        expect(await wakeForJoin("survival.mc.example.com")).toBe("running");
        expect(ran).toEqual([]);
    });

    it("knows nothing about a name that is not one of ours", async () => {
        expect(await wakeForJoin("someone-elses.example.com")).toBe("unknown");
        expect(ran).toEqual([]);
    });

    it("will not start a server that is not routed", async () => {
        // Its port is its own, so nothing was holding it while it was down and a
        // knock claiming otherwise did not come from a player of this server.
        setUp({ routed: false });
        expect(await wakeForJoin("survival.mc.example.com")).toBe("unknown");
        expect(ran).toEqual([]);
    });

    it("does not start one whose owner turned that off", async () => {
        setUp({ wakeOnJoin: false });
        expect(await wakeForJoin("survival.mc.example.com")).toBe("refused");
        expect(ran).toEqual([]);
    });
});

describe("what the schedule still decides", () => {
    it("keeps a server down that a window says to keep down", async () => {
        // "Keep stopped" is the one window that means it. A player knocking is not
        // a reason to overrule the person who wrote it.
        setUp({ schedule: { ...OVERNIGHT, otherwise: "off", windows: [] } });
        expect(await wakeForJoin("survival.mc.example.com")).toBe("kept-stopped");
        expect(ran).toEqual([]);
    });

    it("starts one inside a sleeping window, which is the whole point", async () => {
        setUp({ schedule: OVERNIGHT });
        expect(await wakeForJoin("survival.mc.example.com", new Date("2026-09-23T03:00:00.000Z"))).toBe(
            "started"
        );
    });

    it("starts one with no schedule at all", async () => {
        setUp({ schedule: { ...OVERNIGHT, enabled: false } });
        expect(await wakeForJoin("survival.mc.example.com")).toBe("started");
    });
});
