// @vitest-environment jsdom

/**
 * The shared folder somebody had open is gone, and the share page says so.
 *
 * The page lands on the nearest folder that still exists (see
 * `share-subpath-landing`); the explorer names what is missing inline, fixes
 * the address bar, and does the same when the folder disappears while it is
 * open - the listing answers `folder_missing` with the nearest folder instead
 * of a dead end.
 */

import { withMessages } from "../setup/i18n";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

vi.mock("next/navigation", () => ({
    usePathname: () => "/",
    useRouter: () => ({ push: () => undefined, refresh: () => undefined })
}));
vi.mock("@/app/(app)/drive/file-viewer", () => ({ FileViewer: () => null, isViewable: () => false }));
vi.mock("@/components/transfers/transfers-view", () => ({ TransfersView: () => null }));
vi.mock("@/components/transfers/move-file", () => ({
    saveFile: () => undefined,
    sendFile: async () => ({ ok: true, body: "{}" })
}));
vi.mock("@/components/relative-time", () => ({ RelativeTime: () => null }));

const { ShareExplorer } = await import("@/app/s/[token]/share-explorer");

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

function explorer(initialPath: string, initialMissing: string | null = null) {
    return withMessages(
        <ShareExplorer
            token="t"
            rootName="Studio"
            rootPath="Studio/Ideas"
            initialPath={initialPath}
            initialMissing={initialMissing}
            allowDownload
            allowPreview
            allowUpload={false}
            allowRename={false}
            allowDelete={false}
            allowCreateFolder={false}
        />
    );
}

describe("a share link to a folder that is gone", () => {
    it("says what is missing and puts the folder it landed on in the address bar", async () => {
        vi.stubGlobal("fetch", async () => Response.json({ entries: [] }));
        window.history.replaceState({}, "", "/s/t?p=Studio%2FIdeas%2FTV%2FLiving%20Room");
        render(explorer("Studio/Ideas/TV", "Studio/Ideas/TV/Living Room"));
        const notice = await waitFor(() => screen.getByRole("status"));
        expect(notice.textContent).toContain("Living Room");
        expect(notice.textContent).toContain("renamed, moved or deleted");
        expect(decodeURIComponent(window.location.search)).toBe("?p=Studio/Ideas/TV");
    });

    it("shows no notice when the address exists", async () => {
        vi.stubGlobal("fetch", async () => Response.json({ entries: [] }));
        render(explorer("Studio/Ideas/TV"));
        await waitFor(() => expect(screen.queryByText(/renamed, moved or deleted/)).toBeNull());
        expect(document.querySelector("[data-share-missing]")).toBeNull();
    });

    it("lands on the nearest folder when the open one disappears", async () => {
        const asked: string[] = [];
        vi.stubGlobal("fetch", async (url: string) => {
            const p = new URL(url, "http://x").searchParams.get("p") ?? "";
            asked.push(p);
            if (p === "Studio/Ideas/TV")
                return Response.json(
                    { error: "folder_missing", nearest: "Studio/Ideas" },
                    { status: 404 }
                );
            return Response.json({ entries: [] });
        });
        render(explorer("Studio/Ideas/TV"));
        await waitFor(() =>
            expect(document.querySelector("[data-share-missing]")?.textContent).toContain('"TV"')
        );
        await waitFor(() => expect(asked).toContain(""));
        expect(window.location.search).toBe("");
    });
});
