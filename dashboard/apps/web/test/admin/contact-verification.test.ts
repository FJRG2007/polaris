/**
 * An administrator saying an address or a number is somebody's.
 *
 * The ordinary path is the person proving it themselves and it stays the
 * ordinary path. This is for the cases that path cannot reach: an address on a
 * domain this instance cannot deliver to, a number in a country the message
 * never arrives in, an account made for somebody before they had either. Without
 * it the answer was to leave them permanently half-signed-up, or to have them
 * hand over a password so somebody else could finish it as them.
 *
 * What is guarded here is the difference between asserting and proving: it goes
 * into the audit trail as an assertion, and an outstanding code never survives
 * it in either direction.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

let phone: { phone: string; verifiedAt: Date | null } | null = null;
let users: Record<string, unknown>[] = [];
let phones: Record<string, unknown>[] = [];
let audits: Record<string, unknown>[] = [];

vi.mock("@polaris/db", () => ({
    VISIBLE_USER: {},
    prisma: {
        user: { update: async (query: Record<string, unknown>) => users.push(query) },
        userPhone: {
            findUnique: async () => phone,
            update: async (query: Record<string, unknown>) => phones.push(query)
        }
    }
}));

vi.mock("@/lib/session-directory", () => ({ describeOrigin: () => "" }));
vi.mock("@/lib/notifications/dispatch", () => ({ notify: async () => undefined }));
vi.mock("@/lib/notifications/session-events", () => ({ notifySessionsClosed: async () => undefined }));
vi.mock("@/lib/session-guard", () => ({ revokeSessionsRefusedByRules: async () => undefined }));
vi.mock("@/lib/avatar-service", () => ({ discardAvatars: async () => undefined }));
vi.mock("@/lib/personal-drive", () => ({ discardPersonalDrive: async () => undefined }));
vi.mock("@polaris/auth", () => ({
    markPrincipalsMoved: async () => undefined,
    updateEnforcedRules: async () => undefined
}));

vi.mock("@/lib/audit-service", () => ({
    recordAudit: async (entry: Record<string, unknown>) => {
        audits.push(entry);
    }
}));

const { setContactVerified } = await import("@/lib/user-admin-service");

beforeEach(() => {
    phone = { phone: "+34600000000", verifiedAt: null };
    users = [];
    phones = [];
    audits = [];
});

describe("an address", () => {
    it("is marked, and recorded as somebody having said so", async () => {
        expect(await setContactVerified("admin-1", "u1", "email", true)).toEqual({});
        expect(users[0]).toMatchObject({ where: { id: "u1" }, data: { emailVerified: true } });
        expect(audits[0]).toMatchObject({
            actorId: "admin-1",
            action: "user.email.verify",
            targetId: "u1"
        });
    });

    it("can be taken back", async () => {
        await setContactVerified("admin-1", "u1", "email", false);
        expect(users[0]).toMatchObject({ data: { emailVerified: false } });
        expect(audits[0]).toMatchObject({ action: "user.email.unverify" });
    });
});

describe("a number", () => {
    it("is stamped, and any outstanding code goes with it", async () => {
        await setContactVerified("admin-1", "u1", "phone", true);
        const written = phones[0]?.data as Record<string, unknown>;
        expect(written.verifiedAt).toBeInstanceOf(Date);
        // A code still outstanding would let somebody finish a proof that has
        // just been made meaningless.
        expect(written.codeHash).toBeNull();
        expect(written.codeExpiresAt).toBeNull();
    });

    it("clears the stamp and the code when it is taken back", async () => {
        phone = { phone: "+34600000000", verifiedAt: new Date() };
        await setContactVerified("admin-1", "u1", "phone", false);
        expect(phones[0]?.data).toMatchObject({ verifiedAt: null, codeHash: null });
    });

    // A factor confirmed and absent is a state nobody can get out of.
    it("refuses when there is no number at all", async () => {
        phone = null;
        const result = await setContactVerified("admin-1", "u1", "phone", true);
        expect(result.error).toBeTruthy();
        expect(phones).toEqual([]);
        expect(audits).toEqual([]);
    });
});
