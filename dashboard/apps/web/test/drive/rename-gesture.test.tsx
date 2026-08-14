// @vitest-environment jsdom

/**
 * Renaming a Drive entry is deliberately not on a double click.
 *
 * It used to be, on the name text alone, and the hit area was the problem: the
 * thing people double-click most in a file list is a folder they want to open,
 * and the name is what their pointer is already on. This pins the fix: a
 * double-click on the row opens the entry (never starts a rename), and renaming
 * is reached from the two places that mean it - F2 on a selected row, and Rename
 * in the context menu.
 */

import userEvent from "@testing-library/user-event";
import { FilesView } from "@/app/(app)/drive/files-view";
import type { DriveEntry } from "@/app/(app)/drive/types";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
// These pull in "use server" action chains that need real env config; none of
// them run in these cases (no profile opened, no archive browsed, no zip built).
vi.mock("@/components/user-profile-dialog", () => ({ UserProfileDialog: () => null }));
vi.mock("@/app/(app)/drive/actions", () => ({}));
vi.mock("@/app/(app)/drive/share-actions", () => ({}));
vi.mock("@/app/(app)/drive/activity-actions", () => ({}));

// The virtualizer measures its scroll container via getBoundingClientRect; jsdom
// reports every element as 0x0, which would windows the list down to nothing.
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
});

afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    push.mockClear();
});

const FOLDER: DriveEntry = {
    name: "Projects",
    path: "Projects",
    kind: "dir",
    size: "0",
    modifiedAt: "2026-01-01T00:00:00.000Z",
    createdAt: "2026-01-01T00:00:00.000Z"
};

const noop = () => {};

function renderFilesView(entries: DriveEntry[]) {
    return render(
        <FilesView
            connectionId="c1"
            path=""
            segments={[]}
            entries={entries}
            loading={false}
            error={null}
            pending={false}
            uploading={false}
            fileInput={{ current: null }}
            href={(id, target) => `/drive?c=${id}&p=${target}`}
            onNewFolder={noop}
            onNewFile={noop}
            onUpload={noop}
            onDelete={noop}
            onRename={noop}
            onToggleHidden={noop}
            onSetFavorite={noop}
            onSetIcon={noop}
            onSetNote={noop}
            onMove={noop}
            onCopy={noop}
            onDeletePermanent={noop}
            onEmptyFolder={noop}
            onScheduleDelete={noop}
        />
    );
}

describe("double-clicking a Drive row", () => {
    it("opens the folder instead of starting a rename, even landing on the name text itself", async () => {
        const user = userEvent.setup();
        renderFilesView([FOLDER]);

        // The name text is exactly where the old per-name handler lived (and
        // where a user's pointer already is when they double-click a folder),
        // so the double-click has to land there, not on the row shell.
        const nameText = await screen.findByText("Projects");

        await user.dblClick(nameText);

        expect(push).toHaveBeenCalledWith("/drive?c=c1&p=Projects");
        // No rename field appeared - the double-click never armed a rename.
        expect(screen.queryByDisplayValue("Projects")).toBeNull();
    });
});

describe("renaming a Drive entry", () => {
    it("is reached with F2 once the row is selected, not with a double click", async () => {
        const user = userEvent.setup();
        renderFilesView([FOLDER]);

        const row = (await screen.findByText("Projects")).closest("[data-drive-row]");
        expect(row).not.toBeNull();

        await user.click(row!);
        expect(screen.queryByDisplayValue("Projects")).toBeNull();

        await user.keyboard("{F2}");

        const field = await screen.findByDisplayValue("Projects");
        expect(field.tagName).toBe("INPUT");
    });
});
