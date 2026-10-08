// @vitest-environment jsdom

/**
 * What each app has waiting, under the app menu's grid: the entries come from
 * the route when the menu opens; marking one read takes it away and moves the
 * badge at once; a refusal puts both back and says so; "mark all" leaves only
 * what cannot be dismissed; and a search puts the list away.
 */

import { AppSwitcher } from "@polaris/ui";
import { MessagesWrapper } from "../setup/i18n";
import userEvent from "@testing-library/user-event";
import { Mail, MessageCircle, Shield } from "lucide-react";
import type { LauncherWaiting } from "@/lib/launcher-waiting";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";

const marked: unknown[] = [];
let refuse = false;
const nudges: [string, number][] = [];
const shown: string[] = [];

vi.mock("@/app/(app)/launcher-waiting-actions", () => ({
    markLauncherReadAction: async (input: unknown) => {
        marked.push(input);
        return refuse ? { error: "That could not be marked." } : {};
    }
}));
vi.mock("@/components/app-unread", () => ({
    useAppUnread: () => ({ chat: 7, mail: 2, admin: 4 }),
    useNudgeAppUnread: () => (app: string, by: number) => nudges.push([app, by])
}));
vi.mock("@/components/admin-waiting", () => ({ useAdminRecount: () => () => undefined }));
vi.mock("@polaris/ui", async (original) => ({
    ...(await original<typeof import("@polaris/ui")>()),
    useToast: () => ({
        show: ({ title }: { title: string }) => shown.push(title),
        dismiss: () => undefined
    })
}));

const { LauncherWaitingList } = await import("@/components/launcher-waiting");

const APPS = [
    { id: "chat", label: "Chat", icon: MessageCircle, href: "/chat" },
    { id: "mail", label: "Mail", icon: Mail, href: "/mail" },
    { id: "admin", label: "Management", icon: Shield, href: "/admin" }
];

const ANSWER: LauncherWaiting = {
    groups: [
        {
            app: "chat",
            total: 7,
            items: [
                { id: "c1", title: "Ada", detail: "", href: "/chat/c/c1", count: 5, dismissable: true },
                { id: "c2", title: "Ops", detail: "", href: "/chat/c/c2", count: 2, dismissable: true }
            ]
        },
        {
            app: "mail",
            total: 2,
            items: [
                { id: "t1", title: "Grace", detail: "Invoice", href: "/mail/t/t1", count: 2, dismissable: true }
            ]
        },
        {
            app: "admin",
            total: 4,
            items: [
                { id: "reports", title: "", detail: "", href: "/admin/safety", count: 3, dismissable: true },
                { id: "apis", title: "", detail: "", href: "/admin/integrations", count: 1, dismissable: false }
            ]
        }
    ]
};

function Menu() {
    return (
        <AppSwitcher
            apps={APPS}
            currentAppId="chat"
            below={<LauncherWaitingList open apps={APPS} />}
        />
    );
}

beforeEach(() => {
    marked.length = 0;
    nudges.length = 0;
    shown.length = 0;
    refuse = false;
    vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(JSON.stringify(ANSWER), { status: 200 }))
    );
});
afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

async function open() {
    const user = userEvent.setup();
    render(<Menu />, { wrapper: MessagesWrapper });
    await user.click(screen.getByRole("button", { name: /chat/i }));
    const list = await screen.findByRole("region", { name: "Waiting in your apps" });
    await within(list).findByText("Ada");
    return { user, list };
}

describe("the waiting list in the app menu", () => {
    it("lists each app's entries, in the app's own words", async () => {
        const { list } = await open();
        expect(within(list).getByText("Grace")).toBeTruthy();
        expect(within(list).getByText("Invoice")).toBeTruthy();
        expect(within(list).getByText("3 reported messages")).toBeTruthy();
        expect(within(list).getByText("1 Google API is off")).toBeTruthy();
        // A fault is never dismissed: the APIs entry has no mark of its own.
        expect(within(list).queryByRole("menuitem", { name: /Mark 1 Google API/ })).toBeNull();
        expect(within(list).getByRole("menuitem", { name: "Mark 3 reported messages seen" })).toBeTruthy();
    });

    it("marks one entry read at once, badge included, and keeps the menu open", async () => {
        const { user, list } = await open();
        await user.click(within(list).getByRole("menuitem", { name: "Mark Ada read" }));
        expect(within(list).queryByText("Ada")).toBeNull();
        expect(nudges).toEqual([["chat", -5]]);
        expect(marked).toEqual([{ scope: "item", app: "chat", id: "c1" }]);
        expect(screen.getByRole("menu")).toBeTruthy();
    });

    it("puts the entry and the badge back when the server refuses", async () => {
        refuse = true;
        const { user, list } = await open();
        await user.click(within(list).getByRole("menuitem", { name: "Mark Ada read" }));
        await waitFor(() => expect(shown).toEqual(["That could not be marked."]));
        expect(nudges).toEqual([
            ["chat", -5],
            ["chat", 5]
        ]);
        expect(within(list).getByText("Ada")).toBeTruthy();
    });

    it("marks a whole app, leaving what cannot be dismissed", async () => {
        const { user, list } = await open();
        await user.click(
            within(list).getByRole("menuitem", { name: "Mark all seen in Management" })
        );
        expect(within(list).queryByText("3 reported messages")).toBeNull();
        expect(within(list).getByText("1 Google API is off")).toBeTruthy();
        expect(marked).toEqual([{ scope: "app", app: "admin" }]);
        expect(nudges).toEqual([["admin", -3]]);
    });

    it("is put away while a search narrows the grid", async () => {
        const { user } = await open();
        await user.type(screen.getByPlaceholderText("Search apps"), "ma");
        expect(screen.queryByRole("region", { name: "Waiting in your apps" })).toBeNull();
    });
});
