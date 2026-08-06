/**
 * What imposing a network limit does to the sessions already open.
 *
 * Ending every one of them made the feature unusable: an administrator pinning
 * an account to the office signed that account out of the office, and a user
 * narrowing their own rules lost the browser they were narrowing them from. The
 * limit still has to bite immediately - a rule that waits for the next sign-in
 * is not a rule - so what is pinned here is the middle: the sessions the new
 * rules turn away end, and the ones they would let in are left alone.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const OFFICE = "203.0.113.10";
const HOME = "198.51.100.4";

const DESK = "11111111-1111-4111-8111-111111111111";
const PHONE = "22222222-2222-4222-8222-222222222222";
const LAPTOP = "33333333-3333-4333-8333-333333333333";

const USER = "44444444-4444-4444-8444-444444444444";
const ADMIN = "55555555-5555-4555-8555-555555555555";

/** The live sessions on the account, as the helper selects them. */
let states: { sessionId: string; ip: string | null }[] = [];
/** The addresses the rules under test let through. */
let permitted: string[] = [];
/** The ids handed to the delete, so what survived is readable from the test. */
let deleted: string[] = [];
/** How many verdicts were computed, to pin the per-address de-duplication. */
let verdicts = 0;
let audit: Record<string, unknown> | null = null;
const principalsMoved = vi.fn(async () => {});

vi.mock("@/lib/request-context", () => ({
    clientHost: async () => null,
    clientIp: async () => undefined,
    clientUserAgent: async () => null,
    clientUserAgentBrands: async () => null
}));
vi.mock("@/lib/notifications/dispatch", () => ({ notify: async () => undefined }));
vi.mock("@/lib/session-directory", () => ({ describeOrigin: () => "" }));
vi.mock("@/lib/audit-service", () => ({
    recordAudit: async (input: Record<string, unknown>) => {
        audit = input;
    }
}));
vi.mock("@/lib/network-rules", () => ({
    evaluateAccountAccess: async (_userId: string, ip: string | undefined) => {
        verdicts += 1;
        return { allowed: ip !== undefined && permitted.includes(ip), reason: null, country: null };
    }
}));
vi.mock("@polaris/auth", () => ({
    consumeSessionRotation: async () => false,
    markPrincipalsMoved: async (userIds: string[]) => principalsMoved(userIds as never),
    rememberAccountDevice: async () => undefined,
    resolveSignInRules: async () => ({ allowedCidrs: [], allowedCountries: [], allowedContinents: [] }),
    takeSignInRecord: async () => ({ method: null, secondFactor: null }),
    updateEnforcedRules: async () => undefined
}));
vi.mock("@polaris/db", () => ({
    prisma: {
        sessionState: { findMany: async () => states },
        session: {
            deleteMany: async ({ where }: { where: { id: { in: string[] } } }) => {
                deleted = where.id.in;
                return { count: deleted.length };
            }
        }
    }
}));

const { setUserLimits } = await import("../../src/lib/user-admin-service");

const RULES = { groupIds: [], allowedCidrs: [OFFICE], allowedCountries: [], allowedContinents: [] };

beforeEach(() => {
    // A desk and a phone behind the office router, and a laptop at home.
    states = [
        { sessionId: DESK, ip: OFFICE },
        { sessionId: PHONE, ip: OFFICE },
        { sessionId: LAPTOP, ip: HOME }
    ];
    permitted = [OFFICE];
    deleted = [];
    verdicts = 0;
    audit = null;
    principalsMoved.mockClear();
});

describe("imposing a limit on an account", () => {
    it("ends only the sessions the new rules refuse", async () => {
        expect(await setUserLimits(ADMIN, USER, RULES)).toEqual({});
        expect(deleted).toEqual([LAPTOP]);
    });

    it("judges each address once, however many sessions sit behind it", async () => {
        await setUserLimits(ADMIN, USER, RULES);
        expect(verdicts).toBe(2);
    });

    it("ends nothing when every open session is still allowed", async () => {
        permitted = [OFFICE, HOME];
        await setUserLimits(ADMIN, USER, RULES);
        expect(deleted).toEqual([]);
        expect(audit?.metadata).toMatchObject({ sessionsEnded: 0 });
    });

    it("records how many sessions the limit closed", async () => {
        await setUserLimits(ADMIN, USER, RULES);
        expect(audit).toMatchObject({ action: "user.limits", targetId: USER });
        expect(audit?.metadata).toMatchObject({ sessionsEnded: 1 });
    });

    it("re-decides the account for the guards it is not the session store of", async () => {
        // Services behind a Polaris login are guarded offline from a signed token,
        // so the limit has to reach them even when no session ended here.
        permitted = [OFFICE, HOME];
        await setUserLimits(ADMIN, USER, RULES);
        expect(principalsMoved).toHaveBeenCalledWith([USER]);
    });
});
