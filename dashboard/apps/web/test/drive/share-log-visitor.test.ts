/**
 * Who opened a shared link, when they were signed in.
 *
 * A share or snippet link needs no session, but a visitor who has one is
 * recorded against the access-log row so the owner can tell a colleague from an
 * address. What is pinned here is where that identity comes from - the
 * request's own session, through the same resolution every background route
 * uses - and what happens when there is no usable one: the row is written
 * anyway, anonymous, and nothing fails. The session module is the real one;
 * only better-auth and the guard underneath it are answered per test.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const VISITOR = "0198f0a0-0000-7000-8000-0000000000a1";
const ADMIN = "0198f0a0-0000-7000-8000-0000000000a2";
const SHARE = "0198f0a0-0000-7000-8000-0000000000b1";
const SNIPPET = "0198f0a0-0000-7000-8000-0000000000c1";

const getSession = vi.fn();
const guardSession = vi.fn();
const resolveViewAs = vi.fn();
const shareLogCreate = vi.fn(async () => ({}));
const snippetLogCreate = vi.fn(async () => ({}));
const shareFindUnique = vi.fn();

vi.mock("next/headers", () => ({
    headers: async () => new Headers(),
    cookies: async () => ({ get: () => undefined })
}));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/lib/auth", () => ({ auth: { api: { getSession } } }));
vi.mock("@/lib/session-guard", () => ({ guardSession }));
vi.mock("@/lib/view-as-service", () => ({ resolveViewAs }));
vi.mock("@/lib/apps/install-presence", () => ({ isAppInstalled: async () => true }));
vi.mock("@polaris/auth", () => ({ canAny: vi.fn(), userHasPermission: vi.fn() }));
vi.mock("@polaris/db", () => ({
    prisma: {
        share: { findUnique: shareFindUnique },
        shareAccessLog: { create: shareLogCreate },
        snippetAccessLog: { create: snippetLogCreate }
    }
}));
vi.mock("@polaris/config", () => ({ loadEnv: () => ({ POLARIS_AUTH_SECRET: "s" }) }));
vi.mock("@/lib/domain-service", () => ({ sharingBaseUrl: async () => "https://links.test" }));
vi.mock("@/lib/geo-service", () => ({ geoAllowedForIp: vi.fn(async () => true) }));
vi.mock("@/lib/dymo-service", () => ({ dymoIpAllowed: async () => ({ allowed: true }) }));

const { logShareAccess } = await import("@/lib/share-service");
const { logSnippetAccess } = await import("@/lib/snippet-service");
const { gateShareRequest } = await import("@/lib/share-access");

const SIGNED_IN = {
    user: { id: VISITOR, email: "visitor@example.test", name: "Visitor", isAdmin: false },
    session: { id: "s1", createdAt: new Date("2026-01-01T00:00:00Z").toISOString() }
};
const CLEARED = { ok: true, view: { viewAsUserId: null, viewAsRoleId: null, viewAsAt: null } };

/** Every action a share link records today, across its page and its routes. A
 *  preview is the download route with an inline disposition, logged as one. */
const SHARE_ACTIONS = ["view", "download", "upload", "mkdir", "rename", "delete"];
/** And every one a snippet link records. */
const SNIPPET_ACTIONS = ["view", "raw", "download", "open", "burn"];

function sharedRow(): Record<string, unknown> {
    return (shareLogCreate.mock.calls.at(-1) as unknown as [{ data: Record<string, unknown> }])[0]
        .data;
}
function snippetRow(): Record<string, unknown> {
    return (snippetLogCreate.mock.calls.at(-1) as unknown as [{ data: Record<string, unknown> }])[0]
        .data;
}

beforeEach(() => {
    vi.clearAllMocks();
    getSession.mockResolvedValue(SIGNED_IN);
    guardSession.mockResolvedValue(CLEARED);
    resolveViewAs.mockResolvedValue(null);
});

describe("a visitor with a valid session", () => {
    for (const action of SHARE_ACTIONS) {
        it(`is recorded on a share's ${action}`, async () => {
            await logShareAccess({ shareId: SHARE, action, ip: "203.0.113.4" });
            expect(sharedRow()).toMatchObject({
                shareId: SHARE,
                action,
                ip: "203.0.113.4",
                userId: VISITOR
            });
        });
    }

    for (const action of SNIPPET_ACTIONS) {
        it(`is recorded on a snippet's ${action}`, async () => {
            await logSnippetAccess({ snippetId: SNIPPET, action });
            expect(snippetRow()).toMatchObject({ snippetId: SNIPPET, action, userId: VISITOR });
        });
    }

    it("is recorded on a refusal too", async () => {
        await logShareAccess({ shareId: SHARE, action: "download", reason: "exhausted" });
        expect(sharedRow()).toMatchObject({ reason: "exhausted", userId: VISITOR });
    });

    it("is recorded by the shared gate when it turns a visit away", async () => {
        shareFindUnique.mockResolvedValue({
            id: SHARE,
            passwordHash: null,
            maxDownloads: null,
            downloadCount: 0,
            expiresAt: null,
            revokedAt: new Date("2026-01-01T00:00:00Z"),
            allowedCidrs: "[]",
            allowedCountries: "[]",
            allowedContinents: "[]"
        });
        const gate = await gateShareRequest("token", "download");
        expect(gate).toMatchObject({ ok: false, status: 410 });
        await vi.waitFor(() => expect(shareLogCreate).toHaveBeenCalled());
        expect(sharedRow()).toMatchObject({
            action: "download",
            reason: "revoked",
            userId: VISITOR
        });
    });

    it("never takes the account from the caller", async () => {
        const forged = { shareId: SHARE, action: "view", userId: ADMIN } as Parameters<
            typeof logShareAccess
        >[0];
        await logShareAccess(forged);
        expect(sharedRow().userId).toBe(VISITOR);

        const forgedSnippet = { snippetId: SNIPPET, action: "view", userId: ADMIN } as Parameters<
            typeof logSnippetAccess
        >[0];
        await logSnippetAccess(forgedSnippet);
        expect(snippetRow().userId).toBe(VISITOR);
    });

    it("is an administrator's own account while they look at Polaris as somebody else", async () => {
        resolveViewAs.mockResolvedValue({
            mode: "user",
            actorId: ADMIN,
            actorName: "Admin",
            label: "Visitor",
            startedAt: "2026-01-01T00:00:00Z",
            endsAt: "2026-01-01T01:00:00Z",
            user: {
                id: VISITOR,
                email: "visitor@example.test",
                name: "Visitor",
                image: null,
                isAdmin: false
            }
        });
        await logShareAccess({ shareId: SHARE, action: "view" });
        expect(sharedRow().userId).toBe(ADMIN);
    });

    it("does not count the visit as activity on the visitor's session", async () => {
        await logShareAccess({ shareId: SHARE, action: "view" });
        expect(guardSession).toHaveBeenCalledWith(expect.objectContaining({ touch: false }));
    });
});

describe("a visitor with no usable session is anonymous, and the visit is still logged", () => {
    it("when there is no session at all", async () => {
        getSession.mockResolvedValue(null);
        await logShareAccess({ shareId: SHARE, action: "view" });
        expect(sharedRow()).toMatchObject({ action: "view", userId: null });
        await logSnippetAccess({ snippetId: SNIPPET, action: "view" });
        expect(snippetRow()).toMatchObject({ action: "view", userId: null });
    });

    it("when the session has expired", async () => {
        // better-auth answers an expired session as no session.
        getSession.mockResolvedValue(null);
        await logShareAccess({ shareId: SHARE, action: "download" });
        expect(sharedRow()).toMatchObject({ action: "download", userId: null });
    });

    it("when the cookie cannot be verified", async () => {
        getSession.mockRejectedValue(new Error("Unsupported state or unable to authenticate data"));
        await logShareAccess({ shareId: SHARE, action: "view" });
        expect(sharedRow()).toMatchObject({ action: "view", userId: null });
        await logSnippetAccess({ snippetId: SNIPPET, action: "raw" });
        expect(snippetRow()).toMatchObject({ action: "raw", userId: null });
    });

    for (const redirect of ["/oauth/pending", "/oauth/lock", "/oauth/login?blocked=1"]) {
        it(`when the account's own controls refuse the session (${redirect})`, async () => {
            guardSession.mockResolvedValue({ ok: false, redirect });
            await logShareAccess({ shareId: SHARE, action: "view" });
            expect(sharedRow()).toMatchObject({ action: "view", userId: null });
        });
    }

    it("when resolving the session fails outright", async () => {
        guardSession.mockRejectedValue(new Error("database unavailable"));
        await expect(logShareAccess({ shareId: SHARE, action: "view" })).resolves.toBeUndefined();
        expect(sharedRow()).toMatchObject({ action: "view", userId: null });
    });
});
