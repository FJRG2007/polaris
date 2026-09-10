// @vitest-environment jsdom

/**
 * The connection table, used the way somebody uses it.
 *
 * `connection-list-scroll.test.tsx` pins where the table scrolls; this one pins
 * what it says and does: that a database Polaris runs reads differently from an
 * outside host, that one Polaris knows it cannot reach says so before anybody
 * tests it, that search and the engine filter narrow the rows, that a row opens
 * the workbench, and that removing a connection asks first, only then removes,
 * and puts the row back when the server refuses.
 */

import userEvent from "@testing-library/user-event";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

function connection(overrides: Record<string, unknown>) {
    return {
        id: "conn-shop",
        name: "Shop",
        engine: "postgres",
        where: "db.example.test:5432",
        database: "shop",
        username: "shop",
        readOnly: false,
        tls: false,
        origin: "saved",
        note: null,
        unreachable: false,
        lastUsedAt: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        managedDatabaseId: null,
        ...overrides
    };
}

const CONNECTIONS = [
    connection({}),
    connection({
        id: "managed:cache",
        name: "Cache",
        engine: "redis",
        where: "shop / production",
        database: null,
        username: null,
        readOnly: true,
        origin: "managed",
        managedDatabaseId: "cache",
        note: "Runs on another server and is not published on a port, so Polaris cannot reach it from here.",
        unreachable: true,
        createdAt: null
    })
];

const push = vi.fn();
const deleteConnectionAction = vi.fn(async (_id: string): Promise<{ error?: string }> => ({}));
const testConnectionAction = vi.fn(async (_id: string) => ({
    version: "PostgreSQL 17.2 (Debian 17.2-1.pgdg120+1) on x86_64-pc-linux-gnu"
}));

vi.mock("@/app/(app)/apps/databases/actions", () => ({
    listDatabasesAction: async () => ({ connections: CONNECTIONS }),
    testConnectionAction: (id: string) => testConnectionAction(id),
    deleteConnectionAction: (id: string) => deleteConnectionAction(id)
}));
vi.mock("next/navigation", () => ({
    useRouter: () => ({ push, replace: () => undefined }),
    useSearchParams: () => new URLSearchParams()
}));
vi.mock("@/app/(app)/apps/databases/workbench", () => ({ Workbench: () => null }));
vi.mock("@/app/(app)/apps/databases/connection-dialog", () => ({ ConnectionDialog: () => null }));

const { DatabasesView } = await import("@/app/(app)/apps/databases/databases-view");

beforeAll(() => {
    // What Radix's listbox and dialog reach for and jsdom does not have.
    Element.prototype.hasPointerCapture ??= () => false;
    Element.prototype.releasePointerCapture ??= () => undefined;
    Element.prototype.scrollIntoView ??= () => undefined;
});

beforeEach(() => {
    push.mockClear();
    deleteConnectionAction.mockClear();
    testConnectionAction.mockClear();
    sessionStorage.clear();
});

afterEach(cleanup);

/** The table row that names `name`. */
function rowOf(name: string): HTMLElement {
    const row = screen.getByRole("button", { name }).closest("tr");
    if (!row) throw new Error(`no row for ${name}`);
    return row;
}

async function renderLoaded() {
    const view = render(<DatabasesView />);
    await screen.findByRole("button", { name: "Shop" });
    return view;
}

describe("what each row says", () => {
    it("tells a database Polaris runs from an outside host", async () => {
        await renderLoaded();

        expect(within(rowOf("Shop")).getByText("External")).not.toBeNull();
        expect(within(rowOf("Shop")).getByText("db.example.test:5432")).not.toBeNull();
        expect(within(rowOf("Cache")).getByText("Run by Polaris")).not.toBeNull();
        expect(within(rowOf("Shop")).getByText("PostgreSQL")).not.toBeNull();
        expect(within(rowOf("Cache")).getByText("Redis")).not.toBeNull();
    });

    it("says one it cannot reach is unreachable before anybody tests it", async () => {
        await renderLoaded();

        const status = within(rowOf("Cache")).getByText("Unreachable");
        expect(status.getAttribute("title")).toContain("not published on a port");
        expect(within(rowOf("Shop")).getByText("Not checked")).not.toBeNull();
    });

    it("carries the whole value on a cell that may be clipped", async () => {
        await renderLoaded();

        expect(screen.getByRole("button", { name: "Shop" }).getAttribute("title")).toBe("Shop");
        expect(within(rowOf("Shop")).getByText("db.example.test:5432").getAttribute("title")).toBe(
            "db.example.test:5432"
        );
    });

    it("shows the version a test answered with, and marks it reachable", async () => {
        const user = userEvent.setup();
        await renderLoaded();

        await user.click(screen.getByRole("button", { name: "Test Shop" }));

        expect(await within(rowOf("Shop")).findByText("Reachable")).not.toBeNull();
        expect(within(rowOf("Shop")).getByText("17.2")).not.toBeNull();
        expect(testConnectionAction).toHaveBeenCalledWith("conn-shop");
        // The test is the button's and nothing else's.
        expect(push).not.toHaveBeenCalled();
    });

    it("only offers to edit or remove what was saved here", async () => {
        await renderLoaded();

        expect(screen.queryByRole("button", { name: "Remove Cache" })).toBeNull();
        expect(screen.getByRole("button", { name: "Save Cache as a connection" })).not.toBeNull();
        expect(screen.getByRole("button", { name: "Remove Shop" })).not.toBeNull();
    });
});

describe("opening one", () => {
    it("opens the workbench from a click anywhere on the row", async () => {
        const user = userEvent.setup();
        await renderLoaded();

        await user.click(within(rowOf("Cache")).getByText("Redis"));

        expect(push).toHaveBeenCalledWith("/apps/databases?c=managed%3Acache");
    });

    it("opens from the name, which is what a keyboard reaches", async () => {
        const user = userEvent.setup();
        await renderLoaded();

        await user.click(screen.getByRole("button", { name: "Shop" }));

        expect(push).toHaveBeenCalledTimes(1);
        expect(push).toHaveBeenCalledWith("/apps/databases?c=conn-shop");
    });
});

describe("narrowing the list", () => {
    it("searches by host as well as by name", async () => {
        const user = userEvent.setup();
        await renderLoaded();

        await user.type(screen.getByRole("textbox", { name: /search connections/i }), "production");

        expect(screen.queryByRole("button", { name: "Shop" })).toBeNull();
        expect(screen.getByRole("button", { name: "Cache" })).not.toBeNull();
    });

    it("filters by engine, offering only the engines in the list", async () => {
        const user = userEvent.setup();
        await renderLoaded();

        await user.click(screen.getByRole("combobox", { name: /filter by engine/i }));
        const options = screen.getAllByRole("option").map((option) => option.textContent);
        expect(options).toEqual(["All engines", "PostgreSQL", "Redis"]);
        await user.click(screen.getByRole("option", { name: "Redis" }));

        expect(screen.queryByRole("button", { name: "Shop" })).toBeNull();
        expect(screen.getByRole("button", { name: "Cache" })).not.toBeNull();
    });

    it("says nothing matches, and clears back to everything", async () => {
        const user = userEvent.setup();
        await renderLoaded();

        await user.type(screen.getByRole("textbox", { name: /search connections/i }), "nothing");
        expect(screen.getByText("No connection matches that.")).not.toBeNull();

        await user.click(screen.getByRole("button", { name: "Clear filters" }));

        expect(screen.getByRole("button", { name: "Shop" })).not.toBeNull();
        expect(screen.getByRole("button", { name: "Cache" })).not.toBeNull();
    });
});

describe("removing one", () => {
    it("asks first, and a cancel removes nothing", async () => {
        const user = userEvent.setup();
        await renderLoaded();

        await user.click(screen.getByRole("button", { name: "Remove Shop" }));
        const dialog = await screen.findByRole("dialog");
        expect(within(dialog).getByText("Shop")).not.toBeNull();
        await user.click(within(dialog).getByRole("button", { name: "Cancel" }));

        expect(deleteConnectionAction).not.toHaveBeenCalled();
        expect(screen.getByRole("button", { name: "Shop" })).not.toBeNull();
        expect(push).not.toHaveBeenCalled();
    });

    it("removes the row once confirmed", async () => {
        const user = userEvent.setup();
        await renderLoaded();

        await user.click(screen.getByRole("button", { name: "Remove Shop" }));
        const dialog = await screen.findByRole("dialog");
        await user.click(within(dialog).getByRole("button", { name: "Remove" }));

        expect(deleteConnectionAction).toHaveBeenCalledWith("conn-shop");
        await waitFor(() => expect(screen.queryByRole("button", { name: "Shop" })).toBeNull());
    });

    it("puts the row back and says why when the server refuses", async () => {
        deleteConnectionAction.mockResolvedValueOnce({ error: "That connection is not yours." });
        const user = userEvent.setup();
        await renderLoaded();

        await user.click(screen.getByRole("button", { name: "Remove Shop" }));
        const dialog = await screen.findByRole("dialog");
        await user.click(within(dialog).getByRole("button", { name: "Remove" }));

        const alert = await screen.findByRole("alert");
        expect(alert.textContent).toBe("That connection is not yours.");
        expect(screen.getByRole("button", { name: "Shop" })).not.toBeNull();
    });
});
