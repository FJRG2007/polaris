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
import { cleanup, render, screen, within } from "@testing-library/react";
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
        const thumbnails = document.querySelectorAll("img[src*='/api/drive/thumbnail']");
        expect(thumbnails.length).toBe(8);
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
