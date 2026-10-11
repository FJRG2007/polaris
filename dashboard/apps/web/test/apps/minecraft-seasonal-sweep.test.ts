/**
 * The sweep that tells each Minecraft server which season to show.
 *
 * Pinned: in season a running server with the jar is told on every pass, so a
 * restart is caught; out of season it is told to clear once and then left
 * alone; the operator's switch and the server's own switch clear it; a server
 * whose jar cannot decorate is not asked again on every pass; and a stopped or
 * Bedrock server is never sent anything.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const INSTALL = "aaaaaaaa-1111-4111-8111-111111111111";
const OWNER = "11111111-1111-4111-8111-111111111111";
const HALLOWEEN = new Date("2026-10-20T12:00:00Z");
const NOVEMBER = new Date("2026-11-20T12:00:00Z");

let config: Record<string, unknown> = {};
let allowed = true;
let running = true;
let edition: "java" | "bedrock" = "java";
let caps = new Set<string>(["season"]);
/** Whether an event is running on the server; the stored run itself is the
 *  events' business and is stood in for here. */
let eventRunning = false;
const sent: string[] = [];

vi.mock("@polaris/db", () => ({
    prisma: {
        installedApp: {
            findMany: async () => [{ id: INSTALL, ownerId: OWNER, config: JSON.stringify(config) }],
            findUnique: async () => ({
                id: INSTALL,
                ownerId: OWNER,
                config: JSON.stringify(config)
            })
        }
    }
}));

vi.mock("@polaris/app-host", () => ({
    host: {
        appsInstallConfig: {
            readInstallConfig: (raw: unknown) =>
                typeof raw === "string" ? (JSON.parse(raw) as Record<string, unknown>) : {},
            patchInstallConfig: async (_id: string, patch: Record<string, unknown>) => {
                config = { ...config, ...patch };
            }
        },
        seasonalService: { seasonsAllowed: async () => allowed }
    }
}));

vi.mock("@polaris-app/game-servers/src/lib/minecraft/service", () => ({
    withServerContainer: async (_owner: string, id: string, work: (server: unknown) => unknown) =>
        work({
            installedAppId: id,
            running,
            edition,
            say: async (argv: string[]) => {
                sent.push(argv.join(" "));
                return '{"ok":true}';
            }
        })
}));

vi.mock("@polaris-app/game-servers/src/lib/minecraft/events/in-server", () => ({
    capabilities: async () => caps
}));

vi.mock("@polaris-app/game-servers/src/lib/minecraft/events/state", () => ({
    readEventState: () => ({ run: eventRunning ? { id: "run" } : null })
}));

/** A fresh copy of the service per test: it remembers what each server took. */
async function service() {
    vi.resetModules();
    return import("@polaris-app/game-servers/src/lib/minecraft/seasonal-service");
}

beforeEach(() => {
    config = {};
    allowed = true;
    running = true;
    edition = "java";
    caps = new Set(["season"]);
    eventRunning = false;
    sent.length = 0;
});

describe("the seasons sweep", () => {
    it("tells a running server the season on every pass while it lasts", async () => {
        const { sweepSeasons } = await service();
        await sweepSeasons(HALLOWEEN);
        await sweepSeasons(HALLOWEEN);
        expect(sent).toEqual([
            "polaris season set halloween 3600",
            "polaris season set halloween 3600"
        ]);
    });

    it("clears once when the season ends, then asks nothing", async () => {
        const { sweepSeasons } = await service();
        await sweepSeasons(HALLOWEEN);
        await sweepSeasons(NOVEMBER);
        await sweepSeasons(NOVEMBER);
        expect(sent).toEqual(["polaris season set halloween 3600", "polaris season clear"]);
    });

    it("clears on the operator's switch", async () => {
        const { sweepSeasons } = await service();
        allowed = false;
        await sweepSeasons(HALLOWEEN);
        expect(sent).toEqual(["polaris season clear"]);
    });

    it("clears while an event runs, and comes back after", async () => {
        const { sweepSeasons } = await service();
        eventRunning = true;
        await sweepSeasons(HALLOWEEN);
        eventRunning = false;
        await sweepSeasons(HALLOWEEN);
        expect(sent).toEqual(["polaris season clear", "polaris season set halloween 3600"]);
    });

    it("sends nothing to a stopped or Bedrock server", async () => {
        const { sweepSeasons } = await service();
        running = false;
        await sweepSeasons(HALLOWEEN);
        running = true;
        edition = "bedrock";
        await sweepSeasons(HALLOWEEN);
        expect(sent).toEqual([]);
    });

    it("leaves a server whose jar cannot decorate alone for a while", async () => {
        const { sweepSeasons } = await service();
        caps = new Set();
        await sweepSeasons(HALLOWEEN);
        caps = new Set(["season"]);
        await sweepSeasons(new Date(HALLOWEEN.getTime() + 2 * 60_000));
        expect(sent).toEqual([]);
        await sweepSeasons(new Date(HALLOWEEN.getTime() + 31 * 60_000));
        expect(sent).toEqual(["polaris season set halloween 3600"]);
    });
});

describe("a server's own switch", () => {
    it("turns it off at once and says so", async () => {
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(HALLOWEEN);
        try {
            const { setSeasonal } = await service();
            const view = await setSeasonal(OWNER, INSTALL, false);
            expect(config.seasonalDecorations).toBe(false);
            expect(sent).toEqual(["polaris season clear"]);
            expect(view).toMatchObject({ on: false, showing: null, season: "halloween" });
        } finally {
            vi.useRealTimers();
        }
    });

    it("turns it back on at once", async () => {
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(HALLOWEEN);
        try {
            const { setSeasonal } = await service();
            config = { seasonalDecorations: false };
            const view = await setSeasonal(OWNER, INSTALL, true);
            expect(sent).toEqual(["polaris season set halloween 3600"]);
            expect(view).toMatchObject({ on: true, showing: "halloween" });
        } finally {
            vi.useRealTimers();
        }
    });
});
