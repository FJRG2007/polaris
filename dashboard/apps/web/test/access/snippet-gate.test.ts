/**
 * The gate in front of a shared snippet.
 *
 * Everything public about a snippet - the page, the raw endpoint, the one-time
 * reveal - goes through this one function, so what is asserted here is the order
 * it refuses in and the cases that must never get through: a snippet that is not
 * shared at all, one shared with named people opened by somebody else, and one
 * whose password has not been solved. The owner opening their own invite-only
 * snippet is the case that reads as a bug when it is refused, so it is pinned
 * too.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const OWNER = "018f2b7a-0000-7000-8000-0000000000a1";
const OTHER = "018f2b7a-0000-7000-8000-0000000000a2";
const SNIPPET = "018f2b7a-0000-7000-8000-0000000000b1";

const resolveByToken = vi.fn();
const usability = vi.fn(() => ({ ok: true }) as { ok: boolean; reason?: string });
const verifyUnlock = vi.fn(() => true);
const logAccess = vi.fn(async () => undefined);
const addressDenial = vi.fn(async () => null as string | null);
const dymo = vi.fn(async () => ({ allowed: true }));
const session = vi.fn(async () => null as { user?: { id: string } } | null);

vi.mock("next/headers", () => ({
    cookies: async () => ({ get: () => ({ value: "solved" }) })
}));
vi.mock("@polaris/config", () => ({ loadEnv: () => ({ POLARIS_AUTH_SECRET: "s" }) }));
vi.mock("@/lib/session", () => ({ getSession: session }));
vi.mock("@/lib/dymo-service", () => ({ dymoIpAllowed: dymo }));
vi.mock("@/lib/link-guards", () => ({ linkAddressDenial: addressDenial }));
vi.mock("@/lib/request-context", () => ({
    clientIp: async () => "1.2.3.4",
    clientUserAgent: async () => "agent",
    hashForLog: () => "h"
}));
vi.mock("@/lib/snippet-service", () => ({
    resolveSnippetByToken: resolveByToken,
    snippetUsability: usability,
    snippetUnlockCookie: () => "cookie",
    verifySnippetUnlock: verifyUnlock,
    logSnippetAccess: logAccess
}));

const { gateSnippetRequest, snippetDenialMessage } = await import("../../src/lib/snippet-access");

/** A snippet shared with anyone holding the link, under no other rule. */
const OPEN = {
    id: SNIPPET,
    ownerId: OWNER,
    title: "config",
    description: null,
    visibility: "link",
    clientSealed: false,
    burnAfterRead: false,
    passwordHash: null,
    maxViews: null,
    viewCount: 0,
    expiresAt: null,
    revokedAt: null,
    allowedCidrs: "[]",
    allowedCountries: "[]",
    allowedContinents: "[]",
    createdAt: new Date("2026-01-01T00:00:00Z"),
    invites: [] as { userId: string }[]
};

beforeEach(() => {
    vi.clearAllMocks();
    resolveByToken.mockResolvedValue(OPEN);
    usability.mockReturnValue({ ok: true });
    verifyUnlock.mockReturnValue(true);
    addressDenial.mockResolvedValue(null);
    dymo.mockResolvedValue({ allowed: true });
    session.mockResolvedValue(null);
});

describe("gateSnippetRequest", () => {
    it("serves an open snippet to a stranger", async () => {
        const gate = await gateSnippetRequest("tok", "view");
        expect(gate.ok).toBe(true);
        // A success is not logged here: each caller records what it actually did.
        expect(logAccess).not.toHaveBeenCalled();
    });

    it("404s a token that resolves to nothing, and logs nothing about it", async () => {
        resolveByToken.mockResolvedValueOnce(null);
        const gate = await gateSnippetRequest("tok", "view");
        expect(gate).toEqual({ ok: false, status: 404, reason: "not_found" });
        expect(logAccess).not.toHaveBeenCalled();
    });

    it("refuses a private snippet whatever token was presented", async () => {
        // A hash collision is not the threat: this is the snippet whose link was
        // turned off, being reached by somebody who kept the URL.
        resolveByToken.mockResolvedValueOnce({ ...OPEN, visibility: "private" });
        const gate = await gateSnippetRequest("tok", "view");
        expect(gate).toMatchObject({ ok: false, status: 410, reason: "revoked" });
    });

    it("passes an expiry or a spent view cap through as the reason", async () => {
        usability.mockReturnValueOnce({ ok: false, reason: "expired" });
        expect(await gateSnippetRequest("tok", "view")).toMatchObject({ reason: "expired" });
        usability.mockReturnValueOnce({ ok: false, reason: "exhausted" });
        expect(await gateSnippetRequest("tok", "view")).toMatchObject({ reason: "exhausted" });
    });

    it("refuses an address the rules exclude before it looks at anything else", async () => {
        addressDenial.mockResolvedValueOnce("country_not_allowed");
        const gate = await gateSnippetRequest("tok", "view");
        expect(gate).toMatchObject({ ok: false, status: 403, reason: "country_not_allowed" });
        // The fraud check is not even reached: the owner's own rule already said no.
        expect(dymo).not.toHaveBeenCalled();
    });

    it("refuses an address the fraud check flags", async () => {
        dymo.mockResolvedValueOnce({ allowed: false });
        expect(await gateSnippetRequest("tok", "view")).toMatchObject({ reason: "ip_flagged" });
    });

    it("asks an anonymous visitor to sign in for an invite-only snippet", async () => {
        resolveByToken.mockResolvedValueOnce({ ...OPEN, visibility: "invite" });
        expect(await gateSnippetRequest("tok", "view")).toMatchObject({
            ok: false,
            status: 401,
            reason: "sign_in_required"
        });
    });

    it("refuses a signed-in visitor who was not invited", async () => {
        resolveByToken.mockResolvedValueOnce({
            ...OPEN,
            visibility: "invite",
            invites: [{ userId: "somebody" }]
        });
        session.mockResolvedValueOnce({ user: { id: OTHER } });
        expect(await gateSnippetRequest("tok", "view")).toMatchObject({
            ok: false,
            status: 403,
            reason: "not_invited"
        });
    });

    it("lets the invited person in", async () => {
        resolveByToken.mockResolvedValueOnce({
            ...OPEN,
            visibility: "invite",
            invites: [{ userId: OTHER }]
        });
        session.mockResolvedValueOnce({ user: { id: OTHER } });
        expect((await gateSnippetRequest("tok", "view")).ok).toBe(true);
    });

    it("lets the owner open their own invite-only snippet without inviting themselves", async () => {
        resolveByToken.mockResolvedValueOnce({ ...OPEN, visibility: "invite", invites: [] });
        session.mockResolvedValueOnce({ user: { id: OWNER } });
        expect((await gateSnippetRequest("tok", "view")).ok).toBe(true);
    });

    it("refuses when the password marker is missing or forged", async () => {
        resolveByToken.mockResolvedValueOnce({ ...OPEN, passwordHash: "scrypt$..." });
        verifyUnlock.mockReturnValueOnce(false);
        expect(await gateSnippetRequest("tok", "view")).toMatchObject({
            ok: false,
            status: 401,
            reason: "password_required"
        });
    });

    it("records every refusal against the snippet, with the action that was tried", async () => {
        usability.mockReturnValueOnce({ ok: false, reason: "expired" });
        await gateSnippetRequest("tok", "raw");
        expect(logAccess).toHaveBeenCalledWith(
            expect.objectContaining({ snippetId: SNIPPET, action: "raw", reason: "expired" })
        );
    });
});

describe("snippetDenialMessage", () => {
    it("has words for every reason the gate can return", () => {
        for (const reason of [
            "not_found",
            "revoked",
            "expired",
            "exhausted",
            "scheduled",
            "ip_not_allowed",
            "country_not_allowed",
            "ip_flagged",
            "sign_in_required",
            "not_invited",
            "password_required"
        ]) {
            expect(snippetDenialMessage(reason)).not.toBe("This link is not available.");
        }
    });

    it("falls back rather than leaking an unmapped reason", () => {
        expect(snippetDenialMessage("something_new")).toBe("This link is not available.");
    });
});
