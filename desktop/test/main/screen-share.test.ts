/**
 * The page's share picker opens at once and asks for the list twice: names
 * first, which is the cheaper call, then pictures. Asserted on what each ask
 * hands `desktopCapturer`, since the cost is in that call.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const getSources = vi.fn();
let displayHandler: unknown = null;

vi.mock("electron", () => ({
    BrowserWindow: {},
    desktopCapturer: { getSources: (options: unknown) => getSources(options) },
    dialog: {},
    session: { defaultSession: { setDisplayMediaRequestHandler: (handler: unknown) => (displayHandler = handler) } },
    webContents: {}
}));
vi.mock("@/main/permissions", () => ({ allowPermission: () => true }));

const { chooseShare, hideFromSharing, installScreenShare, listShareSources } = await import("@/main/screen-share");

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

    it("leaves this app's own helper windows out, for as long as they are open", async () => {
        let close = () => undefined as unknown;
        hideFromSharing({ getMediaSourceId: () => "window:1:0", once: (_event, listener) => (close = listener) });
        const listed = await listShareSources({ thumbnails: false });
        expect(listed?.sources.map((source) => source.id)).toEqual(["screen:0:0"]);
        close();
        const after = await listShareSources({ thumbnails: false });
        expect(after?.sources.map((source) => source.id)).toEqual(["screen:0:0", "window:1:0"]);
    });

    it("asks for pictures and icons by default, as an older page expects", async () => {
        await listShareSources();
        expect(getSources).toHaveBeenCalledWith(
            expect.objectContaining({ thumbnailSize: { width: 320, height: 180 }, fetchWindowIcons: true })
        );
    });

    it("reads the windows' icons on the first picture round and reuses them after", async () => {
        const start = Date.now() + 3_600_000;
        await listShareSources({ thumbnails: true }, start);
        await listShareSources({ thumbnails: true }, start + 10_000);
        expect(getSources.mock.calls[0]?.[0]).toMatchObject({ fetchWindowIcons: true });
        expect(getSources.mock.calls[1]?.[0]).not.toHaveProperty("fetchWindowIcons");
        await listShareSources({ thumbnails: true }, start + 70_000);
        expect(getSources.mock.calls[2]?.[0]).toMatchObject({ fetchWindowIcons: true });
    });

    it("shares a source the picker listed without listing everything again", async () => {
        installScreenShare(() => "https://polaris.example");
        await listShareSources({ thumbnails: false });
        getSources.mockClear();
        chooseShare("window:1:0", false);
        const granted = await new Promise<unknown>((resolve) =>
            (displayHandler as (request: object, callback: (streams: unknown) => void) => void)(
                { videoRequested: true, audioRequested: false, securityOrigin: "https://polaris.example", frame: null },
                resolve
            )
        );
        expect(getSources).not.toHaveBeenCalled();
        expect(granted).toEqual({ video: { id: "window:1:0", name: "Editor" } });
    });
});
