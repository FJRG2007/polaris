/**
 * What Polaris remembers about the volumes on a machine, and the advice it gives.
 *
 * The case this exists for: "polaris-36e74d11_data - Nothing uses it - Created
 * by polaris-36e74d11 - 672 MB". The app that made it was deleted; the screen
 * could say nothing about what it had been or whether it could go.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = {
    serverId: string;
    kind: string;
    name: string;
    purpose: string;
    description: string;
    sourceKind: string | null;
    sourceId: string | null;
    createdAt: Date;
    lastSeenAt: Date | null;
    lastUsedAt: Date | null;
    ownerDeletedAt: Date | null;
    removedAt: Date | null;
};

let rows: Row[] = [];

function matches(row: Row, where: Record<string, unknown>): boolean {
    return Object.entries(where).every(([key, value]) => {
        const actual = (row as Record<string, unknown>)[key];
        if (value && typeof value === "object" && !(value instanceof Date)) {
            const filter = value as { in?: string[]; notIn?: string[] };
            if (filter.in) return filter.in.includes(actual as string);
            if (filter.notIn) return !filter.notIn.includes(actual as string);
        }
        return actual === value;
    });
}

vi.mock("@polaris/db", () => ({
    prisma: {
        hostResourceRecord: {
            findMany: async ({ where }: { where: Record<string, unknown> }) =>
                rows.filter((row) => matches(row, where)),
            createMany: async ({ data }: { data: Partial<Row>[] }) => {
                for (const entry of data) {
                    rows.push({
                        purpose: "other",
                        description: "",
                        sourceKind: null,
                        sourceId: null,
                        createdAt: new Date("2026-08-01T00:00:00Z"),
                        lastSeenAt: null,
                        lastUsedAt: null,
                        ownerDeletedAt: null,
                        removedAt: null,
                        ...entry
                    } as Row);
                }
            },
            update: async ({
                where,
                data
            }: {
                where: { serverId_kind_name: { name: string } };
                data: Partial<Row>;
            }) => {
                const row = rows.find((one) => one.name === where.serverId_kind_name.name);
                if (row) Object.assign(row, data);
            },
            updateMany: async ({
                where,
                data
            }: {
                where: Record<string, unknown>;
                data: Partial<Row>;
            }) => {
                for (const row of rows.filter((one) => matches(one, where)))
                    Object.assign(row, data);
            }
        }
    }
}));

const { noteVolumes, volumeVerdict } = await import("@/lib/deploy/host-resources");

const NOW = new Date("2026-09-24T12:00:00Z");
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 86_400_000);

beforeEach(() => {
    rows = [];
});

describe("the advice on a volume", () => {
    const base = {
        inUse: false,
        owner: null,
        note: null,
        madeByPolaris: false,
        createdAt: daysAgo(90),
        now: NOW
    };
    const note = (over: Partial<Parameters<typeof volumeVerdict>[0]["note"] & object> = {}) => ({
        description: "Data of Billing (Acme / production)",
        purpose: "app-data",
        lastUsedAt: daysAgo(40),
        ownerDeletedAt: daysAgo(34),
        firstSeenAt: daysAgo(60),
        ...over
    });

    it("keeps anything in use, and anything that still has an owner", () => {
        expect(volumeVerdict({ ...base, inUse: true }).verdict).toBe("keep");
        expect(volumeVerdict({ ...base, owner: "Billing" }).verdict).toBe("keep");
    });

    it("calls an app's data safe once the app has been gone a week and nothing used it since", () => {
        const judged = volumeVerdict({ ...base, note: note() });
        expect(judged.verdict).toBe("safe");
        expect(judged.reason).toContain("34 days ago");
    });

    it("says to wait when the app was deleted only just now", () => {
        expect(
            volumeVerdict({
                ...base,
                note: note({ ownerDeletedAt: daysAgo(1), lastUsedAt: daysAgo(1) })
            }).verdict
        ).toBe("review");
    });

    it("calls a Polaris volume with no owner safe after a month unused, not before", () => {
        expect(
            volumeVerdict({ ...base, madeByPolaris: true, createdAt: daysAgo(60) }).verdict
        ).toBe("safe");
        expect(volumeVerdict({ ...base, madeByPolaris: true, createdAt: daysAgo(5) }).verdict).toBe(
            "review"
        );
    });

    it("never calls something Polaris did not make safe", () => {
        const judged = volumeVerdict({ ...base, createdAt: daysAgo(400) });
        expect(judged.verdict).toBe("review");
        expect(judged.reason).toMatch(/did not make it/);
    });
});

describe("noting what a look at the machine saw", () => {
    const app = {
        kind: "application",
        id: "app-1",
        description: "Data of Billing (Acme / production)",
        purpose: "app-data"
    };

    it("writes down a new volume with what it belongs to, and that it was in use", async () => {
        await noteVolumes(
            [{ name: "polaris-36e74d11_data", used: true, owner: app }],
            "local",
            NOW
        );
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
            description: "Data of Billing (Acme / production)",
            sourceId: "app-1",
            lastSeenAt: NOW,
            lastUsedAt: NOW
        });
    });

    it("keeps what it was when the owner disappears, and says since when", async () => {
        await noteVolumes(
            [{ name: "polaris-36e74d11_data", used: true, owner: app }],
            "local",
            daysAgo(10)
        );
        await noteVolumes(
            [{ name: "polaris-36e74d11_data", used: false, owner: null }],
            "local",
            NOW
        );
        expect(rows[0]).toMatchObject({
            description: "Data of Billing (Acme / production)",
            lastUsedAt: daysAgo(10),
            ownerDeletedAt: NOW
        });
    });

    it("marks a volume that is gone from the machine rather than forgetting it", async () => {
        await noteVolumes([{ name: "old_data", used: false, owner: null }], "local", daysAgo(3));
        await noteVolumes([], "local", NOW);
        expect(rows[0]?.removedAt).toEqual(NOW);
    });
});
