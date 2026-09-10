// @vitest-environment jsdom

/**
 * The connection table has to scroll, because the screen around it will not.
 *
 * The Databases page fills the window and clips what overflows - that is what
 * lets the workbench's three panes scroll on their own instead of the whole page
 * moving under somebody reading a wide table. The list of connections is not a
 * set of panes, though: it is a table that grows with however many databases
 * somebody has added, and when the page stopped scrolling it simply got cut off
 * at the bottom of the window with no way to reach what was past the fold. On a
 * phone the same table is wider than the screen, and has to scroll sideways
 * inside itself rather than pushing the page.
 *
 * So this asserts the structural rule rather than an appearance: the table sits
 * in its own scroller that is allowed to shrink inside its parent, and the row
 * with "New connection" and the search in it does not scroll away from somebody
 * who has more connections than fit.
 *
 * Classes rather than measured pixels, deliberately: jsdom does no layout, so a
 * height assertion here would pass whatever the CSS said. What regressed was
 * exactly these classes going missing.
 */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Enough connections that the table is taller than any window. */
const CONNECTIONS = Array.from({ length: 24 }, (_, index) => ({
    id: `connection-${index}`,
    name: `Database ${index}`,
    engine: "postgres",
    where: "db.example.test:5432",
    database: "app",
    username: "app",
    readOnly: false,
    tls: false,
    origin: "saved",
    note: null,
    unreachable: false,
    lastUsedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    managedDatabaseId: null
}));

vi.mock("@/app/(app)/apps/databases/actions", () => ({
    listDatabasesAction: async () => ({ connections: CONNECTIONS }),
    testConnectionAction: async () => ({ version: "17" }),
    deleteConnectionAction: async () => ({})
}));
vi.mock("next/navigation", () => ({
    useRouter: () => ({ push: () => undefined, replace: () => undefined }),
    useSearchParams: () => new URLSearchParams()
}));
// The workbench is the other branch of this screen and pulls the whole browser
// with it; nothing here opens a connection.
vi.mock("@/app/(app)/apps/databases/workbench", () => ({ Workbench: () => null }));
vi.mock("@/app/(app)/apps/databases/connection-dialog", () => ({ ConnectionDialog: () => null }));

const { DatabasesView } = await import("@/app/(app)/apps/databases/databases-view");

// A render keeps the list it read for the next visit; each test starts cold.
beforeEach(() => sessionStorage.clear());
afterEach(cleanup);

/** The element the connection table scrolls in. */
function scroller(container: HTMLElement): HTMLElement {
    const found = container.querySelector<HTMLElement>("table")?.parentElement;
    if (!found) throw new Error("the connection list drew no table");
    return found;
}

describe("the table of connections", () => {
    it("scrolls inside the screen rather than being clipped by it", async () => {
        const { container } = render(<DatabasesView />);
        await screen.findByText("Database 0");

        const list = scroller(container);
        // Both ways: down for a long list, sideways for a phone.
        expect(list.className).toContain("overflow-auto");
        // Without this the box keeps its full height inside a flex parent and
        // the scroller never engages - which is the same clipped list wearing a
        // different cause.
        expect(list.className).toContain("min-h-0");
        // Wider than a phone on purpose, so it scrolls instead of crushing.
        expect(container.querySelector("table")?.className).toMatch(/min-w-\[/);
    });

    it("keeps the way to add one and the search out of the scroller", async () => {
        const { container } = render(<DatabasesView />);
        const add = await screen.findByRole("button", { name: /new connection/i });
        const search = screen.getByRole("textbox", { name: /search connections/i });

        expect(scroller(container).contains(add)).toBe(false);
        expect(scroller(container).contains(search)).toBe(false);
    });

    it("lets the column shrink, so the scroller has something to scroll in", async () => {
        const { container } = render(<DatabasesView />);
        await screen.findByText("Database 0");

        const root = container.firstElementChild as HTMLElement;
        expect(root.className).toContain("min-h-0");
        expect(root.className).toContain("flex-1");
    });

    it("paints the table chrome before the list arrives", () => {
        const { container } = render(<DatabasesView />);

        // Synchronously, before the action has answered: headings, search and
        // the button are there, and only the rows are placeholders.
        expect(screen.getByRole("columnheader", { name: "Engine" })).not.toBeNull();
        expect(screen.getByRole("textbox", { name: /search connections/i })).not.toBeNull();
        const placeholders = container.querySelectorAll('tbody tr[aria-hidden="true"]');
        expect(placeholders.length).toBeGreaterThan(0);
    });

    it("paints the list this tab last read at once on a return", async () => {
        const first = render(<DatabasesView />);
        await screen.findByText("Database 0");
        first.unmount();

        render(<DatabasesView />);

        // No await: the kept copy is on screen before the fresh read answers.
        expect(screen.getByText("Database 0")).not.toBeNull();
    });
});
