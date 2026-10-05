/**
 * The camera's light, colour and framing.
 *
 * Two halves. The arithmetic - what filter a look becomes, how much a dark frame
 * is lifted, where a person is in a mask, how the crop follows them - is pure
 * and checked directly. The wiring is checked against a pretend browser: a look
 * on its own builds a canvas without fetching the six-megabyte model, framing
 * needs the model and says so when it is missing, and a plain look with no
 * background builds nothing at all. No camera is opened anywhere in this file.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const store = new Map<string, string>();

/** Every 2D context the pretend browser hands out, with what was drawn on it. */
const contexts: FakeContext[] = [];
const appended: FakeScript[] = [];
const workers: FakeWorker[] = [];

interface FakeScript {
    src: string;
    onload: (() => void) | null;
    onerror: (() => void) | null;
}

class FakeContext {
    public filter = "none";
    public globalCompositeOperation = "source-over";
    public readonly filters: string[] = [];
    public readonly draws: unknown[][] = [];
    public drawImage(...args: unknown[]): void {
        this.filters.push(this.filter);
        this.draws.push(args);
    }
    public getImageData(_x: number, _y: number, width: number, height: number) {
        // A dark, even frame: luminance about 0.16.
        return { data: new Uint8ClampedArray(width * height * 4).fill(40) };
    }
}

class FakeWorker {
    public onmessage: (() => void) | null = null;
    public readonly sent: unknown[] = [];
    public constructor() {
        workers.push(this);
    }
    public postMessage(value: unknown): void {
        this.sent.push(value);
    }
    public terminate(): void {}
}

const sentTrack = { stop: vi.fn() };

function element(tag: string): unknown {
    if (tag === "canvas") {
        return {
            width: 0,
            height: 0,
            getContext: () => {
                const context = new FakeContext();
                contexts.push(context);
                return context;
            },
            captureStream: () => ({ getVideoTracks: () => [sentTrack] })
        };
    }
    if (tag === "video") {
        return {
            readyState: 4,
            videoWidth: 640,
            videoHeight: 360,
            srcObject: null,
            play: async () => undefined
        };
    }
    if (tag === "script") {
        const script: FakeScript = { src: "", onload: null, onerror: null };
        return script;
    }
    throw new Error(`unexpected element ${tag}`);
}

vi.stubGlobal("window", {
    localStorage: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => void store.set(key, value),
        removeItem: (key: string) => void store.delete(key)
    },
    dispatchEvent: () => true
});
vi.stubGlobal("document", {
    createElement: element,
    head: {
        append: (script: FakeScript) => {
            appended.push(script);
            // The model is not on this pretend server.
            queueMicrotask(() => script.onerror?.());
        }
    }
});
vi.stubGlobal("Worker", FakeWorker);
vi.stubGlobal(
    "MediaStream",
    class {
        public constructor(public readonly tracks: unknown[]) {}
    }
);
vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:ticker");

const look = await import("@/app/(app)/chat/camera-look");
const { maskCamera } = await import("@/app/(app)/chat/camera-filter");

function cameraTrack(): MediaStreamTrack {
    return {
        readyState: "live",
        enabled: true,
        getSettings: () => ({ frameRate: 30 })
    } as unknown as MediaStreamTrack;
}

beforeEach(() => {
    store.clear();
    contexts.length = 0;
    appended.length = 0;
    workers.length = 0;
});

describe("what a browser remembers about the look", () => {
    it("is the plain picture until somebody changes it", () => {
        expect(look.cameraLook()).toEqual(look.LOOK_DEFAULT);
    });

    it("keeps what was chosen, and forgets it when it is plain again", () => {
        look.setCameraLook({ light: "auto", style: "warm", frame: "off" });
        expect(look.cameraLook()).toEqual({ light: "auto", style: "warm", frame: "off" });
        look.setCameraLook(look.LOOK_DEFAULT);
        expect(store.size).toBe(0);
    });

    it("believes nothing it did not write, field by field", () => {
        store.set(
            "polaris.call.camera-look",
            JSON.stringify({ light: "laser", style: "mono", frame: 7 })
        );
        expect(look.cameraLook()).toEqual({ light: "off", style: "mono", frame: "off" });
        store.set("polaris.call.camera-look", "{not json");
        expect(look.cameraLook()).toEqual(look.LOOK_DEFAULT);
    });
});

describe("the filter a look becomes", () => {
    it("is nothing for the plain picture", () => {
        expect(look.lookFilter(look.LOOK_DEFAULT)).toBe("none");
    });

    it("puts the light before the colour", () => {
        const filter = look.lookFilter({ light: "bright", style: "mono", frame: "off" });
        expect(filter.indexOf("brightness")).toBeLessThan(filter.indexOf("grayscale"));
    });

    it("lifts only by the gain auto light has measured", () => {
        const auto = { light: "auto", style: "none", frame: "off" } as const;
        expect(look.lookFilter(auto, 1)).toBe("none");
        expect(look.lookFilter(auto, 1.5)).toBe("brightness(1.5) contrast(1.08)");
    });
});

describe("auto light", () => {
    it("leaves a well-lit picture alone and lifts a dark one, within limits", () => {
        expect(look.autoGain(0.5)).toBe(1);
        expect(look.autoGain(0.3)).toBeCloseTo(1.5);
        expect(look.autoGain(0.05)).toBe(1.7);
        expect(look.autoGain(0)).toBe(1);
    });

    it("measures luminance from RGBA", () => {
        expect(look.meanLuma([255, 255, 255, 255, 0, 0, 0, 255])).toBeCloseTo(0.5);
    });
});

describe("auto framing", () => {
    /** A mask of `width` x `height` with a person filling the given cells. */
    function mask(
        width: number,
        height: number,
        fill: (x: number, y: number) => boolean
    ): Uint8ClampedArray {
        const pixels = new Uint8ClampedArray(width * height * 4);
        for (let y = 0; y < height; y += 1) {
            for (let x = 0; x < width; x += 1) {
                if (fill(x, y)) pixels[(y * width + x) * 4 + 3] = 255;
            }
        }
        return pixels;
    }

    it("finds the person in a mask's alpha", () => {
        const box = look.personBox(
            mask(10, 10, (x, y) => x >= 6 && y >= 3),
            10,
            10
        );
        expect(box).toEqual({ x: 0.6, y: 0.3, w: 0.4, h: 0.7 });
    });

    it("finds nobody in an empty room", () => {
        expect(
            look.personBox(
                mask(10, 10, () => false),
                10,
                10
            )
        ).toBeNull();
        expect(look.frameFor(null)).toEqual(look.WHOLE_FRAME);
    });

    it("crops in on somebody small and off to the side, inside the frame", () => {
        const crop = look.frameFor({ x: 0.7, y: 0.4, w: 0.15, h: 0.3 });
        expect(crop.w).toBeCloseTo(1 / 1.6);
        expect(crop.x + crop.w).toBeLessThanOrEqual(1);
        expect(crop.x).toBeGreaterThan(0.3);
        expect(crop.y + crop.h).toBeLessThanOrEqual(1);
    });

    it("never zooms past what fits the person", () => {
        expect(look.frameFor({ x: 0.1, y: 0.1, w: 0.8, h: 0.9 }).w).toBe(1);
    });

    it("eases towards the crop and holds still inside the dead zone", () => {
        const wanted = { x: 0.3, y: 0.2, w: 0.6, h: 0.6 };
        const moved = look.followFrame(look.WHOLE_FRAME, wanted);
        expect(moved.w).toBeLessThan(1);
        expect(moved.w).toBeGreaterThan(0.9);
        const near = { x: 0.31, y: 0.21, w: 0.61, h: 0.61 };
        expect(look.followFrame(near, wanted)).toBe(near);
    });
});

describe("the camera pipeline", () => {
    it("builds nothing for a plain look and no background", async () => {
        expect(await maskCamera(cameraTrack(), "off", null, look.LOOK_DEFAULT)).toBeNull();
    });

    it("applies light and colour without fetching the model", async () => {
        const built = await maskCamera(cameraTrack(), "off", null, {
            light: "bright",
            style: "warm",
            frame: "off"
        });
        expect(built?.track).toBe(sentTrack);
        expect(built?.using).toBe("off");
        expect(appended).toHaveLength(0);

        workers[0]?.onmessage?.();
        await vi.waitFor(() => expect(contexts[0]?.draws.length).toBeGreaterThan(0));
        const sent = contexts[0];
        expect(sent?.filters[0]).toBe(
            look.lookFilter({ light: "bright", style: "warm", frame: "off" })
        );
        // The whole frame, drawn at the canvas's size.
        expect(sent?.draws[0]?.slice(1)).toEqual([0, 0, 640, 360, 0, 0, 640, 360]);
        await built?.stop();
    });

    it("lifts a dark picture under auto light", async () => {
        const built = await maskCamera(cameraTrack(), "off", null, {
            light: "auto",
            style: "none",
            frame: "off"
        });
        workers[0]?.onmessage?.();
        await vi.waitFor(() => expect(contexts[0]?.draws.length).toBeGreaterThan(0));
        expect(contexts[0]?.filters[0]).toMatch(/^brightness\(1\.\d+\)/);
        await built?.stop();
    });

    it("needs the model for framing, and says so when it is missing", async () => {
        const built = await maskCamera(cameraTrack(), "off", null, {
            light: "off",
            style: "none",
            frame: "auto"
        });
        expect(appended).toHaveLength(1);
        expect(built?.track).toBeNull();
        expect(built?.problem).toMatch(/background model is not on this server/);
    });
});
