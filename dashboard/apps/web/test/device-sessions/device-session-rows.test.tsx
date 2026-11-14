// @vitest-environment jsdom

/**
 * A CLI sign-in on the sessions table: listed with the facts a session row has,
 * ended with the same press, and - for an administrator - without the address
 * lock, which stays the owner's to change.
 */

import { MessagesWrapper } from "../setup/i18n";
import type { DeviceSessionView } from "@/lib/device-sessions/sessions";
import { SessionsTable } from "@/components/sessions-table";
import { DEVICE_KINDS } from "@/lib/device-sessions/kinds";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

afterEach(cleanup);

/** Where a press would go; these tests read what is drawn. */
const revoke = vi.fn();

const SIGN_IN: DeviceSessionView = {
    id: "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b",
    kind: "cli",
    name: "ada-laptop",
    hostname: "ada-laptop",
    os: "macOS",
    version: "0.4.6",
    signedInIp: "203.0.113.4",
    createdAt: "2026-10-01T09:00:00.000Z",
    lastUsedAt: "2026-10-04T09:59:00.000Z",
    lastUsedIp: "198.51.100.7",
    expiresAt: "2027-10-01T09:00:00.000Z",
    pinToAddress: null,
    pinnedByRule: false
};

describe("a CLI sign-in on the sessions table", () => {
    it("is listed with its computer, system, version and addresses", () => {
        render(
            <SessionsTable
                sessions={[]}
                deviceSessions={[SIGN_IN]}
                busyId={null}
                onRevoke={revoke}
                emptyLabel="Nothing"
            />,
            { wrapper: MessagesWrapper }
        );
        expect(screen.queryByText("Nothing")).toBeNull();
        expect(screen.getByText("ada-laptop")).toBeTruthy();
        expect(screen.getAllByText("Command line").length).toBeGreaterThan(0);
        expect(screen.getByText("0.4.6")).toBeTruthy();
        // Where it was approved from, and where it is used from now.
        expect(document.body.textContent).toContain("from 203.0.113.4");
        // The time is drawn, not its markup.
        expect(document.body.textContent).not.toContain("<time>");
        expect(screen.getAllByText(/198\.51\.100\.7/).length).toBeGreaterThan(0);
    });

    it("says when it has not been used yet", () => {
        render(
            <SessionsTable
                sessions={[]}
                deviceSessions={[{ ...SIGN_IN, lastUsedAt: null, lastUsedIp: null }]}
                busyId={null}
                onRevoke={revoke}
                emptyLabel="Nothing"
            />,
            { wrapper: MessagesWrapper }
        );
        expect(screen.getAllByText("Not used yet").length).toBeGreaterThan(0);
    });

    it("is signed out with the same press as a session, and can be locked to its address", () => {
        const signOut = vi.fn();
        const pin = vi.fn();
        render(
            <SessionsTable
                sessions={[]}
                deviceSessions={[SIGN_IN]}
                busyId={null}
                onRevoke={revoke}
                onSignOutDevice={signOut}
                onPinDevice={pin}
                emptyLabel="Nothing"
            />,
            { wrapper: MessagesWrapper }
        );
        fireEvent.click(
            screen.getByRole("button", { name: "Sign out Command line on ada-laptop" })
        );
        expect(signOut).toHaveBeenCalledWith(SIGN_IN);
        fireEvent.click(
            screen.getByRole("button", { name: /Address lock for Command line on ada-laptop/ })
        );
        expect(pin).toHaveBeenCalledWith(SIGN_IN, true);
    });

    it("shows an administrator the sign-out but not the owner's address lock", () => {
        render(
            <SessionsTable
                compact
                sessions={[]}
                deviceSessions={[SIGN_IN]}
                busyId={null}
                onRevoke={revoke}
                onSignOutDevice={revoke}
                emptyLabel="Nothing"
            />,
            { wrapper: MessagesWrapper }
        );
        expect(
            screen.getByRole("button", { name: "Sign out Command line on ada-laptop" })
        ).toBeTruthy();
        expect(screen.queryByRole("button", { name: /Address lock/ })).toBeNull();
    });
});

/**
 * Parity: whatever app signed in, its row offers what a browser session's row
 * does - its history, its address lock and signing it out - through the one
 * shared row, so a kind added to the registry cannot arrive with less.
 */
describe.each(DEVICE_KINDS)("a %s sign-in has a session's controls", (kind) => {
    const APP = { cli: "Command line", streamdeck: "Stream Deck", tv: "Polaris TV" }[kind];

    it("names the app and the device, and links its activity, lock and sign-out", () => {
        const row = { ...SIGN_IN, kind, name: "DRAGON" };
        const signOut = vi.fn();
        render(
            <SessionsTable
                sessions={[]}
                deviceSessions={[row]}
                busyId={null}
                onRevoke={revoke}
                onSignOutDevice={signOut}
                onPinDevice={vi.fn()}
                activityHref={(session) => `/account/activity?session=${session.id}`}
                emptyLabel="Nothing"
            />,
            { wrapper: MessagesWrapper }
        );
        const activity = screen.getByRole("link", { name: `Activity from ${APP} on DRAGON` });
        expect(activity.getAttribute("href")).toBe(`/account/activity?session=${row.id}`);
        expect(
            screen.getByRole("button", { name: new RegExp(`Address lock for ${APP} on DRAGON`) })
        ).toBeTruthy();
        fireEvent.click(screen.getByRole("button", { name: `Sign out ${APP} on DRAGON` }));
        expect(signOut).toHaveBeenCalledWith(row);
    });
});

const EXTENSION = {
    id: "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c",
    name: "Brave on Windows",
    browser: "Brave",
    os: "Windows",
    ip: "203.0.113.4",
    host: null,
    createdAt: "2026-10-01T09:00:00.000Z",
    lastSeenAt: "2026-10-04T09:59:00.000Z",
    vaultClients: 0,
    pinToAddress: null,
    pinnedByRule: false
};

describe("the machine a row runs on", () => {
    it("names the extension after the computer its terminal reported, on both rows", () => {
        render(
            <SessionsTable
                sessions={[]}
                extensions={[EXTENSION]}
                deviceSessions={[
                    {
                        ...SIGN_IN,
                        name: "DRAGON",
                        hostname: "DRAGON",
                        os: "Windows",
                        lastUsedIp: EXTENSION.ip
                    }
                ]}
                busyId={null}
                onRevoke={revoke}
                emptyLabel="Nothing"
            />,
            { wrapper: MessagesWrapper }
        );
        // The CLI row's own name, and the extension's machine label.
        expect(screen.getAllByText("DRAGON")).toHaveLength(2);
    });
});

describe("a browser extension's connection", () => {
    it("links its activity like every other session", () => {
        render(
            <SessionsTable
                sessions={[]}
                extensions={[
                    {
                        id: "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c",
                        name: "Brave on Windows",
                        browser: "Brave",
                        os: "Windows",
                        ip: "203.0.113.4",
                        host: null,
                        createdAt: "2026-10-01T09:00:00.000Z",
                        lastSeenAt: "2026-10-04T09:59:00.000Z",
                        vaultClients: 0,
                        pinToAddress: null,
                        pinnedByRule: false
                    }
                ]}
                busyId={null}
                onRevoke={revoke}
                activityHref={(session) => `/account/activity?session=${session.id}`}
                emptyLabel="Nothing"
            />,
            { wrapper: MessagesWrapper }
        );
        expect(screen.getByRole("link", { name: /^Activity from / }).getAttribute("href")).toBe(
            "/account/activity?session=0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c"
        );
    });
});
