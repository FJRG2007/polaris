/**
 * The security rule on top of the update schedule: a build that fixes a
 * vulnerability installs itself on the schedule its severity has, whatever
 * the general policy says - at once for critical and high by default, at the
 * quietest hour when asked, and never on its own for what is set to "only
 * tell me". The general schedule still wins when it is sooner.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UpdateStatus } from "../../src/lib/update-service";

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
    await saveAutoUpdatePolicy({ mode: "off", at: "05:00" });
});

describe("a build that fixes a vulnerability", () => {
    it("installs at once for a critical fix, with the general policy set to only tell", async () => {
        changelog.security = "critical";
        await checkForUpdate();
        expect(startHostUpdate).toHaveBeenCalledTimes(1);
    });

    it("installs at once for a high fix too, by default", async () => {
        changelog.security = "high";
        await checkForUpdate();
        expect(startHostUpdate).toHaveBeenCalledTimes(1);
    });

    it("only tells for a medium or low fix, by default", async () => {
        for (const severity of ["medium", "low"] as const) {
            rows.clear();
            await saveAutoUpdatePolicy({ mode: "off", at: "05:00" });
            changelog.security = severity;
            await checkForUpdate();
        }
        expect(startHostUpdate).not.toHaveBeenCalled();
    });

    it("waits for the quietest hour when the severity is set to", async () => {
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(new Date(2026, 10, 12, 14, 0));
        await saveSecurityUpdatePolicy({ ...core.DEFAULT_SECURITY_UPDATE, medium: "quiet" });
        changelog.security = "medium";
        changelog.hour = 3;
        await checkForUpdate();
        expect(startHostUpdate).not.toHaveBeenCalled();
        vi.setSystemTime(new Date(2026, 10, 13, 3, 1));
        await checkForUpdate();
        expect(startHostUpdate).toHaveBeenCalledTimes(1);
    });

    it("says in the announcement that it installs itself, and asks nothing of anybody", async () => {
        changelog.security = "critical";
        await checkForUpdate();
        const alerts = notify.mock.calls
            .map(([input]) => input as unknown as { event: string; body: string; actionRequired?: boolean })
            .filter((input) => input.event === "system.update");
        expect(alerts.length).toBeGreaterThan(0);
        expect(alerts[0]!.body).toMatch(/critical/i);
        expect(alerts[0]!.actionRequired).toBeFalsy();
    });

    it("leaves a critical fix to the operator once the risk was accepted for it", async () => {
        await saveSecurityUpdatePolicy({
            ...core.DEFAULT_SECURITY_UPDATE,
            critical: "off",
            riskAccepted: { by: "user-1", at: new Date().toISOString() }
        });
        changelog.security = "critical";
        await checkForUpdate();
        expect(startHostUpdate).not.toHaveBeenCalled();
    });

    it("installs at once anyway when a risky policy has nobody recorded as accepting it", async () => {
        await saveSecurityUpdatePolicy({ ...core.DEFAULT_SECURITY_UPDATE, critical: "off" });
        changelog.security = "critical";
        await checkForUpdate();
        expect(startHostUpdate).toHaveBeenCalledTimes(1);
    });
});
