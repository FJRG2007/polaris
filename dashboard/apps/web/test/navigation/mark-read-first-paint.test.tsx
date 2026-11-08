// @vitest-environment jsdom

/**
 * "Mark read" belongs to the badge: every app whose badge is up offers it on
 * its tile, its rail row and its right click from the first paint, whether or
 * not the waiting route has answered - and whether it ever does. The route only
 * takes the mark off an app whose entries are all faults no mark dismisses.
 *
 * A file of its own because the hook keeps the route's last answer for the
 * page's life, and these start before any answer.
 */

import { withMessages } from "../setup/i18n";
import userEvent from "@testing-library/user-event";
import { HardDrive, Mail, Shield } from "lucide-react";
import type { LauncherWaiting } from "@/lib/launcher-waiting";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const marked: unknown[] = [];
const nudges: [string, number][] = [];
const mailChanges: number[] = [];
let refuse = false;
let recounts = 0;
let recounted = false;
let route: "pending" | LauncherWaiting = "pending";
const unread: Record<string, number> = { chat: 0, mail: 3, admin: 4 };

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
vi.mock("@/lib/mailbox/unread-overlay", () => ({
    beginUnreadChange: (changes: { by: number }[]) => {
        for (const change of changes) mailChanges.push(change.by);
        return {
            settle: () => undefined,
            abandon: () => {
                for (const change of changes) mailChanges.push(-change.by);
            }
        };
    }
}));
vi.mock("@/components/admin-waiting", async (original) => ({
    ...(await original<typeof import("@/components/admin-waiting")>()),
    useAdminRecount: () => async () => {
        recounts += 1;
        return recounted;
    }
}));
vi.mock("@/components/app-unread", () => ({
    useAppUnread: () => unread,
    useServerUnread: () => unread,
    anythingWaiting: () => true,
    useNudgeAppUnread: () => (app: string, by: number) => {
        nudges.push([app, by]);
        return () => nudges.push([app, -by]);
    }
}));

const { FavoriteAppsProvider } = await import("@/components/favorite-apps");
const { AppSidebar } = await import("@/components/app-sidebar");
const { AppLauncher } = await import("@/components/app-nav");

beforeEach(() => {
    marked.length = 0;
    nudges.length = 0;
    mailChanges.length = 0;
    refuse = false;
    recounts = 0;
    recounted = false;
    route = "pending";
    vi.stubGlobal(
        "fetch",
        vi.fn((url: string) => {
            if (!String(url).startsWith("/api/launcher/waiting"))
                return Promise.resolve(Response.json({ favorites: [] }));
            // Never answers while pending: the mark may not wait for it.
            return route === "pending"
                ? new Promise<Response>(() => undefined)
                : Promise.resolve(Response.json(route));
        })
    );
});
afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

function renderRail() {
    return render(
        withMessages(
            <FavoriteAppsProvider initial={["mail", "admin", "drive"]} initialHome={null}>
                <AppSidebar appIds={["overview", "mail", "admin", "drive"]} isAdmin />
            </FavoriteAppsProvider>
        )
    );
}

const apps = [
    { id: "mail", label: "Mail", icon: Mail, href: "/mail", badge: "3" },
    { id: "admin", label: "Management", icon: Shield, href: "/admin", badge: "4" },
    { id: "drive", label: "Drive", icon: HardDrive, href: "/drive" }
];

function renderLauncher() {
    return render(
        withMessages(
            <FavoriteAppsProvider initial={[]} initialHome={null}>
                <AppLauncher apps={apps} currentAppId="drive" />
            </FavoriteAppsProvider>
        )
    );
}

describe("before the waiting route has answered", () => {
    it("draws the rail's mark on every row with a badge on the first render", () => {
        renderRail();
        expect(screen.getByRole("button", { name: "Mark all read in Mail" })).toBeTruthy();
        expect(screen.getByRole("button", { name: "Mark all seen in Management" })).toBeTruthy();
        expect(document.querySelector('[data-rail-mark="drive"]')).toBeNull();
    });

    it("marks Management seen with its own action and takes its whole badge down", async () => {
        const user = userEvent.setup();
        renderRail();
        await user.click(screen.getByRole("button", { name: "Mark all seen in Management" }));
        expect(marked).toEqual([{ scope: "app", app: "admin" }]);
        expect(nudges).toEqual([["admin", -4]]);
    });

    it("hands Management's badge back to the recount once it has answered", async () => {
        recounted = true;
        const user = userEvent.setup();
        renderRail();
        await user.click(screen.getByRole("button", { name: "Mark all seen in Management" }));
        await waitFor(() =>
            expect(nudges).toEqual([
                ["admin", -4],
                ["admin", 4]
            ])
        );
        expect(recounts).toBe(1);
    });

    it("keeps Management's badge down while the recount has not answered", async () => {
        const user = userEvent.setup();
        renderRail();
        await user.click(screen.getByRole("button", { name: "Mark all seen in Management" }));
        await waitFor(() => expect(recounts).toBe(1));
        expect(nudges).toEqual([["admin", -4]]);
    });

    it("marks Mail read on Mail's own ledger", async () => {
        const user = userEvent.setup();
        renderRail();
        await user.click(screen.getByRole("button", { name: "Mark all read in Mail" }));
        expect(marked).toEqual([{ scope: "app", app: "mail" }]);
        expect(mailChanges).toEqual([-3]);
        expect(nudges).toEqual([]);
    });

    it("puts each badge back when the server refuses", async () => {
        refuse = true;
        const user = userEvent.setup();
        renderRail();
        await user.click(screen.getByRole("button", { name: "Mark all seen in Management" }));
        await waitFor(() =>
            expect(nudges).toEqual([
                ["admin", -4],
                ["admin", 4]
            ])
        );
        await user.click(screen.getByRole("button", { name: "Mark all read in Mail" }));
        await waitFor(() => expect(mailChanges).toEqual([-3, 3]));
    });

    it("offers the tile's corner and the right click in the app menu", async () => {
        const user = userEvent.setup();
        renderLauncher();
        await user.click(screen.getByRole("button", { name: /drive/i }));
        expect(screen.getByRole("menuitem", { name: "Mark all read in Mail" })).toBeTruthy();
        expect(screen.getByRole("menuitem", { name: "Mark all seen in Management" })).toBeTruthy();
        expect(document.querySelector('[data-launcher-tile-action="drive"]')).toBeNull();
        fireEvent.contextMenu(document.querySelector('[data-launcher-tile="admin"]')!);
        await user.click(await screen.findByRole("menuitem", { name: "Mark as seen" }));
        expect(marked).toEqual([{ scope: "app", app: "admin" }]);
        expect(nudges).toEqual([["admin", -4]]);
    });
});

describe("once the route answers", () => {
    it("takes the mark off an app whose entries are all faults, and only that one", async () => {
        route = {
            groups: [
                {
                    app: "admin",
                    total: 4,
                    items: [
                        {
                            id: "apis",
                            title: "",
                            detail: "",
                            href: "/admin/integrations",
                            count: 4,
                            dismissable: false
                        }
                    ]
                }
            ]
        };
        renderRail();
        await waitFor(() =>
            expect(screen.queryByRole("button", { name: "Mark all seen in Management" })).toBeNull()
        );
        expect(screen.getByRole("button", { name: "Mark all read in Mail" })).toBeTruthy();
    });
});
