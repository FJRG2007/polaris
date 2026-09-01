// @vitest-environment jsdom

/**
 * The connection list has to scroll, because the screen around it will not.
 *
 * The Databases page fills the window and clips what overflows - that is what
 * lets the workbench's three panes scroll on their own instead of the whole page
 * moving under somebody reading a wide table. The list of connections is not a
 * set of panes, though: it is a grid that grows with however many databases
 * somebody has added, and when the page stopped scrolling it simply got cut off
 * at the bottom of the window with no way to reach what was past the fold.
 *
 * So this asserts the structural rule rather than an appearance: the growing part
 * carries its own scroller and is allowed to shrink inside its parent, and the
 * row with "New connection" in it does not scroll away from somebody who has more
 * connections than fit.
 *
 * Classes rather than measured pixels, deliberately: jsdom does no layout, so a
 * height assertion here would pass whatever the CSS said. What regressed was
 * exactly this pair of classes going missing.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

/** Enough connections that the grid is taller than any window. */
const CONNECTIONS = Array.from({ length: 24 }, (_, index) => ({
    id: `connection-${index}`,
    name: `Database ${index}`,
    engine: "postgres",
    where: "db.example.test:5432",
    readOnly: false,
    origin: "saved",
    note: null,
    lastUsedAt: null,
    managedDatabaseId: null
}));

vi.mock("./actions", () => ({}));
vi.mock("@/app/(app)/apps/databases/actions", () => ({
    listDatabasesAction: async () => ({ connections: CONNECTIONS }),
    testConnectionAction: async () => ({ version: "17" }),
    deleteConnectionAction: async () => ({})
}));
vi.mock("next/navigation", () => ({
    useRouter: () => ({ push: () => undefined, replace: () => undefined }),
    useSearchParams: () => new URLSearchParams()
}));
vi.mock("@/components/confirm-dialog", () => ({
    useConfirm: () => [async () => true, null]
}));
// The workbench is the other branch of this screen and pulls the whole browser
// with it; nothing here opens a connection.
vi.mock("@/app/(app)/apps/databases/workbench", () => ({ Workbench: () => null }));
vi.mock("@/app/(app)/apps/databases/connection-dialog", () => ({ ConnectionDialog: () => null }));

const { DatabasesView } = await import("@/app/(app)/apps/databases/databases-view");

afterEach(cleanup);

/** The element the connection cards are laid out in. */
function grid(container: HTMLElement): HTMLElement {
    const found = container.querySelector<HTMLElement>("div.grid");
    if (!found) throw new Error("the connection list drew no grid");
    return found;
}

describe("the list of connections", () => {
    it("scrolls inside the screen rather than being clipped by it", async () => {
        const { container } = render(<DatabasesView />);
        await screen.findByText("Database 0");

        const list = grid(container);
        expect(list.className).toContain("overflow-y-auto");
        // Without this the grid keeps its full height inside a flex parent and
        // the scroller never engages - which is the same clipped list wearing a
        // different cause.
        expect(list.className).toContain("min-h-0");
    });

    it("keeps the way to add one out of the scroller", async () => {
        const { container } = render(<DatabasesView />);
        const add = await screen.findByRole("button", { name: /new connection/i });

        expect(grid(container).contains(add)).toBe(false);
    });

    it("lets the column shrink, so the scroller has something to scroll in", async () => {
        const { container } = render(<DatabasesView />);
        await screen.findByText("Database 0");

        const root = container.firstElementChild as HTMLElement;
        expect(root.className).toContain("min-h-0");
        expect(root.className).toContain("flex-1");
    });
});
