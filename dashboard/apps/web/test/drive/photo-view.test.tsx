// @vitest-environment jsdom

/**
 * Pictures in Drive: a tile asks for its picture in a way the browser will
 * actually answer, a folder of photos opens as photos, and the preview steps
 * through the folder's files with the arrow keys and its buttons.
 */

import { MessagesWrapper } from "../setup/i18n";
import { useMemoryStorage } from "./fixtures/memory-storage";
import userEvent from "@testing-library/user-event";
import { FilesView } from "@/app/(app)/drive/files-view";
import type { DriveEntry } from "@/app/(app)/drive/types";
import { EntryThumbnail } from "@/app/(app)/drive/entry-thumbnail";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
vi.mock("@/components/user-profile-dialog", () => ({ UserProfileDialog: () => null }));
vi.mock("@/app/(app)/drive/actions", () => ({}));
vi.mock("@/app/(app)/drive/share-actions", () => ({}));
vi.mock("@/app/(app)/drive/activity-actions", () => ({}));

// jsdom lays nothing out; the virtualizers need a box to window into.
beforeEach(() => {
    useMemoryStorage();
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
        width: 800,
        height: 600,
        top: 0,
        left: 0,
        right: 800,
        bottom: 600,
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

function photo(name: string, day: number): DriveEntry {
    const at = `2026-10-${String(day).padStart(2, "0")}T12:00:00.000Z`;
    return { name, path: name, kind: "file", size: "2048", modifiedAt: at, createdAt: at };
}

const ALBUM: DriveEntry[] = [
    { ...photo("Edits", 1), kind: "dir", size: "0" },
    ...Array.from({ length: 8 }, (_, i) => photo(`IMG_${i + 1}.jpg`, 20 - i))
];

const noop = () => {};

/** The class an active view toggle carries (not its hover variant). */
const ACTIVE = /(^|\s)bg-muted(\s|$)/;

function renderFilesView(entries: DriveEntry[]) {
    return render(
        <MessagesWrapper>
            <FilesView
                connectionId="c1"
                path="Photos"
                segments={[]}
                entries={entries}
                loading={false}
                error={null}
                pending={false}
                uploading={false}
                fileInput={{ current: null }}
                href={(id, target) => `/drive?c=${id}&p=${target}`}
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
                onMove={noop}
                onCopy={noop}
                onDeletePermanent={noop}
                onEmptyFolder={noop}
                onScheduleDelete={noop}
            />
        </MessagesWrapper>
    );
}

describe("a tile's picture", () => {
    it("is requested without lazy loading and is never display:none while it loads", () => {
        // The bug: `loading="lazy"` on an image hidden with `display: none`. A
        // lazy image with no box never enters the viewport, so the browser never
        // fetched it, `onLoad` never fired, and every tile kept its icon.
        const { container } = render(
            <EntryThumbnail connectionId="c1" path="Photos/IMG_1.jpg" version="v1">
                <span>icon</span>
            </EntryThumbnail>
        );
        const picture = container.querySelector("img");
        expect(picture).not.toBeNull();
        expect(picture!.getAttribute("src")).toContain("/api/drive/thumbnail?c=c1");
        expect(picture!.getAttribute("loading")).toBeNull();
        expect(picture!.classList.contains("hidden")).toBe(false);
        expect(picture!.hasAttribute("data-pending")).toBe(true);
    });
});

describe("a folder of photos", () => {
    it("opens in the photo view, with a picture for every photo", async () => {
        renderFilesView(ALBUM);
        const toggle = await screen.findByRole("button", { name: "Photo view" });
        expect(toggle.className).toMatch(ACTIVE);
        // Every photo tile drawn so far carries its picture; the rest are
        // virtualized below the fold.
        const tiles = Array.from(document.querySelectorAll("[data-drive-row]")).filter((tile) =>
            /\.jpg$/.test(tile.getAttribute("aria-label") ?? "")
        );
        expect(tiles.length).toBeGreaterThan(0);
        for (const tile of tiles) {
            expect(tile.querySelector("img[src*='/api/drive/thumbnail']")).not.toBeNull();
        }
    });

    it("lays the photos out under a heading per day, newest first, without choosing a sort", async () => {
        const shuffled = [ALBUM[0]!, ...ALBUM.slice(1).reverse()];
        renderFilesView(shuffled);
        await screen.findByRole("button", { name: "Photo view" });
        const headings = await screen.findAllByRole("heading", { level: 3 });
        expect(headings.length).toBeGreaterThan(1);
        expect(headings[0]!.textContent).toMatch(/\bOct 20\b/);
        expect(headings[1]!.textContent).toMatch(/\bOct 19\b/);
    });

    it("goes back to sorting by name in the list", async () => {
        const user = userEvent.setup();
        renderFilesView([ALBUM[0]!, ...ALBUM.slice(1).reverse()]);
        await user.click(await screen.findByRole("button", { name: "List view" }));
        const names = Array.from(document.querySelectorAll("[data-drive-row]")).map(
            (row) => row.textContent?.match(/IMG_\d/)?.[0]
        );
        expect(names.filter(Boolean).slice(0, 3)).toEqual(["IMG_1", "IMG_2", "IMG_3"]);
    });

    it("remembers a switch back to the list for that folder", async () => {
        const user = userEvent.setup();
        renderFilesView(ALBUM);
        await user.click(await screen.findByRole("button", { name: "List view" }));
        expect(window.localStorage.getItem("polaris.drive.viewModes")).toContain(
            '["c1:Photos","list"]'
        );
        cleanup();
        renderFilesView(ALBUM);
        const photos = await screen.findByRole("button", { name: "Photo view" });
        expect(photos.className).not.toMatch(ACTIVE);
    });

    it("does not offer the photo view for a folder of documents", async () => {
        const docs = ["a.docx", "b.pdf", "c.txt", "d.xlsx", "e.md", "f.csv"].map((name) => ({
            ...photo(name, 1)
        }));
        renderFilesView(docs);
        await screen.findByRole("button", { name: "List view" });
        expect(screen.queryByRole("button", { name: "Photo view" })).toBeNull();
    });
});

describe("the preview of a photo", () => {
    it("steps through the folder's files with the arrows and the buttons, skipping folders", async () => {
        const user = userEvent.setup();
        renderFilesView(ALBUM);
        const tile = await screen.findByLabelText("IMG_1.jpg");
        await user.dblClick(tile);

        expect(await screen.findByText("1 of 8")).toBeTruthy();
        const header = screen.getByRole("button", { name: "Back" }).parentElement!;
        expect(within(header).getByText("IMG_1.jpg")).toBeTruthy();

        await user.keyboard("{ArrowRight}");
        expect(within(header).getByText("IMG_2.jpg")).toBeTruthy();
        expect(screen.getByText("2 of 8")).toBeTruthy();

        await user.click(screen.getByRole("button", { name: "Previous file" }));
        expect(within(header).getByText("IMG_1.jpg")).toBeTruthy();

        // The first file: back goes nowhere, and does not wrap to a folder.
        await user.keyboard("{ArrowLeft}");
        expect(within(header).getByText("IMG_1.jpg")).toBeTruthy();
    });

    it("leaves the listing's cursor on the file it stepped to", async () => {
        const user = userEvent.setup();
        renderFilesView(ALBUM);
        await user.dblClick(await screen.findByLabelText("IMG_1.jpg"));
        await screen.findByText("1 of 8");
        await user.keyboard("{ArrowRight}{ArrowRight}");
        expect(screen.getByText("3 of 8")).toBeTruthy();
        await user.click(screen.getByRole("button", { name: "Back" }));

        const third = await screen.findByLabelText("IMG_3.jpg");
        expect(third.className).toMatch(/ring-primary/);
        (third.closest("[tabindex='0']") as HTMLElement).focus();
        await user.keyboard("{ArrowRight}");
        expect(screen.getByLabelText("IMG_4.jpg").className).toMatch(/ring-primary/);
        expect(screen.getByLabelText("IMG_3.jpg").className).not.toMatch(/ring-primary/);
    });

    it("leaves the arrows to a field that has focus", async () => {
        const user = userEvent.setup();
        renderFilesView(ALBUM);
        await user.dblClick(await screen.findByLabelText("IMG_3.jpg"));
        await screen.findByText("3 of 8");
        const field = document.createElement("input");
        document.body.appendChild(field);
        field.focus();
        await user.keyboard("{ArrowRight}");
        expect(screen.getByText("3 of 8")).toBeTruthy();
        field.remove();
    });
});

/** A click as a finger sends it: jsdom's MouseEvent carries no pointer type. */
function tap(element: Element, detail = 1) {
    const click = new MouseEvent("click", { bubbles: true, cancelable: true, detail });
    Object.defineProperty(click, "pointerType", { value: "touch" });
    fireEvent(element, click);
}

describe("a finger in Drive", () => {
    const docs = [
        { ...photo("Edits", 1), kind: "dir" as const, size: "0" },
        photo("a.docx", 2),
        photo("b.pdf", 3)
    ];

    it("opens a folder with one tap in the list", async () => {
        renderFilesView(docs);
        const row = (await screen.findByText("Edits")).closest("[data-drive-row]")!;
        tap(row);
        expect(push).toHaveBeenCalledWith("/drive?c=c1&p=Edits");
    });

    it("opens a photo with one tap, and a double tap does not count twice", async () => {
        renderFilesView(ALBUM);
        const tile = await screen.findByLabelText("IMG_1.jpg");
        tap(tile);
        expect(await screen.findByText("1 of 8")).toBeTruthy();
        fireEvent.click(screen.getByRole("button", { name: "Back" }));
        tap(tile, 2);
        expect(screen.queryByText("1 of 8")).toBeNull();
    });

    it("picks instead of opening once something is picked", async () => {
        renderFilesView(docs);
        const row = (await screen.findByText("a.docx")).closest("[data-drive-row]")!;
        fireEvent.click(within(row as HTMLElement).getByRole("checkbox"));
        const other = (await screen.findByText("Edits")).closest("[data-drive-row]")!;
        tap(other);
        expect(push).not.toHaveBeenCalled();
    });

    it("still selects with a mouse click and leaves opening to the double click", async () => {
        renderFilesView(docs);
        const row = (await screen.findByText("Edits")).closest("[data-drive-row]")!;
        fireEvent.click(row);
        expect(push).not.toHaveBeenCalled();
        fireEvent.doubleClick(row);
        expect(push).toHaveBeenCalledWith("/drive?c=c1&p=Edits");
    });
});
