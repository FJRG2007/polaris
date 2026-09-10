/**
 * The Mail server screens before the app is installed.
 *
 * An old link, a pinned shortcut or a bookmark to a server still lands here
 * after an uninstall, and the answer must be the install - named, with the
 * button that does it - rather than a 404 or a crash. Somebody who may not
 * install apps is told who can, and offered no button that would refuse them.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

let installed: string | null;
let canInstall: boolean;

vi.mock("@/lib/session", () => ({
    requirePermission: async () => ({ id: "user-1", isAdmin: false }),
    sessionCan: async () => canInstall
}));
vi.mock("@/lib/mail-server/app-install", () => ({ adoptMailServerApp: async () => installed }));
vi.mock("@/lib/mail-server/access", () => ({
    requireServer: async (_actor: unknown, id: string) => ({ id, hostname: "mail.example.com" })
}));
vi.mock("next/navigation", () => ({
    notFound: () => {
        throw new Error("NEXT_NOT_FOUND");
    },
    useRouter: () => ({ push: () => undefined, refresh: () => undefined })
}));
// The actions module is the server's; the screens only need its names.
vi.mock("@/app/(app)/apps/mail-server/actions", () => ({
    installMailServerAppAction: async () => ({}),
    uninstallMailServerAppAction: async () => ({})
}));
vi.mock("@/app/(app)/apps/mail-server/mail-servers-view", () => ({
    MailServersView: ({ canUninstall }: { canUninstall: boolean }) => (
        <div data-list={String(canUninstall)} />
    )
}));
vi.mock("@/app/(app)/apps/mail-server/[id]/server-view", () => ({
    ServerView: ({ hostname }: { hostname: string }) => <div data-server={hostname} />
}));

const { default: ListPage } = await import("@/app/(app)/apps/mail-server/page");
const { default: DetailPage } = await import("@/app/(app)/apps/mail-server/[id]/page");

const SERVER_ID = "0190a0b0-0000-7000-8000-000000000001";

async function render(page: Promise<JSX.Element>): Promise<string> {
    return renderToStaticMarkup(await page);
}

beforeEach(() => {
    installed = null;
    canInstall = true;
});

describe("before the app is installed", () => {
    it("offers the install on the list, and a way to the marketplace", async () => {
        const html = await render(ListPage());
        expect(html).toContain("Install Mail server from the Marketplace");
        expect(html).toContain(">Install<");
        expect(html).toContain('href="/apps/marketplace?app=mail-server"');
        expect(html).not.toContain("data-list");
    });

    it("answers a link to a server with the same, not a 404", async () => {
        const html = await render(DetailPage({ params: Promise.resolve({ id: SERVER_ID }) }));
        expect(html).toContain("Install Mail server from the Marketplace");
        expect(html).not.toContain("data-server");
    });

    it("answers even a malformed link with the install", async () => {
        const html = await render(DetailPage({ params: Promise.resolve({ id: "not-an-id" }) }));
        expect(html).toContain("Install Mail server from the Marketplace");
    });

    it("offers no button to somebody who cannot install apps", async () => {
        canInstall = false;
        const html = await render(ListPage());
        expect(html).toContain("Ask somebody who can install apps to add it.");
        expect(html).not.toContain(">Install<");
    });
});

describe("once it is installed", () => {
    beforeEach(() => {
        installed = "install-1";
    });

    it("shows the servers, with Uninstall for whoever can install apps", async () => {
        expect(await render(ListPage())).toContain('data-list="true"');
        canInstall = false;
        expect(await render(ListPage())).toContain('data-list="false"');
    });

    it("opens a server", async () => {
        const html = await render(DetailPage({ params: Promise.resolve({ id: SERVER_ID }) }));
        expect(html).toContain('data-server="mail.example.com"');
    });

    it("still refuses a malformed link", async () => {
        await expect(DetailPage({ params: Promise.resolve({ id: "not-an-id" }) })).rejects.toThrow(
            "NEXT_NOT_FOUND"
        );
    });
});
