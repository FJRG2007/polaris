/**
 * A ban that ends by itself.
 *
 * The whole design is in one sentence: `bannedAt` goes on being the only column
 * that says whether somebody is banned, and a suspension is that column plus a
 * note of when to clear it. So the two things worth asserting are that banning
 * still writes what everything else reads, and that the sweep clears exactly the
 * rows whose time is up and no others.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

interface Row {
    id: string;
    bannedAt: Date | null;
    banReason: string | null;
    bannedUntil: Date | null;
}

let rows: Row[] = [];
let updated: { where: unknown; data: Record<string, unknown> }[] = [];

vi.mock("@polaris/db", () => ({
    prisma: {
        user: {
            findUnique: async ({ where }: { where: { id: string } }) =>
                rows.find((row) => row.id === where.id) ?? null,
            findMany: async ({ where }: { where?: { bannedUntil?: { lte?: Date } } }) => {
                const due = where?.bannedUntil?.lte;
                return rows.filter(
                    (row) =>
                        row.bannedAt !== null &&
                        row.bannedUntil !== null &&
                        (due === undefined || row.bannedUntil <= due)
                );
            },
            count: async () => 1,
            update: async ({ where, data }: { where: unknown; data: Record<string, unknown> }) => {
                updated.push({ where, data });
                return {};
            },
            updateMany: async ({ where, data }: { where: unknown; data: Record<string, unknown> }) => {
                updated.push({ where, data });
                return { count: 1 };
            }
        },
        session: { deleteMany: async () => ({ count: 2 }) },
        auditLog: { create: async () => ({}) }
    }
}));

vi.mock("@/lib/audit-service", () => ({ recordAudit: async () => undefined }));
vi.mock("@/lib/session-directory", () => ({ describeOrigin: () => "" }));
vi.mock("@/lib/request-context", () => ({
    clientHost: async () => null,
    clientIp: async () => undefined,
    clientUserAgent: async () => null,
    clientUserAgentBrands: async () => null
}));
vi.mock("@polaris/auth", () => ({
    markPrincipalsMoved: async () => undefined,
    resolveSignInRules: async () => ({ allowedCidrs: [], allowedCountries: [], allowedContinents: [] }),
    updateEnforcedRules: async () => undefined
}));

const admin = await import("@/lib/user-admin-service");

beforeEach(() => {
    rows = [{ id: "ada", bannedAt: null, banReason: null, bannedUntil: null }];
    updated = [];
});

describe("banUser", () => {
    it("writes an end when it is given a length", async () => {
        expect(await admin.banUser("root", "ada", "spam", 60)).toEqual({});
        const data = updated[0]?.data as { bannedAt: Date; bannedUntil: Date | null };
        expect(data.bannedAt).toBeInstanceOf(Date);
        expect(data.bannedUntil).toBeInstanceOf(Date);
        // The column everything else reads is still set: a suspension is a ban
        // with a note, not a third state nothing knows about.
        expect(data.bannedUntil!.getTime() - data.bannedAt.getTime()).toBe(60 * 60_000);
    });

    it("writes no end for a ban", async () => {
        await admin.banUser("root", "ada", "", 0);
        expect((updated[0]?.data as { bannedUntil: Date | null }).bannedUntil).toBeNull();
    });

    it("refuses a length nobody meant", async () => {
        expect(await admin.banUser("root", "ada", "", -1)).toEqual({ error: "That is not a length." });
        expect(
            await admin.banUser("root", "ada", "", admin.MAX_SUSPENSION_MINUTES + 1)
        ).toEqual({ error: "That is not a length." });
        expect(updated).toEqual([]);
    });

    it("still refuses to ban the person doing it", async () => {
        expect(await admin.banUser("ada", "ada", "")).toEqual({ error: "You can't ban yourself." });
    });
});

describe("liftExpiredSuspensions", () => {
    const at = (minutes: number) => new Date(Date.now() + minutes * 60_000);

    it("lets back in the ones whose time is up, and nobody else", async () => {
        rows = [
            { id: "ada", bannedAt: new Date(), banReason: "spam", bannedUntil: at(-1) },
            { id: "grace", bannedAt: new Date(), banReason: null, bannedUntil: at(60) },
            // A ban with no end is not a suspension and is never swept.
            { id: "alan", bannedAt: new Date(), banReason: null, bannedUntil: null }
        ];
        expect(await admin.liftExpiredSuspensions()).toBe(1);
        expect(updated[0]?.where).toEqual({ id: { in: ["ada"] } });
        expect(updated[0]?.data).toEqual({ bannedAt: null, banReason: null, bannedUntil: null });
    });

    it("does nothing at all when nothing is due", async () => {
        rows = [{ id: "grace", bannedAt: new Date(), banReason: null, bannedUntil: at(60) }];
        expect(await admin.liftExpiredSuspensions()).toBe(0);
        expect(updated).toEqual([]);
    });
});
