// @vitest-environment jsdom

/**
 * A shared folder of photos, as the person it was sent to sees it: it opens as
 * a photo timeline with the pictures on its tiles, read through the link's own
 * routes, and the preview steps through the folder's files with the arrows and
 * its buttons - without offering a download the link does not allow.
 */

import { MessagesWrapper } from "../setup/i18n";
import userEvent from "@testing-library/user-event";
import type { DriveEntry } from "@/app/(app)/drive/types";
import { useMemoryStorage } from "./fixtures/memory-storage";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

vi.mock("next/navigation", () => ({
    usePathname: () => "/",
    useRouter: () => ({ push: () => undefined, refresh: () => undefined })
}));
vi.mock("@/components/transfers/transfers-view", () => ({ TransfersView: () => null }));
vi.mock("@/components/transfers/move-file", () => ({
    saveFile: () => undefined,
    sendFile: async () => ({ ok: true, body: "{}" })
}));
vi.mock("@/components/relative-time", () => ({ RelativeTime: () => null }));

const { ShareExplorer } = await import("@/app/s/[token]/share-explorer");

function photo(name: string, day: number): DriveEntry {
    const at = `2026-10-${String(day).padStart(2, "0")}T12:00:00.000Z`;
    return { name, path: name, kind: "file", size: "2048", modifiedAt: at, createdAt: at };
}

const ALBUM: DriveEntry[] = [
    { ...photo("Edits", 1), kind: "dir", size: "0" },
    ...Array.from({ length: 8 }, (_, i) => photo(`IMG_${i + 1}.jpg`, 20 - i))
];

/** The class an active view toggle carries (not its hover variant). */
const ACTIVE = /(^|\s)bg-muted(\s|$)/;

beforeEach(() => {
    useMemoryStorage();
    // jsdom lays nothing out; the virtualizers need a box to window into.
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
    vi.unstubAllGlobals();
});

function share(entries: DriveEntry[], { allowDownload = true } = {}) {
    vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(JSON.stringify({ entries }), { status: 200 }))
    );
    return render(
        <MessagesWrapper>
            <ShareExplorer
                token="t"
                rootName="Album"
                rootPath=""
                initialPath=""
                allowDownload={allowDownload}
                allowPreview
                allowUpload={false}
                allowRename={false}
                allowDelete={false}
                allowCreateFolder={false}
            />
        </MessagesWrapper>
    );
}

describe("a shared folder of photos", () => {
    it("opens in the photo view, each tile read through the link's thumbnail route", async () => {
        share(ALBUM);
        const toggle = await screen.findByRole("button", { name: "Photo view" });
        await waitFor(() => expect(toggle.className).toMatch(ACTIVE));
        // Every photo tile drawn so far carries its picture, read through the
        // link; the rest are virtualized below the fold.
        const tiles = [...document.querySelectorAll("[data-drive-row]")].filter((tile) =>
            /\.jpg$/.test(tile.getAttribute("aria-label") ?? "")
        );
        expect(tiles.length).toBeGreaterThan(0);
        for (const tile of tiles) {
            expect(tile.querySelector("img[src^='/api/s/t/thumbnail?']")).not.toBeNull();
        }
        // Never Drive's own routes, which a visitor has no session for.
        expect(document.querySelector("img[src*='/api/drive/']")).toBeNull();
    });

    it("lays the photos out newest first under a heading per day, without choosing a sort", async () => {
        share([ALBUM[0]!, ...ALBUM.slice(1).reverse()]);
        const headings = await screen.findAllByRole("heading", { level: 3 });
        expect(headings.length).toBeGreaterThan(1);
        expect(headings[0]!.textContent).toMatch(/Oct 20/);
        expect(headings[1]!.textContent).toMatch(/Oct 19/);
    });

    it("goes back to the list when asked, and remembers it", async () => {
        const user = userEvent.setup();
        share(ALBUM);
        await user.click(await screen.findByRole("button", { name: "List view" }));
        expect(window.localStorage.getItem("polaris.drive.viewModes")).toContain(
            '["share:t:","list"]'
        );
        expect(screen.getByRole("button", { name: "Photo view" }).className).not.toMatch(ACTIVE);
    });

    it("draws the pictures in the grid too", async () => {
        const user = userEvent.setup();
        share(ALBUM);
        await user.click(await screen.findByRole("button", { name: "Grid view" }));
        const pictures = document.querySelectorAll("img[src^='/api/s/t/thumbnail?']");
        expect(pictures.length).toBe(8);
    });

    it("does not offer the photo view for a folder of documents", async () => {
        share(["a.docx", "b.pdf", "c.txt", "d.xlsx", "e.md", "f.csv"].map((n) => photo(n, 1)));
        await screen.findByRole("button", { name: "List view" });
        await screen.findByText("a.docx");
        expect(screen.queryByRole("button", { name: "Photo view" })).toBeNull();
    });
});

describe("the preview of a shared photo", () => {
    it("steps through the folder's files with the arrows and the buttons, and Escape closes it", async () => {
        const user = userEvent.setup();
        share(ALBUM);
        await user.dblClick(await screen.findByLabelText("IMG_1.jpg"));

        const dialog = await screen.findByRole("dialog");
        expect(within(dialog).getByText("1 of 8")).toBeTruthy();

        await user.keyboard("{ArrowRight}");
        expect(within(dialog).getByText("2 of 8")).toBeTruthy();
        expect(within(dialog).getByRole("heading", { name: "IMG_2.jpg" })).toBeTruthy();

        await user.click(within(dialog).getAllByRole("button", { name: "Previous file" })[0]!);
        expect(within(dialog).getByText("1 of 8")).toBeTruthy();

        // The first file: back goes nowhere.
        await user.keyboard("{ArrowLeft}");
        expect(within(dialog).getByText("1 of 8")).toBeTruthy();

        await user.keyboard("{Escape}");
        await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    });

    it("offers no download on a link that does not allow one", async () => {
        const user = userEvent.setup();
        share(ALBUM, { allowDownload: false });
        await user.dblClick(await screen.findByLabelText("IMG_1.jpg"));
        const dialog = await screen.findByRole("dialog");
        expect(within(dialog).getByText("1 of 8")).toBeTruthy();
        expect(within(dialog).queryByRole("button", { name: /Download/ })).toBeNull();
    });

    it("offers the download on a link that allows it", async () => {
        const user = userEvent.setup();
        share(ALBUM);
        await user.dblClick(await screen.findByLabelText("IMG_1.jpg"));
        const dialog = await screen.findByRole("dialog");
        expect(within(dialog).getByRole("button", { name: /Download/ })).toBeTruthy();
    });
});

describe("a finger on a shared folder", () => {
    /** A click as a finger sends it: jsdom's MouseEvent carries no pointer type. */
    function tap(element: Element) {
        const click = new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 });
        Object.defineProperty(click, "pointerType", { value: "touch" });
        fireEvent(element, click);
    }

    it("opens a file from the list with one tap", async () => {
        share(["a.jpg", "b.pdf", "c.txt", "d.xlsx", "e.md", "f.csv"].map((n) => photo(n, 1)));
        tap((await screen.findByText("b.pdf")).closest("[data-share-row]")!);
        expect(await screen.findByRole("dialog")).toBeTruthy();
    });
});
