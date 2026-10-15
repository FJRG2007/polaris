// @vitest-environment jsdom

/**
 * A database's Users and Connections tabs: the accounts Polaris signs in with
 * offer nothing to change, a generated password is shown once, and the
 * connection that made the listing is marked and offers no End button. Ending
 * any other goes through the panel's dialog, never the browser's.
 */

import { MessagesWrapper } from "../setup/i18n";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const calls = vi.hoisted(() => ({
    create: vi.fn(async () => ({
        username: "reporting",
        password: "Generated_password_0123456789abcd"
    })),
    kill: vi.fn(async () => ({}))
}));

vi.mock("@/app/(app)/apps/deploy/deploy-view", () => ({
    CopyRow: ({ value }: { value: string }) => <output>{value}</output>
}));
vi.mock("@/app/(app)/apps/deploy/database-actions", () => ({
    listDatabaseAccountsAction: async () => ({
        accounts: [
            { username: "shop", databases: ["shop"], protected: true },
            { username: "reporting", databases: ["shop"], protected: false }
        ],
        databases: ["shop"]
    }),
    createDatabaseAccountAction: calls.create,
    dropDatabaseAccountAction: vi.fn(async () => ({})),
    grantDatabaseAccountAction: vi.fn(async () => ({})),
    revokeDatabaseAccountAction: vi.fn(async () => ({})),
    listDatabaseProcessesAction: async () => ({
        processes: [
            {
                id: 41,
                user: "shop",
                database: "postgres",
                client: "local",
                state: "active",
                seconds: 0,
                self: true,
                query: "SELECT 1"
            },
            {
                id: 7,
                user: "web",
                database: "shop",
                client: "10.0.0.4",
                state: "idle",
                seconds: 93,
                self: false,
                query: ""
            }
        ]
    }),
    killDatabaseProcessAction: calls.kill
}));

import {
    ProcessesSection,
    UsersSection,
    hasAccountTabs
} from "@/app/(app)/apps/deploy/database-accounts-panel";

const DB = "0192f1e2-7b5c-7d3e-8f00-00000000000a";

afterEach(cleanup);

describe("hasAccountTabs", () => {
    it("is for a dedicated single-node PostgreSQL, MySQL or MariaDB", () => {
        expect(hasAccountTabs({ engine: "postgres", hosted: false, topology: null })).toBe(true);
        expect(hasAccountTabs({ engine: "mariadb", hosted: false, topology: null })).toBe(true);
        expect(hasAccountTabs({ engine: "postgres", hosted: true, topology: null })).toBe(false);
        expect(
            hasAccountTabs({ engine: "mysql", hosted: false, topology: { kind: "replicas" } })
        ).toBe(false);
        expect(hasAccountTabs({ engine: "redis", hosted: false, topology: null })).toBe(false);
    });
});

describe("UsersSection", () => {
    it("offers nothing on Polaris's own account and shows a new password once", async () => {
        render(<UsersSection databaseId={DB} manage ask={vi.fn()} />, { wrapper: MessagesWrapper });
        await screen.findByText("reporting");
        expect(screen.queryByRole("button", { name: "Remove shop" })).toBeNull();
        expect(screen.getByRole("button", { name: "Remove reporting" })).toBeTruthy();

        fireEvent.change(screen.getByLabelText("Account name"), { target: { value: "Root" } });
        expect(screen.getByText("That name belongs to the engine. Pick another.")).toBeTruthy();
        fireEvent.change(screen.getByLabelText("Account name"), { target: { value: "reporting" } });
        fireEvent.click(screen.getByRole("button", { name: /Add account/ }));
        expect(await screen.findByText("Generated_password_0123456789abcd")).toBeTruthy();
        fireEvent.click(screen.getByRole("button", { name: "Close" }));
        expect(screen.queryByText("Generated_password_0123456789abcd")).toBeNull();
    });

    it("draws no changes for a reader", async () => {
        render(<UsersSection databaseId={DB} manage={false} ask={vi.fn()} />, {
            wrapper: MessagesWrapper
        });
        await screen.findByText("reporting");
        expect(screen.queryByRole("button", { name: /Add account/ })).toBeNull();
        expect(screen.queryByRole("button", { name: "Remove reporting" })).toBeNull();
    });
});

describe("ProcessesSection", () => {
    it("marks its own connection and asks before ending another", async () => {
        const ask = vi.fn();
        render(<ProcessesSection databaseId={DB} manage ask={ask} />, { wrapper: MessagesWrapper });
        await screen.findByText("This list");
        const ends = screen.getAllByRole("button", { name: "End" });
        expect(ends).toHaveLength(1);
        fireEvent.click(ends[0]);
        expect(ask).toHaveBeenCalledTimes(1);
        expect(calls.kill).not.toHaveBeenCalled();
        await ask.mock.calls[0][0].run();
        await waitFor(() =>
            expect(calls.kill).toHaveBeenCalledWith({ databaseId: DB, processId: 7 })
        );
    });
});
