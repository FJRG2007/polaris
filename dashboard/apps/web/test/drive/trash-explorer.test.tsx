// @vitest-environment jsdom

/**
 * The bin is the explorer's listing, not a second one.
 *
 * The Trash page used to be its own card list, with none of the explorer's
 * views, sorting, selection or keyboard. It now renders the same `FilesView` in
 * its bin mode: the bin's actions are there and the explorer's are not, a
 * multi-selection goes to the server in one request, and emptying the bin asks
 * first in the app's own dialog.
 */

import { MessagesWrapper } from "../setup/i18n";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TrashView, type TrashRow } from "@/app/(app)/drive/trash/trash-view";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const actions = vi.hoisted(() => ({
    restoreTrashItemsAction: vi.fn(),
    deleteTrashItemsForeverAction: vi.fn(),
    emptyTrashAction: vi.fn()
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/components/user-profile-dialog", () => ({ UserProfileDialog: () => null }));
vi.mock("@/app/(app)/drive/actions", () => actions);
vi.mock("@/app/(app)/drive/share-actions", () => ({}));
vi.mock("@/app/(app)/drive/activity-actions", () => ({}));

// The virtualizer measures its scroll container; jsdom reports every element as
// 0x0, which would window the list down to nothing.
beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
        width: 800,
        height: 400,
        top: 0,
        left: 0,
        right: 800,
        bottom: 400,
        x: 0,
        y: 0,
        toJSON() {
            return {};
        }
    });
    actions.restoreTrashItemsAction.mockReset();
    actions.deleteTrashItemsForeverAction.mockReset();
    actions.emptyTrashAction.mockReset();
});

afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
});

const ROWS: TrashRow[] = [
    {
        id: "0190a1b2-0000-7000-8000-000000000001",
        name: "report.pdf",
        originalPath: "docs/2026/report.pdf",
        connectionId: "conn-a",
        connectionName: "Office NAS",
        trashPath: ".polaris/trash/aa-report.pdf",
        kind: "file",
        size: "2048",
        deletedAt: "2026-10-20T10:00:00.000Z"
    },
    {
        id: "0190a1b2-0000-7000-8000-000000000002",
        name: "old-photos",
        originalPath: "old-photos",
        connectionId: "conn-b",
        connectionName: "Backup",
        trashPath: ".polaris/trash/bb-old-photos",
        kind: "dir",
        size: "0",
        deletedAt: "2026-10-21T10:00:00.000Z"
    }
];
const IDS = ROWS.map((row) => row.id);

function renderTrash(abilities = { restore: true, remove: true }) {
    return render(<TrashView items={ROWS} abilities={abilities} />, {
        wrapper: MessagesWrapper
    });
}

function selectAll() {
    fireEvent.click(screen.getByRole("checkbox", { name: "Select all" }));
}

describe("the bin in the explorer's listing", () => {
    it("draws the explorer's list with the bin's columns and rows", () => {
        renderTrash();
        expect(screen.getByRole("heading", { name: "Trash" })).toBeTruthy();
        expect(screen.getByText("report.pdf")).toBeTruthy();
        expect(screen.getByText("old-photos")).toBeTruthy();
        expect(screen.getByRole("button", { name: /Sort by original location/i })).toBeTruthy();
        expect(screen.getByRole("button", { name: /deleted on/i })).toBeTruthy();
        expect(screen.getByRole("button", { name: "List view" })).toBeTruthy();
        expect(screen.getByRole("button", { name: "Empty Trash" })).toBeTruthy();
    });

    it("links each row to the folder it was deleted from", () => {
        renderTrash();
        const link = screen.getByRole("link", { name: "Office NAS / docs/2026" });
        expect(link.getAttribute("href")).toBe("/drive?c=conn-a&p=docs%2F2026");
        const root = screen.getByRole("link", { name: "Backup / (root)" });
        expect(root.getAttribute("href")).toBe("/drive?c=conn-b");
    });

    it("offers none of the explorer's own actions", () => {
        renderTrash();
        for (const name of ["New folder", "Upload", "Starred", "Hidden"]) {
            expect(screen.queryByRole("button", { name })).toBeNull();
        }
        expect(screen.queryByRole("button", { name: /search scope|subfolders/i })).toBeNull();
        selectAll();
        expect(screen.queryByRole("button", { name: "Download ZIP" })).toBeNull();
        expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
        expect(screen.getByRole("button", { name: "Restore" })).toBeTruthy();
        expect(screen.getByRole("button", { name: "Delete forever" })).toBeTruthy();
    });

    it("hides what the reader may not do", () => {
        renderTrash({ restore: false, remove: false });
        expect(screen.queryByRole("button", { name: "Empty Trash" })).toBeNull();
        selectAll();
        expect(screen.queryByRole("button", { name: "Restore" })).toBeNull();
        expect(screen.queryByRole("button", { name: "Delete forever" })).toBeNull();
    });

    it("shows the explorer's empty state with the bin's words", () => {
        render(<TrashView items={[]} abilities={{ restore: true, remove: true }} />, {
            wrapper: MessagesWrapper
        });
        expect(screen.getByText("The Trash is empty.")).toBeTruthy();
        expect(screen.queryByRole("button", { name: "Empty Trash" })).toBeNull();
    });
});

describe("acting on a selection", () => {
    it("restores every picked row in one request, and they leave at once", async () => {
        actions.restoreTrashItemsAction.mockResolvedValue({ done: IDS, failures: [] });
        renderTrash();
        selectAll();
        fireEvent.click(screen.getByRole("button", { name: "Restore" }));
        expect(screen.queryByText("report.pdf")).toBeNull();
        await waitFor(() => expect(actions.restoreTrashItemsAction).toHaveBeenCalledTimes(1));
        expect([...actions.restoreTrashItemsAction.mock.calls[0]![0]].sort()).toEqual(
            [...IDS].sort()
        );
        expect(screen.getByText("The Trash is empty.")).toBeTruthy();
    });

    it("puts back what the server could not restore, and says why", async () => {
        actions.restoreTrashItemsAction.mockResolvedValue({
            done: [IDS[1]],
            failures: [{ id: IDS[0], reason: "That location is locked." }],
            error: "That location is locked."
        });
        renderTrash();
        selectAll();
        fireEvent.click(screen.getByRole("button", { name: "Restore" }));
        await screen.findByText("That location is locked.");
        expect(screen.getByText("report.pdf")).toBeTruthy();
        expect(screen.queryByText("old-photos")).toBeNull();
    });

    it("deletes every picked row forever in one request, after asking", async () => {
        actions.deleteTrashItemsForeverAction.mockResolvedValue({ done: IDS, failures: [] });
        renderTrash();
        selectAll();
        fireEvent.click(screen.getByRole("button", { name: "Delete forever" }));
        await screen.findByText("Permanently delete 2 items?");
        expect(actions.deleteTrashItemsForeverAction).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole("button", { name: "Delete" }));
        await waitFor(() => expect(actions.deleteTrashItemsForeverAction).toHaveBeenCalledTimes(1));
        expect([...actions.deleteTrashItemsForeverAction.mock.calls[0]![0]].sort()).toEqual(
            [...IDS].sort()
        );
    });
});

describe("emptying the bin", () => {
    it("asks in the app's dialog first, and does nothing on cancel", async () => {
        const nativeConfirm = vi.spyOn(window, "confirm");
        renderTrash();
        fireEvent.click(screen.getByRole("button", { name: "Empty Trash" }));
        await screen.findByText("Empty the Trash?");
        fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
        await waitFor(() => expect(screen.queryByText("Empty the Trash?")).toBeNull());
        expect(actions.emptyTrashAction).not.toHaveBeenCalled();
        expect(nativeConfirm).not.toHaveBeenCalled();
    });

    it("empties it once confirmed", async () => {
        actions.emptyTrashAction.mockResolvedValue({});
        renderTrash();
        fireEvent.click(screen.getByRole("button", { name: "Empty Trash" }));
        await screen.findByText("Empty the Trash?");
        const buttons = screen.getAllByRole("button", { name: "Empty Trash" });
        fireEvent.click(buttons[buttons.length - 1]!);
        await waitFor(() => expect(actions.emptyTrashAction).toHaveBeenCalledTimes(1));
        expect(await screen.findByText("The Trash is empty.")).toBeTruthy();
    });

    it("brings everything back when the server refuses", async () => {
        actions.emptyTrashAction.mockResolvedValue({ error: "Could not reach Backup." });
        renderTrash();
        fireEvent.click(screen.getByRole("button", { name: "Empty Trash" }));
        await screen.findByText("Empty the Trash?");
        const buttons = screen.getAllByRole("button", { name: "Empty Trash" });
        fireEvent.click(buttons[buttons.length - 1]!);
        await screen.findByText("Could not reach Backup.");
        expect(screen.getByText("report.pdf")).toBeTruthy();
    });
});
