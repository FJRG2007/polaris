// @vitest-environment jsdom

/**
 * Where linking an account is found: the sidebar's "Add calendar" menu lists
 * every way in, the settings open on an Accounts section, and a provider the
 * operator has not set up is never a button that bounces - an administrator is
 * led to the setup, anybody else is told to ask one.
 */

import "@/components/app-host/client";
import { MessagesWrapper } from "../../setup/i18n";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountsView } from "@polaris-app/calendar/src/actions/sources";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("next/link", () => ({
    default: ({ href, children, ...rest }: { href: string; children: unknown }) => (
        <a href={href} {...rest}>
            {children as never}
        </a>
    )
}));

let accounts: AccountsView;

vi.mock("@polaris-app/calendar/src/actions/sources", () => ({
    loadAccountsAction: async () => ({ ok: true, accounts })
}));

const { AddCalendarMenu } = await import(
    "@polaris-app/calendar/src/screens/accounts/add-calendar-menu"
);
const { AccountsSection } = await import(
    "@polaris-app/calendar/src/screens/accounts/accounts-section"
);

function view(patch: Partial<AccountsView> = {}): AccountsView {
    return {
        sources: [],
        subscribed: [],
        links: [],
        linkUrls: {
            google: "/api/connections/google/link?scope=calendar",
            microsoft: "/api/connections/microsoft/link?scope=calendar"
        },
        linkAvailable: { google: true, microsoft: true },
        canManage: false,
        presets: [],
        holidays: [],
        ...patch
    } as AccountsView;
}

async function settle(): Promise<void> {
    await act(async () => {
        for (let turn = 0; turn < 6; turn += 1) await Promise.resolve();
    });
}

async function openMenu(onCreate = vi.fn(), onAddFrom = vi.fn()) {
    render(
        <AddCalendarMenu onCreate={onCreate} onAddFrom={onAddFrom}>
            <button type="button">Add a calendar</button>
        </AddCalendarMenu>,
        { wrapper: MessagesWrapper }
    );
    const trigger = screen.getByRole("button", { name: "Add a calendar" });
    act(() => {
        fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: "mouse" });
    });
    await settle();
    return { onCreate, onAddFrom };
}

function item(name: RegExp): HTMLElement {
    return screen.getByRole("menuitem", { name });
}

beforeEach(() => {
    accounts = view();
    sessionStorage.clear();
});

afterEach(() => {
    cleanup();
});

describe("the Add calendar menu", () => {
    it("lists every way a calendar comes in", async () => {
        await openMenu();
        expect(screen.getAllByRole("menuitem").map((entry) => entry.textContent)).toEqual([
            "From a Google account",
            "From Microsoft",
            "CalDAV serveriCloud, Fastmail, Nextcloud, Yahoo",
            "Subscribe by URL (.ics)",
            "Holiday calendars",
            "Import a file (.ics)",
            "Create a calendar",
            "New calendar with tasks"
        ]);
    });

    it("goes straight to the consent screen, and to the forms for the rest", async () => {
        await openMenu();
        expect(item(/From a Google account/).getAttribute("href")).toBe(
            "/api/connections/google/link?scope=calendar"
        );
        expect(item(/CalDAV server/).getAttribute("href")).toBe(
            "/calendar/settings/accounts#caldav"
        );
        expect(item(/Import a file/).getAttribute("href")).toBe("/calendar/settings#transfer");
    });

    it("leads to the account already linked for something else, instead of linking it twice", async () => {
        accounts = view({
            links: [
                {
                    id: "44444444-4444-4444-8444-444444444444",
                    provider: "google",
                    label: "me@example.test",
                    grantsCalendar: true,
                    used: false
                }
            ]
        });
        await openMenu();
        expect(item(/From a Google account/).getAttribute("href")).toBe(
            "/calendar/settings/accounts#linked"
        );
    });

    it("opens the subscribe dialog, and creates a calendar of one's own", async () => {
        const { onAddFrom, onCreate } = await openMenu();
        fireEvent.click(item(/Subscribe by URL/));
        expect(onAddFrom).toHaveBeenCalledWith("subscribe");
        act(() => {
            fireEvent.pointerDown(screen.getByRole("button", { name: "Add a calendar" }), {
                button: 0,
                ctrlKey: false,
                pointerType: "mouse"
            });
        });
        await settle();
        fireEvent.click(item(/^Create a calendar$/));
        expect(onCreate).toHaveBeenCalledWith(false);
    });

    it("leads an administrator to set up a provider that is not set up yet", async () => {
        accounts = view({ linkAvailable: { google: false, microsoft: true }, canManage: true });
        await openMenu();
        const google = item(/From a Google account/);
        expect(google.getAttribute("href")).toBe("/admin/integrations?configure=google");
        expect(google.textContent).toContain("Set up Google first");
    });

    it("tells anybody else to ask an administrator, rather than offering a dead link", async () => {
        accounts = view({ linkAvailable: { google: false, microsoft: false }, canManage: false });
        await openMenu();
        const google = item(/From a Google account/);
        expect(google.getAttribute("aria-disabled")).toBe("true");
        expect(google.getAttribute("href")).toBeNull();
        expect(google.textContent).toContain("Ask your administrator");
    });
});

describe("the Accounts section of the settings", () => {
    it("draws its heading and the ways to link before the accounts arrive", () => {
        render(<AccountsSection />, { wrapper: MessagesWrapper });
        expect(screen.getAllByRole("heading", { name: "Accounts" }).length).toBeGreaterThan(0);
        expect(screen.getByRole("link", { name: /CalDAV server/ }).getAttribute("href")).toBe(
            "/calendar/settings/accounts#caldav"
        );
        expect(screen.getByRole("link", { name: /Subscribe by URL/ }).getAttribute("href")).toBe(
            "/calendar/settings/accounts#feed"
        );
    });

    it("lists the linked sources and offers linking Google and Microsoft", async () => {
        accounts = view({
            sources: [
                {
                    id: "55555555-5555-4555-8555-555555555555",
                    kind: "google",
                    label: "me@example.test",
                    status: "ok",
                    lastSyncAt: null,
                    lastError: null,
                    calendarCount: 2,
                    refreshMinutes: 15,
                    url: null,
                    connectionId: null
                } as unknown as AccountsView["sources"][number]
            ],
            links: [
                {
                    id: "66666666-6666-4666-8666-666666666666",
                    provider: "google",
                    label: "me@example.test",
                    grantsCalendar: true,
                    used: true
                }
            ]
        });
        render(<AccountsSection />, { wrapper: MessagesWrapper });
        await settle();
        expect(screen.getByText("me@example.test")).toBeTruthy();
        expect(
            screen.getByRole("link", { name: /Link another Google account/ }).getAttribute("href")
        ).toBe("/api/connections/google/link?scope=calendar");
        expect(screen.getByRole("link", { name: /Link a Microsoft account/ })).toBeTruthy();
    });

    it("says why Google cannot be linked, with the way to the setup for an administrator", async () => {
        accounts = view({ linkAvailable: { google: false, microsoft: true }, canManage: true });
        render(<AccountsSection />, { wrapper: MessagesWrapper });
        await settle();
        const button = screen.getByRole("button", { name: /Link a Google account/ });
        expect(button.hasAttribute("disabled")).toBe(true);
        expect(screen.getByText(/Google sign-in is not set up on this Polaris yet/)).toBeTruthy();
        expect(screen.getByRole("link", { name: "Set up Google" }).getAttribute("href")).toBe(
            "/admin/integrations?configure=google"
        );
    });

    it("tells a member to ask an administrator", async () => {
        accounts = view({ linkAvailable: { google: true, microsoft: false }, canManage: false });
        render(<AccountsSection />, { wrapper: MessagesWrapper });
        await settle();
        expect(
            screen.getByText(
                "Microsoft is not set up on this Polaris yet. Ask your administrator to set it up."
            )
        ).toBeTruthy();
        expect(screen.queryByRole("link", { name: /Set up Microsoft/ })).toBeNull();
    });
});
