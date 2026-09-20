/**
 * The canvas between a camera and the call, when it cannot be built.
 *
 * The same reasoning as `mic-filter.test`, pointed at the picture instead of the
 * sound, and with the stakes the other way round. A microphone filter that fails
 * silently costs somebody their voice; a camera background that fails silently
 * costs them the thing they turned it on to hide. Both are invisible from the
 * screen of the person it is happening to - a call carries on, the setting still
 * says "Blur my background", and the only evidence is in the room behind them.
 *
 * So what is asserted is that a model which will not load comes back saying so
 * rather than as a bare null, and that a background nobody asked for never costs
 * a single element, download or frame.
 *
 * And one case about *when* a cost is paid rather than whether it works.
 * Starting this model holds the main thread for about a second the first time in
 * a tab, and it does that work on its first frame rather than in `initialize` -
 * so a build that returned before running one handed back a track that was not
 * ready and dropped the freeze on whatever the page did next. It is taken inside
 * the call the screen is already waiting on.
 */

import { describe, expect, it, vi } from "vitest";

/** Everything the module asked the document to make, so a test can assert that
 *  it asked for nothing at all. */
const made: string[] = [];

class FakeVideo {
    autoplay = false;
    playsInline = false;
    srcObject: unknown = null;
    /** Already past `HAVE_CURRENT_DATA` with a frame in it: the camera is not
     *  what is being tested here. */
    readyState = 4;
    videoWidth = 640;
    videoHeight = 360;
    onloadeddata: (() => void) | null = null;
    async play(): Promise<void> {}
}

const context = {
    globalCompositeOperation: "source-over",
    filter: "none",
    drawImage: () => undefined
};

class FakeCanvas {
    width = 0;
    height = 0;
    getContext(): typeof context {
        return context;
    }
    captureStream(): { getVideoTracks: () => unknown[] } {
        return { getVideoTracks: () => [{ id: "masked", stop: () => undefined }] };
    }
}

/** Whether the loader script arrives. Off for most of this file: the failure
 *  is what the cases below are about. */
let scriptArrives = false;

/** How many frames the model was asked to segment, and whether the frame driver
 *  had been started when it was. */
let sends = 0;
let workers = 0;

class FakeSegmenter {
    setOptions(): void {}
    onResults(): void {}
    async initialize(): Promise<void> {}
    async send(): Promise<void> {
        sends += 1;
    }
    async close(): Promise<void> {}
}

/** The loader script. It fails to arrive unless a case says otherwise - a
 *  deployment whose assets were never staged, or a tab with no connection. */
class FakeScript {
    src = "";
    async = false;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
}

vi.stubGlobal("MediaStream", class {});
vi.stubGlobal("Image", class {});
vi.stubGlobal("document", {
    createElement: (tag: string) => {
        made.push(tag);
        if (tag === "video") return new FakeVideo();
        if (tag === "canvas") return new FakeCanvas();
        return new FakeScript();
    },
    head: {
        append: (node: FakeScript) => {
            queueMicrotask(() => {
                if (!scriptArrives) {
                    node.onerror?.();
                    return;
                }
                (window as unknown as { SelfieSegmentation?: unknown }).SelfieSegmentation =
                    FakeSegmenter;
                node.onload?.();
            });
        }
    }
});
vi.stubGlobal(
    "Worker",
    class {
        onmessage: ((event: unknown) => void) | null = null;
        constructor() {
            workers += 1;
        }
        postMessage(): void {}
        terminate(): void {}
    }
);
// Only the one method, never the constructor: the loader that brings this file
// in builds URLs of its own, and a stub in its place fails the import.
(globalThis.URL as unknown as { createObjectURL: () => string }).createObjectURL = () =>
    "blob:ticker";
vi.stubGlobal("window", {
    localStorage: {
        getItem: () => null,
        setItem: () => undefined,
        removeItem: () => undefined
    },
    dispatchEvent: () => true
});

const { maskCamera } = await import("@/app/(app)/chat/camera-filter");

const track = {
    readyState: "live",
    enabled: true,
    getSettings: () => ({ frameRate: 30 })
} as unknown as MediaStreamTrack;

describe("a background nobody asked for", () => {
    it("costs nothing at all", async () => {
        made.length = 0;
        expect(await maskCamera(track, "off")).toBeNull();
        // Not an element, not a script tag, and above all not six megabytes of
        // model: "off" is the default, so this is every call in the deployment.
        expect(made).toHaveLength(0);
    });
});

describe("a picture that was never chosen", () => {
    it("is not a background, and nothing is built for it", async () => {
        made.length = 0;
        expect(await maskCamera(track, "image", null)).toBeNull();
        expect(made).toHaveLength(0);
    });
});

describe("a model that will not load", () => {
    it("says so instead of coming back as a bare null", async () => {
        const built = await maskCamera(track, "blur");
        // Not null: null means "nothing was asked for", and something was. The
        // difference is the whole of what a screen can tell somebody.
        expect(built).not.toBeNull();
        expect(built?.track).toBeNull();
        expect(built?.using).toBe("blur");
        expect(built?.problem).toBeTruthy();
    });

    it("is tried again next time rather than remembered as broken", async () => {
        made.length = 0;
        const again = await maskCamera(track, "strong");
        expect(again?.problem).toBeTruthy();
        // A second script tag is the evidence: a cached failure would have
        // answered from the first one, and a deployment that staged its assets
        // a minute later would stay broken until the tab was reloaded.
        expect(made).toContain("script");
    });
});

/**
 * Last on purpose.
 *
 * A loader that succeeds is remembered for the life of the page - that is what
 * stops a second background re-fetching six megabytes - so a case that lets it
 * succeed makes every case after it succeed too. The failures above have to run
 * against a loader that has never worked.
 */
describe("starting the model", () => {
    it("has already segmented a frame by the time it hands the track back", async () => {
        scriptArrives = true;
        sends = 0;
        workers = 0;
        try {
            const built = await maskCamera(track, "blur");
            expect(built?.track).not.toBeNull();
            // Exactly one, and it happened before this resolved. The frame
            // driver is a fake that never ticks, so a second one could only
            // have come from the loop - which means this one did not.
            expect(sends).toBe(1);
            expect(workers).toBe(1);
        } finally {
            scriptArrives = false;
            delete (window as unknown as { SelfieSegmentation?: unknown }).SelfieSegmentation;
        }
    });
});
