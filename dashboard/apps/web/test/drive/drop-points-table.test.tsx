// @vitest-environment jsdom

/**
 * Drop points as a table, chosen the way Drive chooses files.
 *
 * The report: drop points were a column of cards with no way to act on more than
 * one, so clearing out old ones was one dialog per drop point. They are a table
 * now, with a checkbox per row and one for all of them, Shift for a stretch,
 * Ctrl (Cmd) with a press to toggle a row, Ctrl+A for every row shown, and one
 * delete for everything chosen behind the same question a single delete asks -
 * folders included, switched on.
 */

import { MessagesWrapper } from "../setup/i18n";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";

const deleteFileRequestsAction = vi.fn(async (ids: string[], _folders: boolean) => ({
    deleted: ids,
    failed: [] as { id: string; error: string }[]
}));

vi.mock("@/app/(app)/drive/request-actions", () => ({
    deleteFileRequestAction: async () => ({}),
    deleteFileRequestsAction,
    reopenFileRequestAction: async () => undefined,
    revokeFileRequestAction: async () => undefined
}));

const { DropPointsView } = await import("@/app/(app)/drive/drop-points/drop-points-view");

const row = (id: string, title: string, destinationPath = `Drop Points/${title}`) => ({
    id,
    title,
    destinationPath,
    connectionName: "NAS",
    requireLogin: false,
    maxFiles: null,
    submissionCount: 2,
    startsAt: null,
    expiresAt: null,
    revokedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z"
});

const requests = [row("a", "Photos"), row("b", "Invoices"), row("c", "Scans"), row("d", "Root", "")];

function view() {
    render(
        <MessagesWrapper>
            <DropPointsView requests={requests} />
        </MessagesWrapper>
    );
}

const box = (name: string) => screen.getByRole("checkbox", { name: `Select ${name}` }) as HTMLInputElement;
const chosen = () =>
    screen
        .getAllByRole("row")
        .filter((one) => one.getAttribute("aria-selected") === "true")
        .map((one) => within(one).getByRole("link").textContent);

beforeEach(() => deleteFileRequestsAction.mockClear());
afterEach(cleanup);

describe("the drop point table", () => {
    it("is a table with a column header for every field", () => {
        view();
        const table = screen.getByRole("table");
        for (const header of ["Name", "Files", "Status"]) {
            expect(within(table).getByRole("columnheader", { name: header })).toBeTruthy();
        }
        expect(screen.getAllByRole("row")).toHaveLength(requests.length + 1);
    });

    it("selects a stretch with Shift, and toggles a row with Ctrl", () => {
        view();
        fireEvent.click(box("Photos"));
        fireEvent.click(box("Scans"), { shiftKey: true });
        expect(chosen()).toEqual(["Photos", "Invoices", "Scans"]);

        // Ctrl with a press on the row chooses rather than opens.
        const invoices = screen.getByRole("link", { name: "Invoices" });
        const opened = fireEvent.click(invoices, { ctrlKey: true });
        expect(opened).toBe(false);
        expect(chosen()).toEqual(["Photos", "Scans"]);
    });

    it("takes every row with Ctrl+A and the header box, and lets go with Escape", () => {
        view();
        const table = screen.getByRole("table").parentElement!;
        fireEvent.keyDown(table, { key: "a", ctrlKey: true });
        expect(chosen()).toHaveLength(4);
        fireEvent.keyDown(table, { key: "Escape" });
        expect(chosen()).toHaveLength(0);
        fireEvent.click(screen.getByRole("checkbox", { name: "Select all" }));
        expect(chosen()).toHaveLength(4);
        fireEvent.click(screen.getByRole("checkbox", { name: "Select all" }));
        expect(chosen()).toHaveLength(0);
    });

    it("chooses only what the search shows", () => {
        view();
        fireEvent.change(screen.getByRole("textbox", { name: "Search drop points" }), {
            target: { value: "Pho" }
        });
        fireEvent.click(screen.getByRole("checkbox", { name: "Select all" }));
        expect(screen.getByText("1 selected")).toBeTruthy();
    });

    it("deletes everything chosen behind one question, folders on by default", async () => {
        view();
        fireEvent.click(screen.getByRole("checkbox", { name: "Select all" }));
        fireEvent.click(screen.getByRole("button", { name: "Delete 4" }));

        const dialog = await screen.findByRole("dialog");
        expect(within(dialog).getByText("Delete 4 drop points?")).toBeTruthy();
        const folders = within(dialog).getByRole("switch", { name: "Delete their folders too" });
        expect(folders.getAttribute("aria-checked")).toBe("true");
        // Three have a folder of their own; the one at the root is not counted.
        expect(within(dialog).getByText(/3 folders/)).toBeTruthy();

        await act(async () => {
            fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
        });
        expect(deleteFileRequestsAction).toHaveBeenCalledWith(["a", "b", "c", "d"], true);
        expect(screen.queryByRole("table")).toBeNull();
    });

    it("keeps what could not be deleted, and says why", async () => {
        deleteFileRequestsAction.mockResolvedValueOnce({
            deleted: ["a"],
            failed: [{ id: "b", error: "The share is offline." }]
        });
        view();
        fireEvent.click(box("Photos"));
        fireEvent.click(box("Invoices"));
        fireEvent.click(screen.getByRole("button", { name: "Delete 2" }));
        await act(async () => {
            fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Delete" }));
        });
        expect(await screen.findByText("1 was not deleted")).toBeTruthy();
        expect(screen.getByText(/Invoices: The share is offline\./)).toBeTruthy();
        await act(async () => {
            fireEvent.click(screen.getByRole("button", { name: "OK" }));
        });
        expect(screen.queryByRole("link", { name: "Photos" })).toBeNull();
        expect(screen.getByRole("link", { name: "Invoices" })).toBeTruthy();
    });
});
