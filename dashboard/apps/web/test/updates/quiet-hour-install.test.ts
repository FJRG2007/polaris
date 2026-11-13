/**
 * Installing every update at the quietest hour, which is what a deployment does
 * when nobody chose otherwise. Nobody choosing means no row: a stored answer is
 * somebody's choice and is kept. The hour is the one a security fix waits for,
 * and a host that cannot install on its own reads the default as "only tell me".
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { LIMITED_CAPABILITIES, setCapabilities, type Capabilities } from "@polaris/config";
import type { UpdateStatus } from "../../src/lib/update-service";

/** A host whose agent answers and lets updates run. */
const FULL: Capabilities = {
    ...LIMITED_CAPABILITIES,
    edition: "full",
    hostd: { present: true, version: "test" },
    autoUpdate: true
};

const SHA = "abc1234";

/** The Setting table, with the two write shapes the watcher relies on. */
const rows = new Map<string, string>();

const setting = {
    findUnique: vi.fn(async ({ where }: { where: { key: string } }) =>
        rows.has(where.key) ? { value: rows.get(where.key) } : null
    ),
    create: vi.fn(async ({ data }: { data: { key: string; value: string } }) => {
        if (rows.has(data.key)) throw new Error("Unique constraint failed on the fields: (`key`)");
        rows.set(data.key, data.value);
        return data;
    }),
    updateMany: vi.fn(
        async ({
            where,
            data
        }: {
            where: {
                key: string;
                value?: { startsWith: string };
                NOT?: { value: { startsWith: string } };
            };
            data: { value: string };
        }) => {
            const current = rows.get(where.key);
            if (current === undefined) return { count: 0 };
            if (where.value && !current.startsWith(where.value.startsWith)) return { count: 0 };
            if (where.NOT && current.startsWith(where.NOT.value.startsWith)) return { count: 0 };
            rows.set(where.key, data.value);
            return { count: 1 };
        }
    ),
    upsert: vi.fn(
        async ({ where, create }: { where: { key: string }; create: { value: string } }) => {
            rows.set(where.key, create.value);
            return create;
        }
    ),
    deleteMany: vi.fn(
        async ({ where }: { where: { key: string; value?: { startsWith: string } } }) => {
            const current = rows.get(where.key);
            if (current === undefined) return { count: 0 };
            if (where.value && !current.startsWith(where.value.startsWith)) return { count: 0 };
            rows.delete(where.key);
            return { count: 1 };
        }
    )
};

/** Marking a whole event read, which is how the watcher puts its own alerts down. */
const notificationUpdateMany = vi.fn(async () => ({ count: 0 }));
/** Deleting a whole event, which is how a superseded "update ready" goes. */
const notificationDeleteMany = vi.fn(async () => ({ count: 0 }));
/** Bell rows and off-bell deliveries already out there, which is what decides
 *  whether an earlier alert is still standing for somebody. */
interface BellRow {
    userId: string;
    type: string;
    readAt: Date | null;
    createdAt: Date;
}
interface DeliveryRow {
    userId: string;
    event: string;
    kind: string;
    status: string;
    createdAt: Date;
}
const bellRows: BellRow[] = [];
const deliveryRows: DeliveryRow[] = [];
const notificationFindMany = vi.fn(
    async ({
        where
    }: {
        where: { userId: { in: string[] }; type: string; createdAt: { gt: Date } };
    }) =>
        bellRows.filter(
            (row) =>
                where.userId.in.includes(row.userId) &&
                row.type === where.type &&
                row.createdAt > where.createdAt.gt
        )
);
const deliveryFindMany = vi.fn(
    async ({
        where
    }: {
        where: {
            userId: { in: string[] };
            event: string;
            kind: { not: string };
            status: string;
            createdAt: { gt: Date };
        };
    }) =>
        deliveryRows.filter(
            (row) =>
                where.userId.in.includes(row.userId) &&
                row.event === where.event &&
                row.kind !== where.kind.not &&
                row.status === where.status &&
                row.createdAt > where.createdAt.gt
        )
);

const notify = vi.fn(async () => {});
const startHostUpdate = vi.fn(async () => "started" as const);
/** What the host is told to run, which every start has to publish first. */
const publishUpdateSource = vi.fn(async (_source: string) => {});
const lastUpdateOutcome = vi.fn(
    async () => null as { exitCode: number | null; endedAt: number } | null
);
let status: UpdateStatus;

vi.mock("@polaris/db", () => ({
    prisma: {
        setting,
        notification: {
            updateMany: notificationUpdateMany,
            deleteMany: notificationDeleteMany,
            findMany: notificationFindMany
        },
        notificationDelivery: { findMany: deliveryFindMany }
    }
}));
vi.mock("@polaris/auth", () => ({ usersWithPermission: async () => ["user-1", "user-2"] }));
vi.mock("@/lib/notifications/dispatch", () => ({
    notify: (input: unknown) => notify(input as never)
}));
vi.mock("@/lib/update-service", () => ({
    getUpdateStatus: async () => status,
    github: async () => {
        throw new Error("not in this test");
    }
}));
vi.mock("@/lib/update-runner", () => ({
    startHostUpdate: () => startHostUpdate(),
    publishUpdateSource: (source: string) => publishUpdateSource(source),
    lastUpdateOutcome: () => lastUpdateOutcome()
}));

const changelog = vi.hoisted(() => ({
    security: null as null | "critical" | "high" | "medium" | "low",
    hour: 4
}));
vi.mock("@/lib/update-changelog", async (original) => {
    const real = await original<typeof import("../../src/lib/update-changelog")>();
    return {
        ...real,
        updateChangelog: async () => (changelog.security ? { security: changelog.security } : null),
        quietHour: async () => changelog.hour
    };
});

const { checkForUpdate, saveAutoUpdatePolicy } = await import("../../src/lib/update-watcher");
const { saveSecurityUpdatePolicy } = await import("../../src/lib/update-changelog");
const core = await import("@polaris/core");

function available(latest: string | null = SHA): UpdateStatus {
    return {
        phase: latest ? "available" : "unknown",
        source: "image",
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

beforeEach(async () => {
    rows.clear();
    notify.mockClear();
    startHostUpdate.mockClear();
    startHostUpdate.mockResolvedValue("started");
    lastUpdateOutcome.mockResolvedValue(null);
    status = available();
    changelog.security = null;
    changelog.hour = 4;
    vi.useRealTimers();
    // Nothing stored: the deployment follows the default.
    setCapabilities(FULL);
});

/** Every alert raised so far for this event, one per reader. */
function raised(event: string): { userId: string; title: string; body: string }[] {
    return notify.mock.calls
        .map(
            ([input]) =>
                input as unknown as { userId: string; event: string; title: string; body: string }
        )
        .filter((input) => input.event === event);
}

describe("installing at the quietest hour", () => {
    it("is what a deployment that never chose does", async () => {
        const { getAutoUpdatePolicy } = await import("../../src/lib/update-watcher");
        expect((await getAutoUpdatePolicy()).mode).toBe("quiet");
    });

    it("keeps a choice somebody stored", async () => {
        const { getAutoUpdatePolicy } = await import("../../src/lib/update-watcher");
        await saveAutoUpdatePolicy({ mode: "off", at: "05:00" });
        expect((await getAutoUpdatePolicy()).mode).toBe("off");
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(new Date(2026, 10, 12, 14, 0));
        await checkForUpdate();
        vi.setSystemTime(new Date(2026, 10, 13, 4, 1));
        await checkForUpdate();
        expect(startHostUpdate).not.toHaveBeenCalled();
    });

    it("installs a build with no security fix at the first quiet hour after it appeared", async () => {
        vi.useFakeTimers({ toFake: ["Date"] });
        changelog.hour = 2;
        vi.setSystemTime(new Date(2026, 10, 12, 14, 0));
        await checkForUpdate();
        expect(startHostUpdate).not.toHaveBeenCalled();
        expect(raised("system.update")[0]?.body).toContain("02:00");
        vi.setSystemTime(new Date(2026, 10, 13, 1, 59));
        await checkForUpdate();
        expect(startHostUpdate).not.toHaveBeenCalled();
        vi.setSystemTime(new Date(2026, 10, 13, 2, 1));
        await checkForUpdate();
        await checkForUpdate();
        expect(startHostUpdate).toHaveBeenCalledTimes(1);
    });

    it("waits while an update is already running", async () => {
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(new Date(2026, 10, 12, 14, 0));
        await checkForUpdate();
        vi.setSystemTime(new Date(2026, 10, 13, 4, 1));
        lastUpdateOutcome.mockResolvedValue({ exitCode: null, endedAt: Date.now() - 60_000 });
        await checkForUpdate();
        expect(startHostUpdate).not.toHaveBeenCalled();
        lastUpdateOutcome.mockResolvedValue({ exitCode: 0, endedAt: Date.now() });
        await checkForUpdate();
        expect(startHostUpdate).toHaveBeenCalledTimes(1);
    });

    it("tries a failed install again at the next quiet hour, not before", async () => {
        vi.useFakeTimers({ toFake: ["Date"] });
        startHostUpdate.mockResolvedValue("unreachable" as never);
        vi.setSystemTime(new Date(2026, 10, 12, 14, 0));
        await checkForUpdate();
        vi.setSystemTime(new Date(2026, 10, 13, 4, 1));
        await checkForUpdate();
        expect(startHostUpdate).toHaveBeenCalledTimes(1);
        expect(raised("system.updated")).toHaveLength(2);
        vi.setSystemTime(new Date(2026, 10, 13, 12, 0));
        await checkForUpdate();
        expect(startHostUpdate).toHaveBeenCalledTimes(1);
        startHostUpdate.mockResolvedValue("started");
        vi.setSystemTime(new Date(2026, 10, 14, 4, 1));
        await checkForUpdate();
        await checkForUpdate();
        expect(startHostUpdate).toHaveBeenCalledTimes(2);
    });

    it("tells whoever can update which build it installed once it lands", async () => {
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(new Date(2026, 10, 12, 14, 0));
        await checkForUpdate();
        vi.setSystemTime(new Date(2026, 10, 13, 4, 1));
        await checkForUpdate();
        notify.mockClear();
        status = { ...available(), current: SHA, upToDate: true, phase: "current" as never };
        await checkForUpdate();
        const told = raised("system.updated");
        expect(told).toHaveLength(2);
        expect(told[0]?.body).toContain(SHA);
    });

    it("only tells, on a host that cannot install on its own", async () => {
        setCapabilities(LIMITED_CAPABILITIES);
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(new Date(2026, 10, 12, 14, 0));
        await checkForUpdate();
        vi.setSystemTime(new Date(2026, 10, 14, 4, 1));
        await checkForUpdate();
        expect(startHostUpdate).not.toHaveBeenCalled();
        expect(raised("system.updated")).toHaveLength(0);
    });
});
