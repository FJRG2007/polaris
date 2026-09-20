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

/** The loader script, which in every case here fails to arrive - a deployment
 *  whose assets were never staged, or a tab with no connection. */
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
            queueMicrotask(() => node.onerror?.());
        }
    }
});
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
