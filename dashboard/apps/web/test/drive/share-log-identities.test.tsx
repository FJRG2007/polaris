/**
 * Who sees the accounts in a shared link's access log, and how they are drawn.
 *
 * The identity of a signed-in visitor is shown in exactly the place the log was
 * already shown: to the owner of the link, through the same owner-scoped read.
 * Anybody else asking for the log gets nothing, identities included. The owner
 * is told who it was - a name and the handle that opens their profile - and is
 * handed an email address only when the account has nothing else to go by.
 */

import { withMessages } from "../setup/i18n";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const OWNER = "0198f0a0-0000-7000-8000-0000000000a1";
const STRANGER = "0198f0a0-0000-7000-8000-0000000000a2";
const VISITOR = "0198f0a0-0000-7000-8000-0000000000a3";
const SHARE = "0198f0a0-0000-7000-8000-0000000000b1";
const SNIPPET = "0198f0a0-0000-7000-8000-0000000000c1";
const AT = new Date("2026-10-01T10:00:00Z");

const shareCount = vi.fn();
const snippetCount = vi.fn();
const shareLogs = vi.fn();
const snippetLogs = vi.fn();
const requirePermission = vi.fn();

vi.mock("@polaris/db", () => ({
    prisma: {
        share: { count: shareCount },
        snippet: { count: snippetCount },
        shareAccessLog: { findMany: shareLogs },
        snippetAccessLog: { findMany: snippetLogs }
    }
}));
vi.mock("@/lib/session", () => ({ requirePermission }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {}, refresh: () => {} }) }));
vi.mock("@polaris/config", () => ({ loadEnv: () => ({ POLARIS_AUTH_SECRET: "s" }) }));
vi.mock("@/lib/domain-service", () => ({ sharingBaseUrl: async () => "https://links.test" }));
vi.mock("@/lib/public-reach", () => ({ ensureShareReachability: vi.fn() }));
vi.mock("@/lib/audit-service", () => ({ recordAudit: vi.fn() }));
vi.mock("@/lib/rate-limit-service", () => ({ rateLimit: vi.fn(), resetRateLimit: vi.fn() }));
vi.mock("@/lib/geo-service", () => ({ geoAllowedForIp: vi.fn(async () => true) }));
vi.mock("@/lib/dymo-service", () => ({ dymoIpAllowed: async () => ({ allowed: true }) }));
vi.mock("@/lib/storage-service", () => ({ getDriverForConnection: vi.fn() }));

const { listShareAccessLogs } = await import("@/lib/share-service");
const { listSnippetAccessLogs } = await import("@/lib/snippet-service");
const { getShareLogsAction } = await import("../../src/app/(app)/drive/share-actions");
const { getSnippetLogsAction } = await import("../../src/app/(app)/drive/snippets/snippet-actions");
const { LinkVisitorCell, signedInVisitors } = await import(
    "../../src/app/(app)/drive/link-visitor-cell"
);
const { toLinkVisitor } = await import("@/lib/link-visitor");

const ROWS = [
    {
        id: "l1",
        at: AT,
        ip: "203.0.113.4",
        action: "view",
        reason: null,
        user: { id: VISITOR, name: "Ada Lovelace", username: "ada", email: "ada@example.test" }
    },
    { id: "l2", at: AT, ip: "198.51.100.7", action: "download", reason: null, user: null }
];

beforeEach(() => {
    vi.clearAllMocks();
    requirePermission.mockResolvedValue({ id: OWNER });
    shareLogs.mockResolvedValue(ROWS);
    snippetLogs.mockResolvedValue(ROWS);
});

describe("only the owner reads the log, identities included", () => {
    it("hands the owner each row with the visitor's account", async () => {
        shareCount.mockResolvedValue(1);
        const logs = await listShareAccessLogs(OWNER, SHARE);
        expect(shareCount).toHaveBeenCalledWith({ where: { id: SHARE, ownerId: OWNER } });
        expect(logs).toHaveLength(2);
        expect(shareLogs).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { shareId: SHARE },
                select: expect.objectContaining({ user: expect.anything() })
            })
        );
    });

    it("hands anybody else nothing, and never reads the rows", async () => {
        shareCount.mockResolvedValue(0);
        expect(await listShareAccessLogs(STRANGER, SHARE)).toEqual([]);
        expect(shareLogs).not.toHaveBeenCalled();

        snippetCount.mockResolvedValue(0);
        expect(await listSnippetAccessLogs(STRANGER, SNIPPET)).toEqual([]);
        expect(snippetLogs).not.toHaveBeenCalled();
    });

    it("asks for the log as the signed-in caller, not as anybody the request names", async () => {
        shareCount.mockResolvedValue(0);
        requirePermission.mockResolvedValue({ id: STRANGER });
        expect(await getShareLogsAction(SHARE)).toEqual({ logs: [] });
        expect(shareCount).toHaveBeenCalledWith({ where: { id: SHARE, ownerId: STRANGER } });
        expect(requirePermission).toHaveBeenCalledWith("shares.create");
    });

    it("refuses a caller without the permission before reading anything", async () => {
        requirePermission.mockRejectedValue(new Error("NEXT_REDIRECT"));
        await expect(getShareLogsAction(SHARE)).rejects.toThrow();
        await expect(getSnippetLogsAction(SNIPPET)).rejects.toThrow();
        expect(shareCount).not.toHaveBeenCalled();
        expect(snippetCount).not.toHaveBeenCalled();
    });

    it("shapes each row for the owner's screen", async () => {
        shareCount.mockResolvedValue(1);
        const { logs } = await getShareLogsAction(SHARE);
        expect(logs[0]).toEqual({
            id: "l1",
            at: AT.toISOString(),
            ip: "203.0.113.4",
            action: "view",
            reason: null,
            visitor: { id: VISITOR, name: "Ada Lovelace", username: "ada" }
        });
        expect(logs[1]?.visitor).toBeNull();

        snippetCount.mockResolvedValue(1);
        const snippet = await getSnippetLogsAction(SNIPPET);
        expect(snippet.logs[0]?.visitor).toEqual({
            id: VISITOR,
            name: "Ada Lovelace",
            username: "ada"
        });
        expect(snippet.logs[1]?.visitor).toBeNull();
    });
});

describe("what the owner is told about a visitor", () => {
    it("is the name and the handle, and no email address", () => {
        expect(
            toLinkVisitor({ id: VISITOR, name: "Ada", username: "ada", email: "ada@example.test" })
        ).toEqual({
            id: VISITOR,
            name: "Ada",
            username: "ada"
        });
    });

    it("falls back to the handle, then the email, when there is no name", () => {
        expect(
            toLinkVisitor({ id: VISITOR, name: "  ", username: "ada", email: "ada@example.test" })
                ?.name
        ).toBe("ada");
        expect(
            toLinkVisitor({ id: VISITOR, name: "", username: null, email: "ada@example.test" })
        ).toEqual({
            id: VISITOR,
            name: "ada@example.test",
            username: null
        });
    });

    it("is nobody for an anonymous row", () => {
        expect(toLinkVisitor(null)).toBeNull();
    });
});

describe("the Who column", () => {
    it("draws a signed-in visitor's face and a name that opens their profile", () => {
        const html = renderToStaticMarkup(
            withMessages(
                <LinkVisitorCell visitor={{ id: VISITOR, name: "Ada Lovelace", username: "ada" }} />
            )
        );
        expect(html).toContain("Ada Lovelace");
        expect(html).toContain('href="/u/ada"');
        expect(html).toContain(`/api/avatar/${VISITOR}`);
        expect(html).toContain("Open Ada Lovelace&#x27;s profile");
    });

    it("draws the name as text when there is no profile to open", () => {
        const html = renderToStaticMarkup(
            withMessages(
                <LinkVisitorCell
                    visitor={{ id: VISITOR, name: "ada@example.test", username: null }}
                />
            )
        );
        expect(html).toContain("ada@example.test");
        expect(html).not.toContain("<a ");
    });

    it("says Anonymous for a visitor who was not signed in, in each language", () => {
        expect(renderToStaticMarkup(withMessages(<LinkVisitorCell visitor={null} />))).toContain(
            "Anonymous"
        );
        expect(
            renderToStaticMarkup(withMessages(<LinkVisitorCell visitor={null} />, "es-ES"))
        ).toContain("Anónimo");
    });

    it("counts each account once, and nobody for anonymous rows", () => {
        const visitor = { id: VISITOR, name: "Ada", username: "ada" };
        expect(signedInVisitors([{ visitor }, { visitor }, { visitor: null }])).toBe(1);
        expect(signedInVisitors([{ visitor: null }])).toBe(0);
        expect(signedInVisitors([])).toBe(0);
    });
});
