// @vitest-environment jsdom

/**
 * A breadcrumb segment has its folder's own menu: right-click (and the menu key
 * or Shift+F10, which the browser turns into the same event) on "Projects" in
 * "Home > Projects > 2026" opens the menu the Projects row gets, about Projects
 * alone - never the selection in the listing below.
 */

import userEvent from "@testing-library/user-event";
import { FilesView } from "@/app/(app)/drive/files-view";
import type { DriveEntry } from "@/app/(app)/drive/types";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MessagesWrapper } from "../setup/i18n";

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

const FILE: DriveEntry = {
    name: "report.pdf",
    path: "Projects/2026/report.pdf",
    kind: "file",
    size: "10",
    modifiedAt: "2026-01-01T00:00:00.000Z",
    createdAt: "2026-01-01T00:00:00.000Z"
};

const noop = () => {};

function renderFilesView(entries: DriveEntry[], onDelete = noop) {
    return render(
        <MessagesWrapper>
            <FilesView
                connectionId="c1"
                path="Projects/2026"
                segments={["Projects", "2026"]}
                entries={entries}
                loading={false}
                error={null}
                pending={false}
                uploading={false}
                fileInput={{ current: null }}
                href={(id, target) => `/drive?c=${id}&p=${target}`}
                // Everything on offer, so what these assert stays about the gesture
                // rather than about who is allowed to make it.
                abilities={{ read: true, write: true, remove: true }}
                onNewFolder={noop}
                onNewFile={noop}
                onUpload={noop}
                onDelete={onDelete}
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
        </MessagesWrapper>
    );
}

describe("a breadcrumb segment's menu", () => {
    it("is the folder row's menu, about that folder rather than the selection", async () => {
        const user = userEvent.setup();
        const onDelete = vi.fn();
        renderFilesView([FILE], onDelete);

        // Something selected below, which the segment's menu must not act on.
        await user.click((await screen.findByText("report.pdf")).closest("[data-drive-row]")!);

        const crumb = screen.getByRole("link", { name: "Projects" });
        await user.pointer({ keys: "[MouseRight]", target: crumb });
        const menu = await screen.findByRole("menu");
        expect(within(menu).getByText("Projects")).toBeTruthy();
        // A folder's items, and no rename: that happens in a row.
        expect(within(menu).getByRole("menuitem", { name: /Open/ })).toBeTruthy();
        expect(within(menu).queryByRole("menuitem", { name: /Rename/ })).toBeNull();

        await user.click(within(menu).getByRole("menuitem", { name: /Delete/ }));
        await user.click(await screen.findByRole("menuitem", { name: /Move to Trash/ }));
        expect(onDelete).toHaveBeenCalledTimes(1);
        expect(onDelete.mock.calls[0]![0].map((entry: DriveEntry) => entry.path)).toEqual([
            "Projects"
        ]);
    });
});
