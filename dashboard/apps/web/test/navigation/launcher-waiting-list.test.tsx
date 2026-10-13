// @vitest-environment jsdom

/**
 * Marking read from the app menu: the menu lists only apps, a tile with
 * something dismissable carries "mark read" for that app, and the foot has
 * "mark everything read". A mark moves the badges at once; a refusal puts them
 * back and says so; a fault alone (a Google API off) offers no mark.
 */

import { AppSwitcher, DropdownMenuItem } from "@polaris/ui";
import { MessagesWrapper } from "../setup/i18n";
import userEvent from "@testing-library/user-event";
import { Mail, MessageCircle, Shield } from "lucide-react";
import type { LauncherWaiting } from "@/lib/launcher-waiting";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

const marked: unknown[] = [];
let refuse = false;
const nudges: [string, number][] = [];
const shown: string[] = [];
let server = { chat: 7, mail: 2, admin: 4 };
let hold: Promise<void> | null = null;

vi.mock("@/app/(app)/launcher-waiting-actions", () => ({
    markLauncherReadAction: async (input: unknown) => {
        marked.push(input);
        if (hold) await hold;
        return refuse ? { error: "That could not be marked." } : {};
    }
}));
vi.mock("@/components/app-unread", () => ({
    useAppUnread: () => ({ chat: 7, mail: 2, admin: 4 }),
    useServerUnread: () => server,
    useNudgeAppUnread: () => (app: string, by: number) => {
        nudges.push([app, by]);
        return () => nudges.push([app, -by]);
    }
}));
vi.mock("@/components/admin-waiting", () => ({ useAdminRecount: () => () => undefined }));
vi.mock("@polaris/ui", async (original) => ({
    ...(await original<typeof import("@polaris/ui")>()),
    useToast: () => ({
        show: ({ title }: { title: string }) => shown.push(title),
        dismiss: () => undefined
    })
}));

const { useLauncherMarks } = await import("@/components/launcher-waiting");

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
                {
                    id: "c1",
                    title: "Ada",
                    detail: "",
                    href: "/chat/c/c1",
                    count: 5,
                    dismissable: true
                },
                {
                    id: "c2",
                    title: "Ops",
                    detail: "",
                    href: "/chat/c/c2",
                    count: 2,
                    dismissable: true
                }
            ]
        },
        {
            app: "mail",
            total: 2,
            items: [
                {
                    id: "t1",
                    title: "Grace",
                    detail: "Invoice",
                    href: "/mail/t/t1",
                    count: 2,
                    dismissable: true
                }
            ]
        },
        {
            app: "admin",
            total: 4,
            items: [
                {
                    id: "reports",
                    title: "",
                    detail: "",
                    href: "/admin/safety",
                    count: 3,
                    dismissable: true
                },
                {
                    id: "apis",
                    title: "",
                    detail: "",
                    href: "/admin/integrations",
                    count: 1,
                    dismissable: false
                }
            ]
        }
    ]
};

function Menu() {
    const marks = useLauncherMarks(true);
    return (
        <AppSwitcher
            apps={APPS}
            currentAppId="chat"
            tileAction={marks.tileAction}
            footer={
                marks.anything ? (
                    <DropdownMenuItem
                        aria-label="Mark everything read"
                        onSelect={(event) => {
                            event.preventDefault();
                            marks.markAll();
                        }}
                    >
                        all
                    </DropdownMenuItem>
                ) : null
            }
        />
    );
}

beforeEach(() => {
    marked.length = 0;
    nudges.length = 0;
    shown.length = 0;
    refuse = false;
    server = { chat: 7, mail: 2, admin: 4 };
    hold = null;
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
    await screen.findByRole("menuitem", { name: "Mark all read in Chat" });
    return { user };
}

describe("marking read from the app menu", () => {
    it("lists apps only, with a mark on each tile that has something to dismiss", async () => {
        await open();
        expect(screen.queryByText("Ada")).toBeNull();
        expect(screen.queryByText("Invoice")).toBeNull();
        expect(screen.getByRole("menuitem", { name: "Mark all read in Mail" })).toBeTruthy();
        expect(screen.getByRole("menuitem", { name: "Mark all seen in Management" })).toBeTruthy();
    });

    it("marks one app at once, badge included, and keeps the menu open", async () => {
        const { user } = await open();
        await user.click(screen.getByRole("menuitem", { name: "Mark all read in Chat" }));
        expect(nudges).toEqual([["chat", -7]]);
        expect(marked).toEqual([{ scope: "app", app: "chat" }]);
        expect(screen.getByRole("menu")).toBeTruthy();
        expect(screen.queryByRole("menuitem", { name: "Mark all read in Chat" })).toBeNull();
    });

    it("puts the badge and the mark back when the server refuses", async () => {
        refuse = true;
        const { user } = await open();
        await user.click(screen.getByRole("menuitem", { name: "Mark all read in Chat" }));
        await waitFor(() => expect(shown).toEqual(["That could not be marked."]));
        expect(nudges).toEqual([
            ["chat", -7],
            ["chat", 7]
        ]);
        expect(screen.getByRole("menuitem", { name: "Mark all read in Chat" })).toBeTruthy();
    });

    it("marks everything, leaving the fault, and the tile marks go", async () => {
        const { user } = await open();
        await user.click(screen.getByRole("menuitem", { name: "Mark everything read" }));
        expect(marked).toEqual([{ scope: "all" }]);
        expect(nudges).toEqual([
            ["chat", -7],
            ["mail", -2],
            ["admin", -3]
        ]);
        expect(screen.queryByRole("menuitem", { name: "Mark all seen in Management" })).toBeNull();
        expect(screen.queryByRole("menuitem", { name: "Mark everything read" })).toBeNull();
    });
});
