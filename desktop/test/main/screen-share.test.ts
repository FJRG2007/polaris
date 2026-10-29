/**
 * The page's share picker opens at once and asks for the list twice: names
 * first, which is the cheaper call, then pictures. Asserted on what each ask
 * hands `desktopCapturer`, since the cost is in that call.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const getSources = vi.fn();

vi.mock("electron", () => ({
    BrowserWindow: {},
    desktopCapturer: { getSources: (options: unknown) => getSources(options) },
    dialog: {},
    session: {},
    webContents: {}
}));
vi.mock("@/main/permissions", () => ({ allowPermission: () => true }));

const { listShareSources } = await import("@/main/screen-share");

const image = (empty: boolean) => ({
    isEmpty: () => empty,
    toJPEG: () => Buffer.from("jpeg"),
    resize: () => ({ toDataURL: () => "data:image/png;base64,aWNvbg==" })
});

describe.runIf(process.platform !== "darwin")("listing what can be shared", () => {
    beforeEach(() => {
        getSources.mockReset();
        getSources.mockResolvedValue([
            { id: "window:1:0", name: " Editor ", thumbnail: image(true), appIcon: null, display_id: "" },
            { id: "screen:0:0", name: "Screen 1", thumbnail: image(true), appIcon: null, display_id: "1" }
        ]);
    });

    it("asks for names only, with no pictures or icons, when told to", async () => {
        const listed = await listShareSources({ thumbnails: false });
        expect(getSources).toHaveBeenCalledWith({ types: ["screen", "window"], thumbnailSize: { width: 0, height: 0 } });
        expect(listed?.sources.map((source) => [source.id, source.kind, source.name, source.thumbnail])).toEqual([
            ["screen:0:0", "screen", "Screen 1", null],
            ["window:1:0", "window", "Editor", null]
        ]);
    });

    it("asks for pictures and icons by default, as an older page expects", async () => {
        await listShareSources();
        expect(getSources).toHaveBeenCalledWith(
            expect.objectContaining({ thumbnailSize: { width: 320, height: 180 }, fetchWindowIcons: true })
        );
    });
});
