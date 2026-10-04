// @vitest-environment jsdom

/**
 * A CLI sign-in on the sessions table: listed with the facts a session row has,
 * ended with the same press, and - for an administrator - without the address
 * lock, which stays the owner's to change.
 */

import { MessagesWrapper } from "../setup/i18n";
import type { CliSessionView } from "@/lib/cli/sessions";
import { SessionsTable } from "@/components/sessions-table";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

afterEach(cleanup);

const SIGN_IN: CliSessionView = {
    id: "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b",
    name: "ada-laptop",
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
                cliSessions={[SIGN_IN]}
                busyId={null}
                onRevoke={() => undefined}
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
                cliSessions={[{ ...SIGN_IN, lastUsedAt: null, lastUsedIp: null }]}
                busyId={null}
                onRevoke={() => undefined}
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
                cliSessions={[SIGN_IN]}
                busyId={null}
                onRevoke={() => undefined}
                onSignOutCli={signOut}
                onPinCli={pin}
                emptyLabel="Nothing"
            />,
            { wrapper: MessagesWrapper }
        );
        fireEvent.click(
            screen.getByRole("button", { name: "Sign ada-laptop out of the command line" })
        );
        expect(signOut).toHaveBeenCalledWith(SIGN_IN);
        fireEvent.click(
            screen.getByRole("button", { name: /Address lock for ada-laptop command line/ })
        );
        expect(pin).toHaveBeenCalledWith(SIGN_IN, true);
    });

    it("shows an administrator the sign-out but not the owner's address lock", () => {
        render(
            <SessionsTable
                compact
                sessions={[]}
                cliSessions={[SIGN_IN]}
                busyId={null}
                onRevoke={() => undefined}
                onSignOutCli={() => undefined}
                emptyLabel="Nothing"
            />,
            { wrapper: MessagesWrapper }
        );
        expect(
            screen.getByRole("button", { name: "Sign ada-laptop out of the command line" })
        ).toBeTruthy();
        expect(screen.queryByRole("button", { name: /Address lock/ })).toBeNull();
    });
});
