/**
 * The loop that notices a published build.
 *
 * Two rules matter here and neither is visible from a single run. The first is
 * that everything happens once per build: during a rollover two web containers
 * serve at the same time and both run this loop, so a fact kept anywhere but the
 * database would announce twice and, far worse, start two updates at once. The
 * settings rows here behave like the real ones - a conditional write only one
 * caller can win - so a second pass has to come away with nothing.
 *
 * The second is that a schedule is counted from when the build appeared. A
 * deployment set to install at 05:00 must not install a build the moment it is
 * published at 14:00, and must not forget it either.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UpdateStatus } from "../../src/lib/update-service";

const SHA = "abc1234";

/** The Setting table, with the two write shapes the watcher relies on. */
const rows = new Map<string, string>();

const setting = {
    findUnique: vi.fn(async ({ where }: { where: { key: string; }; }) =>
        rows.has(where.key) ? { value: rows.get(where.key) } : null
    ),
    create: vi.fn(async ({ data }: { data: { key: string; value: string; }; }) => {
        if (rows.has(data.key)) throw new Error("Unique constraint failed on the fields: (`key`)");
        rows.set(data.key, data.value);
        return data;
    }),
    updateMany: vi.fn(
        async ({
            where,
            data
        }: {
            where: { key: string; value?: { startsWith: string; }; NOT?: { value: { startsWith: string; }; }; };
            data: { value: string; };
        }) => {
            const current = rows.get(where.key);
            if (current === undefined) return { count: 0 };
            if (where.value && !current.startsWith(where.value.startsWith)) return { count: 0 };
            if (where.NOT && current.startsWith(where.NOT.value.startsWith)) return { count: 0 };
            rows.set(where.key, data.value);
            return { count: 1 };
        }
    ),
    upsert: vi.fn(async ({ where, create }: { where: { key: string; }; create: { value: string; }; }) => {
        rows.set(where.key, create.value);
        return create;
    }),
    deleteMany: vi.fn(async ({ where }: { where: { key: string; }; }) => {
        rows.delete(where.key);
        return { count: 1 };
    })
};

const notify = vi.fn(async () => {});
const startHostUpdate = vi.fn(async () => "started" as const);
/** What the host is told to run, which every start has to publish first. */
const publishUpdateSource = vi.fn(async (_source: string) => {});
const lastUpdateOutcome = vi.fn(async () => null as { exitCode: number | null; endedAt: number; } | null);
let status: UpdateStatus;

vi.mock("@polaris/db", () => ({ prisma: { setting } }));
vi.mock("@polaris/auth", () => ({ usersWithPermission: async () => ["user-1", "user-2"] }));
vi.mock("@/lib/notifications/dispatch", () => ({ notify: (input: unknown) => notify(input as never) }));
vi.mock("@/lib/update-service", () => ({ getUpdateStatus: async () => status }));
vi.mock("@/lib/update-runner", () => ({
    startHostUpdate: () => startHostUpdate(),
    publishUpdateSource: (source: string) => publishUpdateSource(source),
    lastUpdateOutcome: () => lastUpdateOutcome(),
    updateTriggerReason: () => "The host agent could not be reached."
}));

const { checkForUpdate, saveAutoUpdatePolicy } = await import("../../src/lib/update-watcher");

function available(latest: string | null = SHA): UpdateStatus {
    return {
        phase: latest ? "available" : "unknown",
        current: "0000000",
        latest,
        behindBy: 3,
        upToDate: false,
        buildingCount: null,
        publishedAt: null,
        checks: "passed",
        checksUrl: null,
        url: "https://github.com/example/polaris",
        checkedAt: new Date().toISOString()
    };
}

/** Every alert raised so far, by event id. */
function raised(event: string): { title: string; body: string; }[] {
    return notify.mock.calls
        .map(([input]) => input as unknown as { event: string; title: string; body: string; })
        .filter((input) => input.event === event);
}

beforeEach(() => {
    rows.clear();
    notify.mockClear();
    startHostUpdate.mockClear();
    publishUpdateSource.mockClear();
    startHostUpdate.mockResolvedValue("started");
    lastUpdateOutcome.mockResolvedValue(null);
    status = available();
});

describe("announcing a build", () => {
    it("tells everyone who can install it, once, however many passes run", async () => {
        await saveAutoUpdatePolicy({ mode: "off", at: "05:00" });
        await checkForUpdate();
        await checkForUpdate();
        await checkForUpdate();

        const alerts = raised("system.update");
        // Two recipients, one build: two alerts and no repeats.
        expect(alerts).toHaveLength(2);
        expect(alerts[0]?.body).toContain(SHA);
    });

    it("announces the next build as well, so only a repeat is suppressed", async () => {
        await saveAutoUpdatePolicy({ mode: "off", at: "05:00" });
        await checkForUpdate();
        status = available("def5678");
        await checkForUpdate();
        expect(raised("system.update")).toHaveLength(4);
    });

    it("says nothing while there is nothing to install", async () => {
        status = { ...available(), phase: "building" };
        await checkForUpdate();
        status = { ...available(), phase: "blocked" };
        await checkForUpdate();
        status = available(null);
        await checkForUpdate();
        expect(notify).not.toHaveBeenCalled();
        expect(startHostUpdate).not.toHaveBeenCalled();
    });
});

describe("installing on its own", () => {
    it("installs nothing while the schedule is off", async () => {
        await saveAutoUpdatePolicy({ mode: "off", at: "05:00" });
        await checkForUpdate();
        expect(startHostUpdate).not.toHaveBeenCalled();
    });

    it("installs a published build straight away when told to, and only once", async () => {
        await saveAutoUpdatePolicy({ mode: "immediate", at: "05:00" });
        await checkForUpdate();
        await checkForUpdate();
        expect(startHostUpdate).toHaveBeenCalledTimes(1);
        expect(raised("system.updated")).toHaveLength(2);
    });

    it("tells the host which kind of update to run before starting one", async () => {
        await saveAutoUpdatePolicy({ mode: "immediate", at: "05:00" });
        await checkForUpdate();
        // The host reads a file, not an argument; publishing it after the start
        // would race the updater into running the wrong kind.
        expect(publishUpdateSource).toHaveBeenCalledWith("image");
        expect(publishUpdateSource.mock.invocationCallOrder[0]).toBeLessThan(
            startHostUpdate.mock.invocationCallOrder[0] as number
        );
    });

    it("waits for its window instead of installing when the build appears", async () => {
        // A window that has not come round yet whatever time the suite runs at:
        // the build is seen now, so tomorrow's window is always ahead of it.
        const now = new Date();
        const soon = new Date(now.getTime() + 30 * 60_000);
        const at = `${String(soon.getHours()).padStart(2, "0")}:${String(soon.getMinutes()).padStart(2, "0")}`;
        await saveAutoUpdatePolicy({ mode: "daily", at });
        await checkForUpdate();
        expect(raised("system.update")).toHaveLength(2);
        expect(startHostUpdate).not.toHaveBeenCalled();
    });

    it("installs once the window has passed", async () => {
        await saveAutoUpdatePolicy({ mode: "daily", at: "05:00" });
        // The build was noticed at 04:00 yesterday, so its 05:00 is long gone.
        rows.set("updates.announced", `${SHA} ${new Date(Date.now() - 36 * 3_600_000).toISOString()}`);
        await checkForUpdate();
        expect(startHostUpdate).toHaveBeenCalledTimes(1);
    });

    it("reports an update that never got going, and does not keep trying it", async () => {
        startHostUpdate.mockResolvedValue("unreachable");
        await saveAutoUpdatePolicy({ mode: "immediate", at: "05:00" });
        await checkForUpdate();
        await checkForUpdate();

        expect(startHostUpdate).toHaveBeenCalledTimes(1);
        const alerts = raised("system.updated");
        expect(alerts).toHaveLength(2);
        expect(alerts[0]?.title).toContain("could not install");
    });

    it("reports an update that started and failed, once the updater says so", async () => {
        await saveAutoUpdatePolicy({ mode: "immediate", at: "05:00" });
        await checkForUpdate();
        notify.mockClear();

        // Still on the old build, and the log now carries a non-zero exit.
        lastUpdateOutcome.mockResolvedValue({ exitCode: 1, endedAt: Date.now() });
        await checkForUpdate();
        await checkForUpdate();

        const alerts = raised("system.updated");
        expect(alerts).toHaveLength(2);
        expect(alerts[0]?.title).toContain("failed to install");
        expect(startHostUpdate).toHaveBeenCalledTimes(1);
    });

    it("says nothing about a run that has not reported a result yet", async () => {
        await saveAutoUpdatePolicy({ mode: "immediate", at: "05:00" });
        await checkForUpdate();
        notify.mockClear();
        lastUpdateOutcome.mockResolvedValue({ exitCode: null, endedAt: Date.now() });
        await checkForUpdate();
        expect(notify).not.toHaveBeenCalled();
    });

    it("does not report the last run's failure as this one's", async () => {
        await saveAutoUpdatePolicy({ mode: "immediate", at: "05:00" });
        await checkForUpdate();
        notify.mockClear();

        // The updater has not truncated the log yet, so it still ends with the
        // exit marker of a run that failed before this install was started.
        lastUpdateOutcome.mockResolvedValue({ exitCode: 1, endedAt: Date.now() - 60_000 });
        await checkForUpdate();
        expect(notify).not.toHaveBeenCalled();

        // Once this run reports its own result, it is reported.
        lastUpdateOutcome.mockResolvedValue({ exitCode: 1, endedAt: Date.now() + 60_000 });
        await checkForUpdate();
        expect(raised("system.updated")).toHaveLength(2);
    });
});
