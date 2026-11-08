// @vitest-environment jsdom

/**
 * Marking an app read from the lists of apps: the Overview's rail carries a
 * mark beside a row whose badge is up, and a right click on an app - on the
 * rail or in the app menu - offers "Mark as read" only while the app has
 * something a mark dismisses. Both go through the launcher's own action, so
 * read means what the app means by it.
 */

import { withMessages } from "../setup/i18n";
import userEvent from "@testing-library/user-event";
import { HardDrive, Mail, MessageCircle } from "lucide-react";
import type { LauncherWaiting } from "@/lib/launcher-waiting";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const marked: unknown[] = [];
const nudges: [string, number][] = [];
let refuse = false;
const unread: Record<string, number> = { chat: 7, mail: 0 };

vi.mock("next/navigation", () => ({ usePathname: () => "/home" }));
vi.mock("@/app/(app)/app-launcher-actions", () => ({
    saveFavoriteAppsAction: async () => ({})
}));
vi.mock("@/app/(app)/launcher-waiting-actions", () => ({
    markLauncherReadAction: async (input: unknown) => {
        marked.push(input);
        return refuse ? { error: "That could not be marked." } : {};
    }
}));
vi.mock("@/components/notifications/notifications-provider", () => ({
    useHoldConversationNotices: () => () => ({ settle: () => undefined, abandon: () => undefined })
}));
vi.mock("@/components/app-unread", () => ({
    useAppUnread: () => unread,
    useServerUnread: () => unread,
    anythingWaiting: () => true,
    // The badge moves with the nudge, as the drift overlay moves it: the mark
    // belongs to the badge, so it goes when the badge does.
    useNudgeAppUnread: () => (app: string, by: number) => {
        nudges.push([app, by]);
        unread[app] = (unread[app] ?? 0) + by;
        return () => {
            nudges.push([app, -by]);
            unread[app] = (unread[app] ?? 0) - by;
        };
    }
}));

const { FavoriteAppsProvider } = await import("@/components/favorite-apps");
const { AppSidebar } = await import("@/components/app-sidebar");
const { AppLauncher } = await import("@/components/app-nav");

// Mail has something the route would let a mark dismiss, but no badge on the
// row: the mark belongs to the badge, so it is not offered there.
const ANSWER: LauncherWaiting = {
    groups: [
        {
            app: "chat",
            total: 7,
            items: [
                {
                    id: "c1",
                    title: "Ada",
                    detail: "",
                    href: "/chat/c/c1",
                    count: 7,
                    dismissable: true
                }
            ]
        },
        {
            app: "mail",
            total: 1,
            items: [
                { id: "m1", title: "Bo", detail: "", href: "/mail", count: 1, dismissable: true }
            ]
        }
    ]
};

beforeEach(() => {
    marked.length = 0;
    nudges.length = 0;
    refuse = false;
    unread.chat = 7;
    unread.mail = 0;
    vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) =>
            String(url).startsWith("/api/launcher/waiting")
                ? Response.json(ANSWER)
                : Response.json({ favorites: [] })
        )
    );
});
afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

function renderRail() {
    return render(
        withMessages(
            <FavoriteAppsProvider initial={["chat", "mail", "drive"]} initialHome={null}>
                <AppSidebar appIds={["overview", "chat", "mail", "drive"]} />
            </FavoriteAppsProvider>
        )
    );
}

describe("the Overview's rail", () => {
    it("draws the mark only beside a row with a badge, and marks that app", async () => {
        const user = userEvent.setup();
        renderRail();
        const button = await screen.findByRole("button", { name: "Mark all read in Chat" });
        expect(document.querySelector('[data-rail-mark="mail"]')).toBeNull();
        expect(document.querySelector('[data-rail-mark="drive"]')).toBeNull();
        await user.click(button);
        expect(marked).toEqual([{ scope: "app", app: "chat" }]);
        expect(nudges).toEqual([["chat", -7]]);
        await waitFor(() =>
            expect(screen.queryByRole("button", { name: "Mark all read in Chat" })).toBeNull()
        );
    });

    it("puts the badge back when the server refuses", async () => {
        refuse = true;
        const user = userEvent.setup();
        renderRail();
        await user.click(await screen.findByRole("button", { name: "Mark all read in Chat" }));
        await waitFor(() =>
            expect(nudges).toEqual([
                ["chat", -7],
                ["chat", 7]
            ])
        );
        expect(await screen.findByRole("button", { name: "Mark all read in Chat" })).toBeTruthy();
    });

    it("offers Mark as read on a right click only on an app with something unread", async () => {
        const user = userEvent.setup();
        renderRail();
        await screen.findByRole("button", { name: "Mark all read in Chat" });
        fireEvent.contextMenu(document.querySelector('a[href="/drive"]')!);
        await screen.findByRole("menuitem", { name: "Open on entry" });
        expect(screen.queryByRole("menuitem", { name: "Mark as read" })).toBeNull();
        await user.keyboard("{Escape}");
        await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
        fireEvent.contextMenu(document.querySelector('a[href="/chat"]')!);
        await user.click(await screen.findByRole("menuitem", { name: "Mark as read" }));
        expect(marked).toEqual([{ scope: "app", app: "chat" }]);
    });
});

describe("a right click in the app menu", () => {
    const apps = [
        { id: "chat", label: "Chat", icon: MessageCircle, href: "/chat", badge: "7" },
        { id: "mail", label: "Mail", icon: Mail, href: "/mail" },
        { id: "drive", label: "Drive", icon: HardDrive, href: "/drive" }
    ];

    it("offers Mark as read on the tile that has a mark, and nowhere else", async () => {
        const user = userEvent.setup();
        render(
            withMessages(
                <FavoriteAppsProvider initial={[]} initialHome={null}>
                    <AppLauncher apps={apps} currentAppId="drive" />
                </FavoriteAppsProvider>
            )
        );
        await user.click(screen.getByRole("button", { name: /drive/i }));
        await screen.findByRole("menuitem", { name: "Mark all read in Chat" });
        expect(document.querySelector('[data-launcher-tile-action="drive"]')).toBeNull();
        fireEvent.contextMenu(document.querySelector('[data-launcher-tile="drive"]')!);
        await screen.findByRole("menuitem", { name: "Open on entry" });
        expect(screen.queryByRole("menuitem", { name: "Mark as read" })).toBeNull();
        await user.keyboard("{Escape}");
        fireEvent.contextMenu(document.querySelector('[data-launcher-tile="chat"]')!);
        await user.click(await screen.findByRole("menuitem", { name: "Mark as read" }));
        expect(marked).toEqual([{ scope: "app", app: "chat" }]);
        expect(nudges).toEqual([["chat", -7]]);
    });
});
