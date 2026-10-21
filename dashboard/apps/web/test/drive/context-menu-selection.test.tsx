// @vitest-environment jsdom

/**
 * A right-click on an item that is part of the selection acts on the whole
 * selection; one outside it acts on that item alone.
 *
 * The rule itself was right. What broke it was the press on a menu item: React
 * hands events along its own tree, so the press inside the row's menu - drawn in
 * a portal - reached the list's marquee handler, which emptied the selection
 * between the press on "Move to..." and its release. The menu redrew for one
 * item and the release landed on whatever entry was now under the pointer.
 */

import userEvent from "@testing-library/user-event";
import { FilesView } from "@/app/(app)/drive/files-view";
import type { DriveEntry } from "@/app/(app)/drive/types";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MessagesWrapper } from "../setup/i18n";
import { fromOutside, menuTargets } from "@/app/(app)/drive/menu-targets";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
// These pull in "use server" action chains that need real env config; none of
// them run in these cases (no profile opened, no archive browsed, no zip built).
vi.mock("@/components/user-profile-dialog", () => ({ UserProfileDialog: () => null }));
vi.mock("@/app/(app)/drive/actions", () => ({}));
vi.mock("@/app/(app)/drive/share-actions", () => ({}));
vi.mock("@/app/(app)/drive/activity-actions", () => ({}));
// The viewer is never opened here, and it pulls in the office editors.
vi.mock("@/app/(app)/drive/file-viewer", () => ({ FilePreview: () => null, isViewable: () => false }));

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

function file(name: string): DriveEntry {
    return {
        name,
        path: `Docs/${name}`,
        kind: "file",
        size: "10",
        modifiedAt: "2026-01-01T00:00:00.000Z",
        createdAt: "2026-01-01T00:00:00.000Z"
    };
}

const A = file("alpha.txt");
const B = file("beta.txt");
const C = file("gamma.txt");

const noop = () => {};

function renderFilesView(entries: DriveEntry[], onMove: (entries: DriveEntry[], dest: string) => void = noop) {
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
            // Everything on offer, so what these assert stays about the gesture
            // rather than about who is allowed to make it.
            abilities={{ read: true, write: true, remove: true }}
            onNewFolder={noop}
            onNewFile={noop}
            onUpload={noop}
            onDelete={noop}
            onRename={noop}
            onToggleHidden={noop}
            onSetFavorite={noop}
            onSetIcon={noop}
            onSetNote={noop}
            onMove={onMove}
            onCopy={noop}
            onDeletePermanent={noop}
            onEmptyFolder={noop}
            onScheduleDelete={noop}
        />,
        { wrapper: MessagesWrapper }
    );
}

describe("what a right-click acts on", () => {
    const selected = new Set([A.path, B.path]);

    it("is the whole selection when the item is in it", () => {
        expect(menuTargets(selected, [A, B], B)).toEqual([A, B]);
    });

    it("is the item alone when it is outside the selection", () => {
        expect(menuTargets(selected, [A, B], C)).toEqual([C]);
    });

    it("is the item alone when it is the only one selected", () => {
        expect(menuTargets(new Set([A.path]), [A], A)).toEqual([A]);
    });
});

describe("events from a portal", () => {
    it("are told apart from the listing's own", () => {
        const list = document.createElement("div");
        const row = document.createElement("div");
        const menu = document.createElement("div");
        list.append(row);
        document.body.append(list, menu);
        expect(fromOutside({ currentTarget: list, target: row })).toBe(false);
        expect(fromOutside({ currentTarget: list, target: list })).toBe(false);
        expect(fromOutside({ currentTarget: list, target: menu })).toBe(true);
        list.remove();
        menu.remove();
    });
});

describe("Move to... from a row's menu", () => {
    it("moves every selected item when the menu is opened on one of their names", async () => {
        const user = userEvent.setup();
        const onMove = vi.fn();
        renderFilesView([A, B, C], onMove);

        const alpha = (await screen.findByText("alpha.txt")).closest("[data-drive-row]")!;
        const beta = await screen.findByText("beta.txt");
        await user.click(alpha);
        await user.keyboard("{Control>}");
        await user.click(beta.closest("[data-drive-row]")!);
        await user.keyboard("{/Control}");

        // On the name itself, which is where the pointer is.
        await user.pointer({ keys: "[MouseRight]", target: beta });
        const menu = await screen.findByRole("menu");
        expect(within(menu).getByText("2 items selected")).toBeTruthy();
        await user.click(within(menu).getByRole("menuitem", { name: "Move to..." }));

        const dialog = await screen.findByRole("dialog");
        expect(within(dialog).getByText("Move 2 items")).toBeTruthy();

        await user.clear(within(dialog).getByPlaceholderText("e.g. Documents/Archive"));
        await user.type(within(dialog).getByPlaceholderText("e.g. Documents/Archive"), "Archive");
        await user.click(within(dialog).getByRole("button", { name: "Move" }));
        expect(onMove).toHaveBeenCalledTimes(1);
        expect(onMove.mock.calls[0]![0].map((entry: DriveEntry) => entry.path)).toEqual([
            A.path,
            B.path
        ]);
        expect(onMove.mock.calls[0]![1]).toBe("Archive");
    });

    it("moves only the item right-clicked when it is outside the selection", async () => {
        const user = userEvent.setup();
        const onMove = vi.fn();
        renderFilesView([A, B, C], onMove);

        await user.click((await screen.findByText("alpha.txt")).closest("[data-drive-row]")!);
        await user.keyboard("{Control>}");
        await user.click((await screen.findByText("beta.txt")).closest("[data-drive-row]")!);
        await user.keyboard("{/Control}");

        await user.pointer({ keys: "[MouseRight]", target: await screen.findByText("gamma.txt") });
        const menu = await screen.findByRole("menu");
        await user.click(within(menu).getByRole("menuitem", { name: "Move to..." }));

        const dialog = await screen.findByRole("dialog");
        expect(within(dialog).getByText("Move item")).toBeTruthy();
    });
});
