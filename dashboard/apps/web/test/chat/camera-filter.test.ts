/**
 * The pipeline between a camera and the call, when it cannot be built and when
 * the model stops answering.
 *
 * The same reasoning as `mic-filter.test`, pointed at the picture instead of the
 * sound, and with the stakes the other way round. A microphone filter that fails
 * silently costs somebody their voice; a camera background that fails silently
 * costs them the thing they turned it on to hide.
 *
 * So what is asserted is that a model which will not load, or a browser without
 * WebGL 2, comes back saying so rather than as a bare null; that a background
 * nobody asked for never costs a single element, download or frame; that the
 * first frame - the one that holds the main thread while the model compiles -
 * is taken inside the call the screen is already waiting on; and that a model
 * that stops answering blurs the room rather than handing it back.
 *
 * The model and the GPU compositor are replaced: what is under test is the
 * orchestration around them. Their own numbers are `camera-mask.test`'s.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

/** Everything the module asked the document to make. */
const made: string[] = [];

/** Whether the model file is on the server. Off unless a case says so. */
let modelServed = false;
let fetches = 0;
/** Whether a canvas will hand over a WebGL 2 context. */
let webgl = true;
/** Whether the model throws instead of answering. */
let modelBroken = false;

let segments = 0;
const renders: { blind: boolean }[] = [];
const tracked: number[] = [];

vi.mock("@mediapipe/tasks-vision", () => ({
    FilesetResolver: { isSimdSupported: async () => true },
    ImageSegmenter: {
        createFromOptions: async () => ({
            segmentForVideo: () => {
                segments += 1;
                if (modelBroken) throw new Error("lost context");
                const answer = { width: 256, height: 256, getAsWebGLTexture: () => ({}) };
                // Background first, person last - the order the runtime uses.
                return { confidenceMasks: [{ ...answer, width: 1 }, answer], close: () => undefined };
            },
            close: () => undefined
        })
    }
}));

vi.mock("@/app/(app)/chat/camera-compositor", () => ({
    createCompositor: () => ({
        track: (_texture: unknown, width: number) => tracked.push(width),
        render: (frame: { blind: boolean }) => renders.push({ blind: frame.blind }),
        readMask: () => null,
        dispose: () => undefined
    })
}));

class FakeVideo {
    autoplay = false;
    playsInline = false;
    muted = false;
    srcObject: unknown = null;
    readyState = 4;
    videoWidth = 640;
    videoHeight = 360;
    onloadeddata: (() => void) | null = null;
    async play(): Promise<void> {}
}

class FakeCanvas {
    width = 0;
    height = 0;
    getContext(kind: string): unknown {
        if (kind === "webgl2") return webgl ? {} : null;
        return { globalCompositeOperation: "source-over", filter: "none", drawImage: () => undefined };
    }
    captureStream(): { getVideoTracks: () => unknown[] } {
        return { getVideoTracks: () => [{ id: "masked", stop: () => undefined }] };
    }
}

let workers = 0;
let tick: (() => void) | null = null;

vi.stubGlobal("MediaStream", class {});
vi.stubGlobal(
    "Image",
    class {
        src = "";
        naturalWidth = 1280;
        naturalHeight = 720;
        async decode(): Promise<void> {}
    }
);
vi.stubGlobal("HTMLCanvasElement", FakeCanvas);
vi.stubGlobal("document", {
    createElement: (tag: string) => {
        made.push(tag);
        return tag === "video" ? new FakeVideo() : new FakeCanvas();
    }
});
vi.stubGlobal("fetch", async () => {
    fetches += 1;
    return modelServed
        ? { ok: true, arrayBuffer: async () => new ArrayBuffer(8) }
        : { ok: false, arrayBuffer: async () => new ArrayBuffer(0) };
});
vi.stubGlobal(
    "Worker",
    class {
        onmessage: (() => void) | null = null;
        constructor() {
            workers += 1;
            // eslint-disable-next-line @typescript-eslint/no-this-alias
            const self = this;
            tick = () => self.onmessage?.();
        }
        postMessage(): void {}
        terminate(): void {}
    }
);
(globalThis.URL as unknown as { createObjectURL: () => string }).createObjectURL = () =>
    "blob:ticker";
const scope: Record<string, unknown> = {
    localStorage: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined },
    dispatchEvent: () => true,
    HTMLCanvasElement: FakeCanvas
};
vi.stubGlobal("window", scope);

const { maskCamera } = await import("@/app/(app)/chat/camera-filter");

const track = {
    readyState: "live",
    enabled: true,
    getSettings: () => ({ frameRate: 30 })
} as unknown as MediaStreamTrack;

beforeEach(() => {
    made.length = 0;
    renders.length = 0;
    tracked.length = 0;
    segments = 0;
    workers = 0;
    fetches = 0;
    modelServed = false;
    modelBroken = false;
    webgl = true;
    tick = null;
});

describe("a background nobody asked for", () => {
    it("costs nothing at all", async () => {
        expect(await maskCamera(track, "off")).toBeNull();
        // Not an element and not a download: "off" is the default, so this is
        // every call in the deployment.
        expect(made).toHaveLength(0);
        expect(fetches).toBe(0);
    });

    it("is not built for a picture that was never chosen", async () => {
        expect(await maskCamera(track, "image", null)).toBeNull();
        expect(made).toHaveLength(0);
    });
});

describe("a model that will not load", () => {
    it("says so instead of coming back as a bare null", async () => {
        const built = await maskCamera(track, "blur");
        // Not null: null means "nothing was asked for", and something was.
        expect(built).not.toBeNull();
        expect(built?.track).toBeNull();
        expect(built?.using).toBe("blur");
        expect(built?.problem).toMatch(/not on this server/);
    });

    it("is tried again next time rather than remembered as broken", async () => {
        await maskCamera(track, "strong");
        await maskCamera(track, "strong");
        // A cached failure would have answered from the first attempt, and a
        // deployment that staged its assets a minute later would stay broken
        // until the tab was reloaded.
        expect(fetches).toBe(2);
    });
});

describe("a browser without WebGL 2", () => {
    it("keeps the plain camera and says why", async () => {
        webgl = false;
        modelServed = true;
        const built = await maskCamera(track, "blur");
        expect(built?.track).toBeNull();
        expect(built?.problem).toMatch(/WebGL 2/);
        // Refused before anything was downloaded.
        expect(fetches).toBe(0);
    });
});

describe("starting the model", () => {
    it("has already segmented a frame by the time it hands the track back", async () => {
        modelServed = true;
        const built = await maskCamera(track, "blur");
        expect(built?.track).not.toBeNull();
        // Exactly one, and before this resolved: the worker is a fake that
        // never ticks on its own.
        expect(segments).toBe(1);
        expect(tracked).toEqual([256]);
        expect(renders).toEqual([{ blind: false }]);
        expect(workers).toBe(1);
        await built?.stop();
    });

    it("takes the person's mask, which the runtime hands back last", async () => {
        modelServed = true;
        const built = await maskCamera(track, "image", "/backgrounds/desk.webp");
        // The background mask in the fake is 1 wide; the person's is 256.
        expect(tracked).toEqual([256]);
        await built?.stop();
    });
});

describe("a model that stops answering", () => {
    it("blurs the whole room rather than handing it back", async () => {
        modelServed = true;
        const built = await maskCamera(track, "image", "/backgrounds/desk.webp");
        modelBroken = true;
        for (let frame = 0; frame < 12; frame += 1) tick?.();
        const last = renders.slice(-3);
        // Every frame after it gave up is drawn blind: all background, blurred.
        expect(last.every((frame) => frame.blind)).toBe(true);
        // And it stops being asked once it has given up.
        const asked = segments;
        tick?.();
        expect(segments).toBe(asked);
        await built?.stop();
    });
});

describe("insertable streams", () => {
    it("sends the generator's track, with the first frame already through", async () => {
        modelServed = true;
        const written: unknown[] = [];
        let reads = 0;
        class Frame {
            timestamp = 0;
            displayWidth = 1280;
            displayHeight = 720;
            close(): void {}
        }
        scope.VideoFrame = class {
            constructor(readonly from: unknown) {}
        };
        scope.MediaStreamTrackProcessor = class {
            readable = {
                getReader: () => ({
                    // One frame, then a camera that has ended.
                    read: async () =>
                        (reads += 1) === 1 ? { done: false, value: new Frame() } : { done: true },
                    cancel: async () => undefined
                })
            };
        };
        scope.MediaStreamTrackGenerator = class {
            id = "generated";
            stop(): void {}
            writable = {
                getWriter: () => ({
                    write: async (frame: unknown) => written.push(frame),
                    close: async () => undefined
                })
            };
        };
        vi.stubGlobal("VideoFrame", scope.VideoFrame);
        try {
            const built = await maskCamera(track, "blur");
            expect((built?.track as unknown as { id: string }).id).toBe("generated");
            expect(written).toHaveLength(1);
            expect(segments).toBe(1);
            // No video element and no worker: the camera's own frames drive it.
            expect(made).not.toContain("video");
            expect(workers).toBe(0);
            await built?.stop();
        } finally {
            delete scope.VideoFrame;
            delete scope.MediaStreamTrackProcessor;
            delete scope.MediaStreamTrackGenerator;
        }
    });
});
