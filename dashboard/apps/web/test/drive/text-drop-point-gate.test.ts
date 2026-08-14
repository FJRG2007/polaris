/**
 * What a text drop point accepts from a stranger.
 *
 * The public page decides what to DRAW; this action decides what to STORE, and
 * it has to hold on its own - somebody sending straight to it never saw the page
 * at all. So every gate is asserted here rather than in the page: closed, wrong
 * network, not signed in when the owner asked for that, not on the list,
 * password not solved, over the length, past the cap, and sealed when sealing
 * was never allowed.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const OWNER = "018f2b7a-0000-7000-8000-0000000000a1";
const REQUEST = "018f2b7a-0000-7000-8000-0000000000c1";

const resolveByToken = vi.fn();
const usability = vi.fn(() => ({ ok: true }) as { ok: boolean; reason?: string });
const userAllowed = vi.fn(async () => true);
const verifyUnlock = vi.fn(() => true);
const submitText = vi.fn(async () => ({ ok: true, snippetId: "snip-1" }));
const addressDenial = vi.fn(async () => null as string | null);
const dymo = vi.fn(async () => ({ allowed: true }));
const rateLimit = vi.fn(async () => ({ ok: true }));
const notify = vi.fn(async () => undefined);
const getCookie = vi.fn(() => ({ value: "solved" }) as { value: string } | undefined);
const session = vi.fn(async () => null as { user?: { id: string } } | null);

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/headers", () => ({
    cookies: async () => ({ get: getCookie, set: () => {} })
}));
vi.mock("@polaris/config", () => ({
    loadEnv: () => ({ POLARIS_AUTH_SECRET: "s", POLARIS_SECURE_COOKIES: true })
}));
vi.mock("@/lib/session", () => ({
    getSession: session,
    requirePermission: async () => ({ id: OWNER })
}));
vi.mock("@/lib/audit-service", () => ({ recordAudit: async () => undefined }));
vi.mock("@/lib/notifications/dispatch", () => ({ notify }));
vi.mock("@/lib/dymo-service", () => ({ dymoIpAllowed: dymo }));
vi.mock("@/lib/link-guards", () => ({ linkAddressDenial: addressDenial }));
vi.mock("@/lib/public-reach", () => ({ ensureShareReachability: async () => undefined }));
vi.mock("@/lib/request-context", () => ({
    clientIp: async () => "1.2.3.4",
    hashForLog: () => "h"
}));
vi.mock("@/lib/rate-limit-service", () => ({ rateLimit, resetRateLimit: async () => undefined }));
vi.mock("@/lib/text-request-service", () => ({
    resolveTextRequestByToken: resolveByToken,
    textRequestUsability: usability,
    textRequestUserAllowed: userAllowed,
    textRequestUnlockCookie: () => "cookie",
    verifyTextRequestUnlock: verifyUnlock,
    submitText,
    createTextRequest: async () => ({ id: REQUEST, token: "t" }),
    updateTextRequest: async () => undefined,
    revokeTextRequest: async () => undefined,
    reopenTextRequest: async () => undefined,
    deleteTextRequest: async () => true,
    revealTextRequestLink: async () => null,
    verifyTextRequestPassword: async () => true,
    signTextRequestUnlock: () => "signed",
    countTextSubmissions: async () => 0
}));

const { submitTextAction } = await import(
    "../../src/app/(app)/drive/drop-points/text-request-actions"
);

/** An open drop point with no restrictions on it. */
const OPEN = {
    id: REQUEST,
    ownerId: OWNER,
    title: "Send me your .env",
    requireLogin: false,
    allowSealed: false,
    allowedUsers: "[]",
    maxLength: 100,
    maxSubmissions: null,
    passwordHash: null,
    allowedCidrs: "[]",
    allowedCountries: "[]",
    allowedContinents: "[]",
    startsAt: null,
    expiresAt: null,
    revokedAt: null
};

const BODY = { name: "a.env", body: "A=1" };

beforeEach(() => {
    vi.clearAllMocks();
    resolveByToken.mockResolvedValue(OPEN);
    usability.mockReturnValue({ ok: true });
    userAllowed.mockResolvedValue(true);
    verifyUnlock.mockReturnValue(true);
    addressDenial.mockResolvedValue(null);
    dymo.mockResolvedValue({ allowed: true });
    rateLimit.mockResolvedValue({ ok: true });
    submitText.mockResolvedValue({ ok: true, snippetId: "snip-1" });
    session.mockResolvedValue(null);
});

describe("submitTextAction", () => {
    it("stores a submission to an open drop point and tells its owner", async () => {
        expect(await submitTextAction("tok", BODY)).toEqual({ ok: true });
        expect(submitText).toHaveBeenCalled();
        expect(notify).toHaveBeenCalledWith(expect.objectContaining({ userId: OWNER }));
    });

    it("refuses a link that resolves to nothing", async () => {
        resolveByToken.mockResolvedValueOnce(null);
        expect((await submitTextAction("tok", BODY)).error).toBeDefined();
        expect(submitText).not.toHaveBeenCalled();
    });

    it("refuses a closed drop point, and says so differently before it opens", async () => {
        usability.mockReturnValueOnce({ ok: false, reason: "revoked" });
        expect((await submitTextAction("tok", BODY)).error).toContain("closed");
        usability.mockReturnValueOnce({ ok: false, reason: "scheduled" });
        expect((await submitTextAction("tok", BODY)).error).toContain("not open yet");
        expect(submitText).not.toHaveBeenCalled();
    });

    it("refuses an address the rules exclude, and one the fraud check flags", async () => {
        addressDenial.mockResolvedValueOnce("ip_not_allowed");
        expect((await submitTextAction("tok", BODY)).error).toContain("network");
        dymo.mockResolvedValueOnce({ allowed: false });
        expect((await submitTextAction("tok", BODY)).error).toContain("network");
        expect(submitText).not.toHaveBeenCalled();
    });

    it("refuses an anonymous sender when the owner asked for a name", async () => {
        resolveByToken.mockResolvedValueOnce({ ...OPEN, requireLogin: true });
        expect((await submitTextAction("tok", BODY)).error).toContain("Sign in");
        expect(submitText).not.toHaveBeenCalled();
    });

    it("refuses somebody who is signed in but not on the list", async () => {
        session.mockResolvedValueOnce({ user: { id: "someone-else" } });
        userAllowed.mockResolvedValueOnce(false);
        expect((await submitTextAction("tok", BODY)).error).toContain("does not accept");
        expect(submitText).not.toHaveBeenCalled();
    });

    it("refuses when the password has not been solved, whatever the page showed", async () => {
        resolveByToken.mockResolvedValueOnce({ ...OPEN, passwordHash: "scrypt$..." });
        verifyUnlock.mockReturnValueOnce(false);
        expect((await submitTextAction("tok", BODY)).error).toContain("protected");
        expect(submitText).not.toHaveBeenCalled();
    });

    it("caps how much one address can send, whatever the drop point allows", async () => {
        rateLimit.mockResolvedValueOnce({ ok: false });
        expect((await submitTextAction("tok", BODY)).error).toContain("Too many");
        expect(submitText).not.toHaveBeenCalled();
    });

    it("refuses a submission with nothing in it", async () => {
        expect((await submitTextAction("tok", { name: "a.env", body: "" })).error).toBeDefined();
        expect(submitText).not.toHaveBeenCalled();
    });

    it("reports the store's own refusals in the sender's terms", async () => {
        submitText.mockResolvedValueOnce({ ok: false, reason: "too_long" });
        expect((await submitTextAction("tok", BODY)).error).toContain("100");
        submitText.mockResolvedValueOnce({ ok: false, reason: "full" });
        expect((await submitTextAction("tok", BODY)).error).toContain("everything");
        submitText.mockResolvedValueOnce({ ok: false, reason: "sealed_not_allowed" });
        expect((await submitTextAction("tok", BODY)).error).toContain("sealed");
        expect(notify).not.toHaveBeenCalled();
    });
});
