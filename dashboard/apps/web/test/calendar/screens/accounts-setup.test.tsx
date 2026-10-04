// @vitest-environment jsdom

/**
 * A Google account whose calendars cannot sync because the Calendar API is off
 * in the operator's Cloud project. Connecting again cannot fix that, so the
 * screen never offers it: an administrator gets Google's own link and a retry,
 * anybody else is told who has to act. A grant that only lacks the calendar
 * scope is the one case where connecting again is the fix, and it asks for
 * calendars on the way.
 */

import "@/components/app-host/client";
import { MessagesWrapper } from "../../setup/i18n";
import type { SourceView } from "@polaris-app/calendar/src/lib/wire";
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
const refreshSource = vi.fn();

vi.mock("@polaris-app/calendar/src/actions/sources", () => ({
    loadAccountsAction: async () => ({ ok: true, accounts }),
    refreshSourceAction: async (id: string) => refreshSource(id)
}));

vi.mock("@polaris-app/calendar/src/actions/instance", () => ({
    loadInstanceSettingsAction: async () => ({
        ok: true,
        settings: { allowSubscriptions: false, allowBooking: true, suggested: [] },
        canManage: false
    })
}));

const { AccountsView: Screen } = await import(
    "@polaris-app/calendar/src/screens/accounts/accounts-view"
);

const ENABLE =
    "https://console.developers.google.com/apis/api/calendar-json.googleapis.com/overview?project=100000000001";

function source(patch: Partial<SourceView> = {}): SourceView {
    return {
        id: "11111111-1111-4111-8111-111111111111",
        kind: "google",
        label: "me@gmail.example",
        url: "",
        username: "",
        status: "setup",
        lastError: "Google needs an API switched on",
        lastSyncAt: null,
        refreshMinutes: 15,
        calendarCount: 0,
        connectionId: "22222222-2222-4222-8222-222222222222",
        ...patch
    };
}

function view(patch: Partial<AccountsView> = {}): AccountsView {
    return {
        sources: [source()],
        subscribed: [],
        links: [],
        linkUrls: {
            google: "/api/connections/google/link?scope=calendar",
            microsoft: "/api/connections/microsoft/link?scope=calendar"
        },
        linkAvailable: { google: true, microsoft: true },
        canManage: false,
        googleSetup: null,
        tasksApiOff: null,
        presets: [],
        holidays: [],
        ...patch
    } as AccountsView;
}

async function show(): Promise<void> {
    render(<Screen linked={null} />, { wrapper: MessagesWrapper });
    await act(async () => {
        for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
    });
}

beforeEach(() => {
    sessionStorage.clear();
    refreshSource.mockReset();
});

afterEach(() => {
    cleanup();
});

describe("a Google account waiting on the Calendar API", () => {
    it("gives an administrator Google's own link and a retry, and no Connect again", async () => {
        accounts = view({
            canManage: true,
            googleSetup: { enableUrl: ENABLE, project: "100000000001" }
        });
        refreshSource.mockResolvedValue({
            ok: true,
            source: source({ status: "ok", calendarCount: 2 })
        });
        await show();
        expect(screen.getByText("Needs setup")).toBeTruthy();
        expect(
            screen.getByText(/Google Calendar API is turned off in the Google Cloud project/)
        ).toBeTruthy();
        expect(screen.getByText("Project 100000000001")).toBeTruthy();
        const open = screen.getByRole("link", { name: /Turn on in Google Cloud/ });
        expect(open.getAttribute("href")).toBe(ENABLE);
        expect(open.getAttribute("target")).toBe("_blank");
        expect(open.getAttribute("rel")).toContain("noopener");
        expect(screen.queryByText("Connect again for calendars")).toBeNull();

        await act(async () => {
            fireEvent.click(screen.getByRole("button", { name: "Try again" }));
        });
        expect(refreshSource).toHaveBeenCalledWith("11111111-1111-4111-8111-111111111111");
        expect(screen.getByText("Up to date")).toBeTruthy();
        expect(screen.queryByText(/Google Calendar API is turned off/)).toBeNull();
    });

    it("tells anybody else that the administrator has to finish it", async () => {
        accounts = view();
        await show();
        expect(
            screen.getByText("Your administrator needs to finish setting up Google for calendars.")
        ).toBeTruthy();
        expect(screen.queryByRole("link", { name: /Google Cloud/ })).toBeNull();
        expect(screen.queryByText("Connect again for calendars")).toBeNull();
    });
});

describe("connecting again for calendars", () => {
    it("is offered for a grant without calendar access, asking for that scope", async () => {
        accounts = view({ sources: [source({ status: "consent" })] });
        await show();
        expect(screen.getByText("Needs permission")).toBeTruthy();
        expect(
            screen.getByRole("link", { name: "Connect again for calendars" }).getAttribute("href")
        ).toBe("/api/connections/google/link?scope=calendar");
    });

    it("is what a link made for something else offers, with the calendar scope", async () => {
        accounts = view({
            sources: [],
            links: [
                {
                    id: "33333333-3333-4333-8333-333333333333",
                    provider: "google",
                    label: "backup@gmail.example",
                    grantsCalendar: false,
                    grantsTasks: false,
                    used: false
                }
            ]
        });
        await show();
        expect(
            screen.getByText("Linked for something else, so it cannot read calendars yet.")
        ).toBeTruthy();
        expect(
            screen.getByRole("link", { name: "Connect again for calendars" }).getAttribute("href")
        ).toBe("/api/connections/google/link?scope=calendar");
    });
});

/** The account the source reads through, with or without its tasks granted. */
function link(grantsTasks: boolean) {
    return {
        id: "22222222-2222-4222-8222-222222222222",
        provider: "google" as const,
        label: "me@gmail.example",
        grantsCalendar: true,
        grantsTasks,
        used: true
    };
}

describe("a Google account's tasks", () => {
    it("asks an account linked before tasks to grant them, through the consent screen", async () => {
        accounts = view({ sources: [source({ status: "ok" })], links: [link(false)] });
        await show();
        expect(screen.getByText(/Your Google tasks aren't shown yet/)).toBeTruthy();
        expect(screen.getByRole("link", { name: "Show my tasks" }).getAttribute("href")).toBe(
            "/api/connections/google/link?scope=calendar"
        );
    });

    it("says nothing once the account holds them", async () => {
        accounts = view({ sources: [source({ status: "ok" })], links: [link(true)] });
        await show();
        expect(screen.queryByText(/Google tasks/)).toBeNull();
        expect(screen.queryByRole("link", { name: "Show my tasks" })).toBeNull();
    });

    it("gives an administrator the switch when the Tasks API is off", async () => {
        const enable =
            "https://console.cloud.google.com/apis/library/tasks.googleapis.com?project=100000000001";
        accounts = view({
            canManage: true,
            sources: [source({ status: "ok" })],
            links: [link(true)],
            tasksApiOff: { enableUrl: enable, project: "100000000001" }
        });
        await show();
        expect(screen.getByText(/Google Tasks API is turned off/)).toBeTruthy();
        expect(
            screen.getByRole("link", { name: /Turn on in Google Cloud/ }).getAttribute("href")
        ).toBe(enable);
    });

    it("tells anybody else the administrator has to turn them on", async () => {
        accounts = view({
            sources: [source({ status: "ok" })],
            links: [link(true)],
            tasksApiOff: { enableUrl: null, project: null }
        });
        await show();
        expect(
            screen.getByText("Google tasks can't be shown until your administrator turns them on.")
        ).toBeTruthy();
        expect(screen.queryByRole("link", { name: /Google Cloud/ })).toBeNull();
    });

    it("reads the linked accounts again on the way back from granting more", async () => {
        accounts = view({ sources: [source({ status: "ok" })], links: [link(true)] });
        refreshSource.mockResolvedValue({ ok: true, source: source({ status: "ok" }) });
        render(<Screen linked="linked" />, { wrapper: MessagesWrapper });
        await act(async () => {
            for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
        });
        expect(refreshSource).toHaveBeenCalledTimes(1);
        expect(refreshSource).toHaveBeenCalledWith("11111111-1111-4111-8111-111111111111");
    });
});
