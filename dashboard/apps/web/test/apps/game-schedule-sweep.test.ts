/**
 * The sweep that actually stops a server, driven over an ARK install.
 *
 * The pure decision is covered in `game-schedule.test.ts`; what is asserted here is
 * everything between that decision and the container: that the schedule is read off
 * the install, that the player count is asked in the right game's language, that the
 * emptiness clock is written where the next pass looks for it, and that a stop
 * reaches the deploy. Each of those was a place a schedule could be set on screen and
 * silently do nothing.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GameSchedule } from "@/lib/apps/minecraft/schedule";

const OWNER = "11111111-1111-4111-8111-111111111111";
const INSTALL = "aaaaaaaa-1111-4111-8111-111111111111";
const APPLICATION = "bbbbbbbb-1111-4111-8111-111111111111";

/** The install row the sweep reads, config included, rewritten by every patch so a
 *  second pass sees what the first one wrote. */
let install: { id: string; applicationId: string; catalogId: string; config: string };
let desiredState: string;
/** What the running server answered, and how - `null` for one that is not. */
let arkPlayers: { answering: boolean; players: { steamId: string; name: string }[] } | null;
let ran: { applicationId: string; running: boolean }[] = [];
let flushed: string[] = [];

vi.mock("@polaris/db", () => ({
    prisma: {
        installedApp: {
            findMany: async () => [install],
            findUnique: async () => install,
            findFirst: async () => install,
            update: async ({ data }: { data: { config: string } }) => {
                install = { ...install, config: data.config };
                return install;
            }
        },
        application: {
            findFirst: async () => ({ desiredState }),
            findUnique: async () => ({ desiredState })
        }
    }
}));

vi.mock("@/lib/deploy-service", () => ({
    setApplicationRunning: async (applicationId: string, _ownerId: string, running: boolean) => {
        ran.push({ applicationId, running });
    }
}));

vi.mock("@/lib/apps/games-flush", () => ({
    flushGameWorld: async (_ownerId: string, installedAppId: string) => {
        flushed.push(installedAppId);
    }
}));

vi.mock("@/lib/apps/ark/service", () => ({
    getArkPlayers: async () => arkPlayers ?? { answering: false, containerRunning: null, players: [], message: "no" }
}));

vi.mock("@/lib/apps/minecraft/service", () => ({
    getServerPlayers: async () => {
        throw new Error("an ARK server must never be asked over rcon-cli");
    }
}));

const { sweepGameSchedules } = await import("@/lib/apps/minecraft/schedule-service");

/** Sleep once nobody has played for five minutes, which is what the screen writes
 *  when somebody types 5 into "Empty for". */
const SLEEP: GameSchedule = {
    enabled: true,
    timezone: "Europe/Madrid",
    otherwise: "sleep",
    idleMinutes: 5,
    windows: []
};

function setUp(schedule: GameSchedule, config: Record<string, unknown> = {}): void {
    install = {
        id: INSTALL,
        applicationId: APPLICATION,
        catalogId: "ark",
        config: JSON.stringify({ schedule, ...config })
    };
    desiredState = "running";
    arkPlayers = { answering: true, players: [] };
    ran = [];
    flushed = [];
}

beforeEach(() => setUp(SLEEP));

describe("sweepGameSchedules over an ARK server", () => {
    it("starts the clock on the first empty pass and stops nothing yet", async () => {
        const swept = await sweepGameSchedules(OWNER, new Date("2026-08-11T12:00:00Z"));
        expect(swept.stopped).toBe(0);
        expect(ran).toEqual([]);
        expect(JSON.parse(install.config).emptySince).toBe("2026-08-11T12:00:00.000Z");
    });

    it("stops it once it has been empty for as long as the schedule says", async () => {
        await sweepGameSchedules(OWNER, new Date("2026-08-11T12:00:00Z"));
        const swept = await sweepGameSchedules(OWNER, new Date("2026-08-11T12:06:00Z"));
        expect(swept.stopped).toBe(1);
        expect(ran).toEqual([{ applicationId: APPLICATION, running: false }]);
        expect(flushed).toEqual([INSTALL]);
    });

    it("leaves it alone while somebody is playing", async () => {
        arkPlayers = { answering: true, players: [{ steamId: "76561198000000000", name: "Pau" }] };
        await sweepGameSchedules(OWNER, new Date("2026-08-11T12:00:00Z"));
        await sweepGameSchedules(OWNER, new Date("2026-08-11T12:30:00Z"));
        expect(ran).toEqual([]);
        expect(JSON.parse(install.config).emptySince ?? null).toBeNull();
    });

    it("does not stop a server that is only failing to answer", async () => {
        // A server still unpacking thirty gigabytes answers nothing, and reading
        // that as "empty" stops an install halfway through its first start.
        arkPlayers = { answering: false, players: [] };
        await sweepGameSchedules(OWNER, new Date("2026-08-11T12:00:00Z"));
        await sweepGameSchedules(OWNER, new Date("2026-08-11T12:30:00Z"));
        expect(ran).toEqual([]);
    });

    it("stops it at once when the schedule says keep stopped", async () => {
        setUp({ ...SLEEP, otherwise: "off" });
        const swept = await sweepGameSchedules(OWNER, new Date("2026-08-11T12:00:00Z"));
        expect(swept.stopped).toBe(1);
        expect(ran).toEqual([{ applicationId: APPLICATION, running: false }]);
    });

    it("does nothing at all while the schedule is off", async () => {
        setUp({ ...SLEEP, enabled: false, otherwise: "off" });
        await sweepGameSchedules(OWNER, new Date("2026-08-11T12:00:00Z"));
        expect(ran).toEqual([]);
    });

    it("writes down that it looked, so a schedule nobody is following can be told apart", async () => {
        // The difference between a schedule that fires and one nothing ever runs is
        // invisible from a screen: both just sit there. This is the evidence.
        await sweepGameSchedules(OWNER, new Date("2026-08-11T12:00:00Z"));
        expect(JSON.parse(install.config).scheduleCheckedAt).toBe("2026-08-11T12:00:00.000Z");
    });

    it("takes a caller's silence as silence rather than as an empty world", async () => {
        // The Game servers page reads every server at once and hands the counts
        // over. A server it could not reach is null there, and nought would be the
        // sweep stopping something it was never told about.
        const options = { known: new Map([[INSTALL, null]]) };
        await sweepGameSchedules(OWNER, new Date("2026-08-11T12:00:00Z"), options);
        await sweepGameSchedules(OWNER, new Date("2026-08-11T12:30:00Z"), options);
        expect(ran).toEqual([]);
    });

    it("can be pointed at one server, for the page that server is open on", async () => {
        const swept = await sweepGameSchedules(OWNER, new Date("2026-08-11T12:00:00Z"), {
            only: INSTALL,
            known: new Map([[INSTALL, 3]])
        });
        // Three people on it, from the count the caller had already paid for, so
        // nothing is asked of the server and nothing is stopped.
        expect(swept).toEqual({ started: 0, stopped: 0, restarted: 0 });
        expect(JSON.parse(install.config).emptySince ?? null).toBeNull();
    });
});
