/**
 * The sweep that tells each Minecraft server which season to show.
 *
 * Pinned: in season a running server with the jar is told on every pass, so a
 * restart is caught; out of season it is told to clear once and then left
 * alone; the operator's switch and the server's own switch clear it; a server
 * whose jar cannot decorate is not asked again on every pass, and says whether a
 * restart helps; a console that did not answer is asked again on the next pass;
 * a stopped or Bedrock server is never sent anything; and a server stopped out
 * of season is told to clear once it is back, for what its jar kept.
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
/** Who answered `polaris caps`. */
let answer: "polaris" | "other" | "none" = "polaris";
/** Whether an event is running on the server; the stored run itself is the
 *  events' business and is stood in for here. */
let eventRunning = false;
/** The servers a sweep finds; one by default. */
let rows: { id: string; ownerId: string; config: string }[] | null = null;
/** Another writer's change, landing between a save's read and its write. */
let meanwhile: Record<string, unknown> | null = null;
const sent: string[] = [];
/** Each `sayAll` call's lines, as one batch: one console command per line. */
const batches: string[][] = [];

vi.mock("@polaris/db", () => ({
    prisma: {
        installedApp: {
            findMany: async () =>
                rows ?? [{ id: INSTALL, ownerId: OWNER, config: JSON.stringify(config) }],
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
            patchInstallConfig: async (
                _id: string,
                patch:
                    | Record<string, unknown>
                    | ((current: Record<string, unknown>) => Record<string, unknown>)
            ) => {
                if (meanwhile) config = { ...config, ...meanwhile };
                meanwhile = null;
                config = { ...config, ...(typeof patch === "function" ? patch(config) : patch) };
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
            // As the console tool does: `say` is one command, its words joined
            // with spaces; `sayAll` is one command per line.
            say: async (argv: string[]) => {
                sent.push(argv.join(" "));
                return '{"ok":true}';
            },
            sayAll: async (lines: string[]) => {
                batches.push([...lines]);
                sent.push(...lines);
            }
        })
}));

vi.mock("@polaris-app/game-servers/src/lib/minecraft/events/in-server", () => ({
    capsReading: async () => ({ caps, answer }),
    forgetCapabilities: () => undefined
}));

vi.mock("@polaris-app/game-servers/src/lib/minecraft/speech-service", () => ({
    homeLanguage: async () => "en"
}));

vi.mock("@polaris-app/game-servers/src/lib/minecraft/events/state", async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
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
    answer = "polaris";
    eventRunning = false;
    rows = null;
    meanwhile = null;
    sent.length = 0;
    batches.length = 0;
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

    it("clears a server that was stopped when the season ended, once it is back", async () => {
        const { sweepSeasons } = await service();
        running = false;
        await sweepSeasons(NOVEMBER);
        running = true;
        await sweepSeasons(new Date(NOVEMBER.getTime() + 2 * 60_000));
        expect(sent).toEqual([]);
        await sweepSeasons(new Date(NOVEMBER.getTime() + 12 * 60_000));
        await sweepSeasons(new Date(NOVEMBER.getTime() + 24 * 60_000));
        expect(sent).toEqual(["polaris season clear"]);
    });

    it("leaves a server with no Polaris jar alone for a while", async () => {
        const { sweepSeasons } = await service();
        answer = "other";
        caps = new Set();
        await sweepSeasons(HALLOWEEN);
        answer = "polaris";
        caps = new Set(["season"]);
        await sweepSeasons(new Date(HALLOWEEN.getTime() + 2 * 60_000));
        expect(sent).toEqual([]);
        await sweepSeasons(new Date(HALLOWEEN.getTime() + 31 * 60_000));
        expect(sent).toEqual(["polaris season set halloween 3600"]);
    });

    it("decorates within a pass of a restart onto a jar that can", async () => {
        // The operator updates Polaris, then restarts the server onto the newer jar
        // it keeps there. The pass before the restart found the older jar; the one
        // after it must not wait half an hour to notice.
        const { sweepSeasons, seasonalView } = await service();
        caps = new Set(["stash"]);
        await sweepSeasons(HALLOWEEN);
        caps = new Set(["stash", "season"]);
        await sweepSeasons(new Date(HALLOWEEN.getTime() + 60_000));
        expect(sent).toEqual([]);
        await sweepSeasons(new Date(HALLOWEEN.getTime() + 2 * 60_000 - 5_000));
        expect(sent).toEqual(["polaris season set halloween 3600"]);
        expect(await seasonalView(INSTALL)).toMatchObject({ needsRestart: false });
    });

    it("asks a console that did not answer again on the next pass", async () => {
        const { sweepSeasons, seasonalView } = await service();
        answer = "none";
        caps = new Set();
        await sweepSeasons(HALLOWEEN);
        expect(await seasonalView(INSTALL)).toMatchObject({
            needsRestart: false,
            unavailable: false
        });
        answer = "polaris";
        caps = new Set(["season"]);
        await sweepSeasons(new Date(HALLOWEEN.getTime() + 2 * 60_000));
        expect(sent).toEqual(["polaris season set halloween 3600"]);
    });

    it("says a restart helps only where an older Polaris jar answered", async () => {
        const { sweepSeasons, seasonalView } = await service();
        caps = new Set(["stash"]);
        await sweepSeasons(HALLOWEEN);
        expect(await seasonalView(INSTALL)).toMatchObject({
            needsRestart: true,
            unavailable: false
        });
    });

    it("says a server with no Polaris jar cannot show them", async () => {
        const { sweepSeasons, seasonalView } = await service();
        answer = "other";
        caps = new Set();
        await sweepSeasons(HALLOWEEN);
        expect(await seasonalView(INSTALL)).toMatchObject({
            needsRestart: false,
            unavailable: true
        });
        expect(sent).toEqual([]);
    });

    it("tells every server in a sweep", async () => {
        const { sweepSeasons } = await service();
        const many = Array.from({ length: 20 }, (_, index) => ({
            id: `server-${index}`,
            ownerId: OWNER,
            config: JSON.stringify(config)
        }));
        rows = many;
        expect(await sweepSeasons(HALLOWEEN)).toEqual({ told: 20 });
        expect(sent).toHaveLength(20);
    });
});

describe("a server's own switch", () => {
    it("turns it off at once and says so", async () => {
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(HALLOWEEN);
        try {
            const { setSeasonal } = await service();
            const view = await setSeasonal(OWNER, INSTALL, { on: false });
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
            const view = await setSeasonal(OWNER, INSTALL, { on: true });
            expect(sent).toEqual(["polaris season set halloween 3600"]);
            expect(view).toMatchObject({ on: true, showing: "halloween" });
        } finally {
            vi.useRealTimers();
        }
    });
});

describe("the seasonal mobs", () => {
    it("go on the line to a jar that takes them", async () => {
        caps = new Set(["season", "season-mobs"]);
        config = { seasonalNightSpawns: 2 };
        const { sweepSeasons, seasonalView } = await service();
        await sweepSeasons(HALLOWEEN);
        expect(sent).toEqual(["polaris season set halloween 3600 200 100"]);
        expect(await seasonalView(INSTALL)).toMatchObject({
            nightSpawns: 2,
            snowGolems: 1,
            mobsNeedRestart: false
        });
    });

    it("are left off for an older jar, which still decorates and says a restart brings them", async () => {
        const { sweepSeasons, seasonalView } = await service();
        await sweepSeasons(HALLOWEEN);
        expect(sent).toEqual(["polaris season set halloween 3600"]);
        expect(await seasonalView(INSTALL)).toMatchObject({
            needsRestart: false,
            mobsNeedRestart: true
        });
    });

    it("change at once on a save, keeping the switch as it was", async () => {
        caps = new Set(["season", "season-mobs"]);
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(HALLOWEEN);
        try {
            const { setSeasonal } = await service();
            const view = await setSeasonal(OWNER, INSTALL, { snowGolems: 2, nightSpawns: 3 });
            expect(config).toEqual({ seasonalSnowGolems: 2, seasonalNightSpawns: 3 });
            expect(sent).toEqual(["polaris season set halloween 3600 300 200"]);
            expect(view).toMatchObject({ on: true, nightSpawns: 3, snowGolems: 2 });
        } finally {
            vi.useRealTimers();
        }
    });

    it("are cleared with everything else out of season", async () => {
        caps = new Set(["season", "season-mobs"]);
        const { sweepSeasons } = await service();
        await sweepSeasons(HALLOWEEN);
        await sweepSeasons(NOVEMBER);
        expect(sent).toEqual(["polaris season set halloween 3600 100 100", "polaris season clear"]);
    });
});

describe("the Halloween extras", () => {
    it("tell the jar when the season ends, so its graveyards outlast a restart", async () => {
        caps = new Set(["season", "season-halloween"]);
        const { sweepSeasons } = await service();
        await sweepSeasons(HALLOWEEN);
        expect(sent).toHaveLength(2);
        expect(sent[0]).toBe("polaris season set halloween 3600");
        expect(sent[1]).toMatch(/^polaris season halloween /);
        expect(sent[1]).toContain(` left=${14 * 86_400 - 12 * 3600} `);
    });

    it("reach a jar that takes them as commands of their own, the season first", async () => {
        // What the live jar lists. Sent as one line, the season and the extras
        // were refused together and the server showed nothing all season.
        caps = new Set(["season", "season-mobs", "season-halloween"]);
        const { sweepSeasons } = await service();
        await sweepSeasons(HALLOWEEN);
        expect(sent).toHaveLength(2);
        expect(sent[0]).toBe("polaris season set halloween 3600 100 100");
        for (const line of sent) expect(line.match(/polaris /g)).toHaveLength(1);
    });

    it("take the graveyards down at once when switched off, but not for an event", async () => {
        caps = new Set(["season", "season-halloween"]);
        const { sweepSeasons, setSeasonal } = await service();
        eventRunning = true;
        await sweepSeasons(HALLOWEEN);
        expect(sent).toEqual(["polaris season clear"]);
        eventRunning = false;
        sent.length = 0;
        allowed = false;
        await sweepSeasons(HALLOWEEN);
        await sweepSeasons(HALLOWEEN);
        expect(sent).toHaveLength(2);
        expect(sent[0]).toMatch(/^polaris season halloween .* graves=0 left=0 /);
        expect(sent[1]).toBe("polaris season clear");
        allowed = true;
        sent.length = 0;
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(HALLOWEEN);
        try {
            await setSeasonal(OWNER, INSTALL, { on: false });
            expect(sent).toHaveLength(2);
            expect(sent[0]).toMatch(/^polaris season halloween .* graves=0 left=0 /);
            expect(sent[1]).toBe("polaris season clear");
        } finally {
            vi.useRealTimers();
        }
    });

    it("send nothing extra when switched off out of season", async () => {
        caps = new Set(["season", "season-halloween"]);
        allowed = false;
        const { sweepSeasons } = await service();
        await sweepSeasons(NOVEMBER);
        expect(sent).toEqual(["polaris season clear"]);
    });

    it("merge a save into what another writer stored meanwhile", async () => {
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(HALLOWEEN);
        try {
            const { setSeasonal } = await service();
            meanwhile = { seasonalHalloween: { witches: 3 } };
            await setSeasonal(OWNER, INSTALL, { halloween: { graves: 2 } });
            expect(config.seasonalHalloween).toMatchObject({ witches: 3, graves: 2 });
        } finally {
            vi.useRealTimers();
        }
    });
});

describe("Christmas and New Year's Eve", () => {
    const CHRISTMAS = new Date("2026-12-20T12:00:00Z");

    it("ride on the winter line to a jar that takes them", async () => {
        caps = new Set(["season", "season-mobs", "season-winter"]);
        config = { seasonalWinter: { elves: 0, santa: false } };
        const { sweepSeasons, seasonalView } = await service();
        await sweepSeasons(CHRISTMAS);
        // One `sayAll`, the season first: the jar refuses the winter line
        // unless it already shows the winter, and the two joined into one
        // command would be refused whole.
        expect(batches).toEqual([
            [
                "polaris season set winter 3600 100 100",
                "polaris season winter golems=100 snow=100 reindeer=100 elves=0 snowmen=100 presents=1 santa=0 lights=1 eve=1 newyear=1 sparkles=1 christmas=1 day=20261220 " +
                    `eveat=${Date.parse("2026-12-25T00:00:00Z")} nyat=${Date.parse("2027-01-01T00:00:00Z")} lang=en`
            ]
        ]);
        // The jar splits the winter line on spaces and takes every token as
        // key=value: exactly the sixteen keys it knows, each once.
        const tokens = sent[1]!.split(" ").slice(3);
        expect(tokens.map((token) => token.split("=")[0])).toEqual([
            "golems",
            "snow",
            "reindeer",
            "elves",
            "snowmen",
            "presents",
            "santa",
            "lights",
            "eve",
            "newyear",
            "sparkles",
            "christmas",
            "day",
            "eveat",
            "nyat",
            "lang"
        ]);
        for (const token of tokens) expect(token).toMatch(/^[a-z]+=(\d+|en|es)$/);
        expect(await seasonalView(INSTALL)).toMatchObject({
            winter: { elves: 0, santa: false, presents: true },
            winterNeedsRestart: false
        });
    });

    it("are told again on every pass, so a restarted server has them back", async () => {
        caps = new Set(["season", "season-mobs", "season-winter"]);
        const { sweepSeasons } = await service();
        await sweepSeasons(CHRISTMAS);
        await sweepSeasons(CHRISTMAS);
        expect(batches).toHaveLength(2);
        for (const batch of batches) {
            expect(batch).toHaveLength(2);
            expect(batch[0]).toBe("polaris season set winter 3600 100 100");
            expect(batch[1]).toMatch(/^polaris season winter /);
        }
    });

    it("are left off for an older jar, which says a restart brings them", async () => {
        caps = new Set(["season", "season-mobs"]);
        const { sweepSeasons, seasonalView } = await service();
        await sweepSeasons(CHRISTMAS);
        expect(sent).toEqual(["polaris season set winter 3600 100 100"]);
        expect(await seasonalView(INSTALL)).toMatchObject({ winterNeedsRestart: true });
    });

    it("are not sent at Halloween", async () => {
        caps = new Set(["season", "season-mobs", "season-winter"]);
        const { sweepSeasons, seasonalView } = await service();
        await sweepSeasons(HALLOWEEN);
        expect(sent).toEqual(["polaris season set halloween 3600 100 100"]);
        expect(await seasonalView(INSTALL)).toMatchObject({ winterNeedsRestart: false });
    });

    it("save one setting at a time and keep the others", async () => {
        caps = new Set(["season", "season-mobs", "season-winter"]);
        config = { seasonalWinter: { elves: 0 } };
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(CHRISTMAS);
        try {
            const { setSeasonal } = await service();
            const view = await setSeasonal(OWNER, INSTALL, { winter: { reindeer: 2 } });
            expect(config.seasonalWinter).toMatchObject({ elves: 0, reindeer: 2, santa: true });
            expect(sent[1]).toContain("reindeer=200 elves=0");
            expect(view.winter).toMatchObject({ elves: 0, reindeer: 2 });
        } finally {
            vi.useRealTimers();
        }
    });
});
