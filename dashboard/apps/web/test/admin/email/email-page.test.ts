/**
 * Email & SMS lives under Management > Integrations, and the Polaris mail server
 * choice in its Add sender dialog reads where the mail server stands.
 *
 * The page kept the permission it had before it moved (`inbox.read`), because
 * every role that could add a sender holds that one and the move must not take a
 * sender away from anybody. The old Inbox channels screen is gone, with no
 * forward to the new address (moved pages are not redirected while in beta).
 */

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { requirePermission, sessionCan, mailServerAppInstalled, listServers, findMany } = vi.hoisted(() => ({
    requirePermission: vi.fn(),
    sessionCan: vi.fn(),
    mailServerAppInstalled: vi.fn(),
    listServers: vi.fn(),
    findMany: vi.fn()
}));

vi.mock("@/lib/session", () => ({ requirePermission, sessionCan }));
vi.mock("@/lib/i18n/request", () => ({ getTranslations: async () => (key: string) => key }));
vi.mock("@/app/(app)/admin/integrations/email/loader", () => ({ EmailAdminLoader: () => null }));
vi.mock("@/lib/workspace-scope", () => ({ scopeOrgIdFor: async () => null }));
vi.mock("@/lib/mail-server/app-install", () => ({ mailServerAppInstalled }));
vi.mock("@/lib/mail-server/access", () => {
    class MailServerAccessError extends Error {}
    return { listServers, MailServerAccessError };
});
vi.mock("@polaris/db", () => ({ prisma: { channel: { findMany } } }));

import { MailServerAccessError } from "@/lib/mail-server/access";
import EmailPage from "@/app/(app)/admin/integrations/email/page";
import { polarisMailStateAction } from "@/app/(app)/admin/integrations/email/mail-server-sender";

const ADMIN_ROUTES = resolve(__dirname, "../../../src/app/(app)/admin");

const member = { id: "user-1", isAdmin: false };
const admin = { id: "admin-1", isAdmin: true };

function server(overrides: Record<string, unknown>) {
    return {
        id: "srv-1",
        hostname: "mail.example.test",
        status: "ready",
        channelId: null,
        ...overrides
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    requirePermission.mockResolvedValue(member);
    sessionCan.mockResolvedValue(true);
    mailServerAppInstalled.mockResolvedValue(true);
    listServers.mockResolvedValue([]);
    findMany.mockResolvedValue([]);
});

describe("the Email & SMS page", () => {
    it("is at Management > Integrations and asks for inbox.read", async () => {
        expect(existsSync(join(ADMIN_ROUTES, "integrations/email/page.tsx"))).toBe(true);
        await EmailPage();
        expect(requirePermission).toHaveBeenCalledWith("inbox.read");
    });

    it("left nothing behind at the old address", () => {
        expect(existsSync(join(ADMIN_ROUTES, "email"))).toBe(false);
    });
});

describe("the Polaris mail server choice", () => {
    it("needs inbox.manage to be asked at all", async () => {
        await polarisMailStateAction();
        expect(requirePermission).toHaveBeenCalledWith("inbox.manage");
    });

    it("says so to somebody who cannot manage mail servers", async () => {
        sessionCan.mockResolvedValue(false);
        expect(await polarisMailStateAction()).toEqual({ kind: "forbidden" });
        expect(sessionCan).toHaveBeenCalledWith(member, "mailserver.manage");
        expect(listServers).not.toHaveBeenCalled();
    });

    it("offers to turn the app on only to an administrator", async () => {
        mailServerAppInstalled.mockResolvedValue(false);
        expect(await polarisMailStateAction()).toEqual({ kind: "not-installed", canInstall: false });
        requirePermission.mockResolvedValue(admin);
        expect(await polarisMailStateAction()).toEqual({ kind: "not-installed", canInstall: true });
    });

    it("sends the reader to set a server up when there is none", async () => {
        expect(await polarisMailStateAction()).toEqual({ kind: "no-server" });
    });

    it("treats an organization shelf the reader cannot manage as forbidden", async () => {
        listServers.mockRejectedValue(new MailServerAccessError("no"));
        expect(await polarisMailStateAction()).toEqual({ kind: "forbidden" });
    });

    it("reports a server that already sends, by its sender's name", async () => {
        listServers.mockResolvedValue([server({ channelId: "ch-1" })]);
        findMany.mockResolvedValue([{ id: "ch-1", name: "mail.example.test" }]);
        expect(await polarisMailStateAction()).toEqual({
            kind: "sending",
            serverId: "srv-1",
            hostname: "mail.example.test",
            channelName: "mail.example.test"
        });
    });

    it("offers to create the sender again when the server's one was removed", async () => {
        listServers.mockResolvedValue([server({ channelId: "ch-gone" })]);
        findMany.mockResolvedValue([]);
        expect(await polarisMailStateAction()).toEqual({
            kind: "ready",
            serverId: "srv-1",
            hostname: "mail.example.test"
        });
    });

    it("prefers a ready server over one still being set up or one that failed", async () => {
        listServers.mockResolvedValue([
            server({ id: "srv-a", status: "failed" }),
            server({ id: "srv-b", status: "setting-up" }),
            server({ id: "srv-c", status: "ready", hostname: "mx.example.test" })
        ]);
        expect(await polarisMailStateAction()).toMatchObject({ kind: "ready", serverId: "srv-c" });
        listServers.mockResolvedValue([
            server({ id: "srv-a", status: "failed" }),
            server({ id: "srv-b", status: "setting-up" })
        ]);
        expect(await polarisMailStateAction()).toMatchObject({ kind: "setting-up", serverId: "srv-b" });
        listServers.mockResolvedValue([server({ id: "srv-a", status: "failed" })]);
        expect(await polarisMailStateAction()).toMatchObject({ kind: "failed", serverId: "srv-a" });
    });

    it("does not look channels up when no server has one", async () => {
        listServers.mockResolvedValue([server({})]);
        await polarisMailStateAction();
        expect(findMany).not.toHaveBeenCalled();
    });
});
