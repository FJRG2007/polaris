// @vitest-environment jsdom

/**
 * The tab bar along the bottom of a phone and the account screen behind "You".
 *
 * Pinned here: the apps are the menu's own first few that this account can
 * reach, never Home or the account twice; a screen with tabs of its own takes
 * the bottom of the screen and the bar steps aside while leaving the shell its
 * marker; "You" opens the account screen rather than a page; the account screen
 * lists only the screens of My account this account is offered; and the shell's
 * CSS turns the marker into a content area that does not pad the inset twice, a
 * header without the controls the bar carries, and a full-height screen that
 * leaves room for the bar.
 */

import postcss from "postcss";
import tailwind from "tailwindcss";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { MessagesWrapper } from "../setup/i18n";
import { afterEach, describe, expect, it, vi } from "vitest";
import preset from "../../../../packages/ui/src/tailwind-preset";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }), usePathname: () => "/home" }));
vi.mock("@/components/notifications/notifications-provider", () => ({
    useNotificationFeed: () => ({ unread: 3 })
}));
vi.mock("@/components/app-unread", () => ({ useAppUnread: () => ({ chat: 2 }) }));
// The switcher loads the accounts through a server action, which needs a database.
vi.mock("@/components/device-accounts", () => ({ AccountSwitcherDialog: () => null }));

import { PHONE_TABS_HIDE } from "@polaris/ui";
import { AccountSheet } from "@/components/account-sheet";
import { setAccountSheetOpen, useAccountSheetOpen } from "@/components/account-sheet-state";
import { OwnBottomTabs, PHONE_TAB_APPS, PhoneTabBar, PhoneTabsProvider, phoneTabApps } from "@/components/phone-tabs";

const DASHBOARD = resolve(__dirname, "../../../..");
const person = { id: "u1", name: "Ada Lovelace" };

afterEach(() => {
    cleanup();
    push.mockReset();
    act(() => setAccountSheetOpen(false));
});

function SheetOpen() {
    return <output data-testid="sheet">{String(useAccountSheetOpen())}</output>;
}

describe("phoneTabApps", () => {
    it("takes the menu's first few, favorites first, and leaves out the ones with a tab", () => {
        const ids = phoneTabApps({
            appIds: ["overview", "account", "drive", "tasks", "chat", "mail"],
            favorites: ["mail", "chat"],
            arranged: [],
            usage: {},
            now: 0
        });
        expect(ids).toEqual(["mail", "chat"]);
        expect(ids).toHaveLength(PHONE_TAB_APPS);
    });

    it("offers nothing this account cannot reach", () => {
        const ids = phoneTabApps({ appIds: ["overview", "tasks"], favorites: ["mail"], arranged: [], usage: {}, now: 0 });
        expect(ids).toEqual(["tasks"]);
    });
});

describe("PhoneTabBar", () => {
    it("draws Home, the apps, the alerts with their count and You, and You opens the account screen", () => {
        render(
            <PhoneTabsProvider>
                <PhoneTabBar person={person} appIds={["overview", "chat"]} />
                <SheetOpen />
            </PhoneTabsProvider>,
            { wrapper: MessagesWrapper }
        );
        const tabs = screen.getAllByRole("button");
        expect(tabs).toHaveLength(4);
        expect(tabs[0].getAttribute("aria-current")).toBe("page");
        expect(tabs[1].textContent).toContain("2");
        expect(tabs[2].textContent).toContain("3");
        fireEvent.click(tabs[1]);
        expect(push).toHaveBeenCalledWith("/chat");
        fireEvent.click(tabs[3]);
        expect(screen.getByTestId("sheet").textContent).toBe("true");
        expect(push).toHaveBeenCalledTimes(1);
    });

    it("steps aside for a screen with tabs of its own, and leaves the shell its marker", () => {
        const { container } = render(
            <PhoneTabsProvider>
                <PhoneTabBar person={person} appIds={["overview", "chat"]} />
                <OwnBottomTabs />
            </PhoneTabsProvider>,
            { wrapper: MessagesWrapper }
        );
        expect(screen.queryAllByRole("button")).toHaveLength(0);
        expect(container.querySelector('[data-shell-tabs="owned"]')).not.toBeNull();
        expect(container.querySelector('[data-shell-tabs="global"]')).toBeNull();
    });
});

describe("AccountSheet", () => {
    it("lists only the screens of My account this account is offered, and closes on one", () => {
        const onSignOut = vi.fn();
        render(
            <AccountSheet
                person={person}
                email="ada@example.test"
                detail=""
                presence={[{ choice: "online", label: "Online" }]}
                shownChoice="online"
                onChoose={() => undefined}
                status=""
                onStatus={() => undefined}
                onTours={() => undefined}
                onSignOut={onSignOut}
            />,
            { wrapper: MessagesWrapper }
        );
        expect(screen.queryByRole("dialog")).toBeNull();
        act(() => setAccountSheetOpen(true));
        const dialog = screen.getByRole("dialog");
        const hrefs = [...dialog.querySelectorAll("a")].map((link) => link.getAttribute("href"));
        expect(hrefs).toContain("/account/security");
        expect(hrefs).toContain("/account/sessions");
        expect(hrefs).toContain("/account/privacy");
        // Needs a permission this account does not hold.
        expect(hrefs).not.toContain("/account/computers");
        fireEvent.click(screen.getByText("Ada Lovelace"));
        expect(screen.queryByRole("dialog")).toBeNull();
        act(() => setAccountSheetOpen(true));
        fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
        expect(onSignOut).toHaveBeenCalledTimes(1);
    });
});

describe("shell CSS for the phone tab bar", () => {
    it("drops the content's bottom inset and the duplicated header controls while a bar is drawn", async () => {
        const result = await postcss([
            tailwind({
                presets: [preset],
                content: [
                    { raw: `<div class="max-sm:group-has-[[data-shell-tabs]]/shell:pb-0 ${PHONE_TABS_HIDE}">`, extension: "html" }
                ],
                corePlugins: { preflight: false }
            })
        ]).process("@tailwind utilities;", { from: undefined });
        const css = result.css.replace(/\s+/g, " ");
        expect(css).toContain("@media not all and (min-width: 640px)");
        expect(css).toMatch(/\.group\\\/shell:has\(\[data-shell-tabs\]\) [^{]*\{ padding-bottom: 0px \}/);
        expect(css).toMatch(/\.group\\\/shell:has\(\[data-shell-tabs=global\]\) [^{]*\{ display: none \}/);
    });

    it("counts the bar in what a full-height screen subtracts, only on a phone", () => {
        const css = readFileSync(join(DASHBOARD, "packages/ui/src/styles/tokens.css"), "utf8").replace(/\s+/g, " ");
        expect(css).toMatch(/--notice-height: calc\([^;]*var\(--safe-bottom\) \+ var\(--bottom-bar-height\) \)/);
        expect(css).toContain(
            '@media (max-width: 639px) { :root:has([data-shell-tabs="global"]) { --bottom-bar-height: calc(3.5rem + 1px); } }'
        );
    });
});
