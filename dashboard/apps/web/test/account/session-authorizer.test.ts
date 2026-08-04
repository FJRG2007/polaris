/**
 * Which device let a session in.
 *
 * Two sign-ins on an account are answered by somebody other than the person
 * signing in: one approved from the session list, one let through by scanning
 * the code on its sign-in screen. Both used to read as "somebody allowed it",
 * and the fact worth having is which device did - because if that device is one
 * the owner no longer has, every session it answered for is suspect.
 *
 * So what is pinned here is the reading: the label survives the answering
 * session being signed out, the link to it does not, and an id that belongs to
 * another account never names one of its devices.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const CHROME = "Mozilla/5.0 (Windows NT 10.0) Chrome/140";
const SAFARI = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0) Safari/605";

const OWNER = "11111111-1111-4111-8111-111111111111";
const PHONE = "22222222-2222-4222-8222-222222222222";
const LAPTOP = "33333333-3333-4333-8333-333333333333";

let sessionRows: Record<string, unknown>[] = [];
let stateRow: Record<string, unknown> | null = null;
let pinAccepted = true;
/** The last update the pending session's state was given. */
let updated: Record<string, unknown> | null = null;

vi.mock("next/headers", () => ({ headers: async () => new Headers(), cookies: async () => ({ get: () => undefined }) }));
vi.mock("@polaris/auth", () => ({ verifyQuickPin: async () => pinAccepted }));
vi.mock("@/lib/auth", () => ({ auth: {} }));
vi.mock("@/lib/audit-service", () => ({ recordAudit: async () => undefined }));
vi.mock("@/lib/network-service", () => ({ networkPublicIp: async () => "85.87.156.88" }));
vi.mock("@polaris/db", () => ({
    prisma: {
        session: {
            findMany: async () => sessionRows,
            findFirst: async ({ where }: { where: { id: string; userId: string } }) =>
                sessionRows.find((row) => row.id === where.id && where.userId === OWNER) ?? null,
            deleteMany: async () => ({ count: 1 })
        },
        sessionState: {
            findFirst: async () => stateRow,
            update: async ({ data }: { data: Record<string, unknown> }) => {
                updated = data;
                return data;
            }
        }
    }
}));

const { decideLoginApproval, listUserSessions } = await import("../../src/lib/session-directory");

/** One Session row as the directory selects it. */
function sessionRow(id: string, userAgent: string, state: Record<string, unknown> = {}) {
    return {
        id,
        createdAt: new Date("2026-08-01T10:00:00Z"),
        expiresAt: new Date("2026-09-01T10:00:00Z"),
        ipAddress: "85.87.156.88",
        userAgent,
        state: { userAgent, lastSeenAt: new Date("2026-08-04T10:00:00Z"), approval: "approved", ...state }
    };
}

beforeEach(() => {
    sessionRows = [];
    stateRow = { sessionId: LAPTOP };
    pinAccepted = true;
    updated = null;
});

describe("reading who let a session in", () => {
    it("names the device and links it while that session is still signed in", async () => {
        sessionRows = [
            sessionRow(LAPTOP, CHROME, { authorizedBySessionId: PHONE, authorizedByDevice: "Safari on iOS" }),
            sessionRow(PHONE, SAFARI)
        ];
        const [laptop] = await listUserSessions(OWNER, LAPTOP);
        expect(laptop?.authorizedBy).toEqual({
            sessionId: PHONE,
            device: "Safari on iOS",
            live: true,
            current: false
        });
    });

    // The label is a snapshot for exactly this case: the session that answered is
    // gone, and it cannot be asked what it was called.
    it("keeps the label after the answering session has ended, and says it is gone", async () => {
        sessionRows = [
            sessionRow(LAPTOP, CHROME, { authorizedBySessionId: PHONE, authorizedByDevice: "Safari on iOS" })
        ];
        expect((await listUserSessions(OWNER, LAPTOP))[0]?.authorizedBy).toMatchObject({
            device: "Safari on iOS",
            live: false
        });
    });

    it("marks the reader's own device when it is the one that answered", async () => {
        sessionRows = [
            sessionRow(LAPTOP, CHROME, { authorizedBySessionId: PHONE, authorizedByDevice: "Safari on iOS" }),
            sessionRow(PHONE, SAFARI)
        ];
        expect((await listUserSessions(OWNER, PHONE))[0]?.authorizedBy?.current).toBe(true);
    });

    it("says nothing rather than guessing when the label was never recorded", async () => {
        sessionRows = [sessionRow(LAPTOP, CHROME, { authorizedBySessionId: PHONE })];
        expect((await listUserSessions(OWNER, LAPTOP))[0]?.authorizedBy?.device).toBe(
            "A device that is no longer signed in"
        );
    });

    it("leaves it empty for the sessions nobody had to answer for", async () => {
        sessionRows = [sessionRow(LAPTOP, CHROME)];
        expect((await listUserSessions(OWNER, LAPTOP))[0]?.authorizedBy).toBeNull();
    });
});

describe("approving a waiting sign-in", () => {
    it("records the device that approved it on the session it lets in", async () => {
        sessionRows = [sessionRow(PHONE, SAFARI)];
        expect(await decideLoginApproval(OWNER, LAPTOP, true, "1234", PHONE)).toEqual({});
        expect(updated).toMatchObject({
            approval: "approved",
            authorizedBySessionId: PHONE,
            authorizedByDevice: "Safari on iOS"
        });
    });

    // The id comes from a request, so it is matched against the account's own
    // sessions - naming somebody else's device would be worse than naming none.
    it("names nothing when the approving session is not one of this account's", async () => {
        sessionRows = [];
        await decideLoginApproval(OWNER, LAPTOP, true, "1234", PHONE);
        expect(updated).toMatchObject({ approval: "approved" });
        expect(updated).not.toHaveProperty("authorizedBySessionId");
    });

    it("records nothing at all when the PIN is wrong", async () => {
        pinAccepted = false;
        sessionRows = [sessionRow(PHONE, SAFARI)];
        expect((await decideLoginApproval(OWNER, LAPTOP, true, "9999", PHONE)).error).toBeTruthy();
        expect(updated).toBeNull();
    });

    it("has nothing to approve once the sign-in has stopped waiting", async () => {
        stateRow = null;
        expect((await decideLoginApproval(OWNER, LAPTOP, true, "1234", PHONE)).error).toBeTruthy();
        expect(updated).toBeNull();
    });
});
