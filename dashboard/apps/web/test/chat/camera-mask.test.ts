/**
 * The numbers behind a camera background: how the mask is smoothed over time,
 * how the edge and the blur are set for each background, which way frames go
 * in a given browser, and how a picture covers a frame of another shape.
 *
 * These are the decisions that the GPU code only carries out, and the ones a
 * change is most likely to get subtly wrong: a smoothing weight that is too
 * low is a hand that leaves a ghost when it moves, a frame path chosen wrong is
 * a camera that freezes the moment its tab is hidden.
 */

import { describe, expect, it } from "vitest";
import { BLUR_PIXELS } from "@/app/(app)/chat/camera-background";
import * as mask from "@/app/(app)/chat/camera-mask";

describe("smoothing the mask over time", () => {
    it("mostly ignores a small change, which is the model's noise", () => {
        expect(mask.blendWeight(0)).toBeCloseTo(mask.TEMPORAL.still, 6);
        expect(mask.blendWeight(mask.TEMPORAL.low / 2)).toBeCloseTo(mask.TEMPORAL.still, 6);
        // A flicker of 0.05 on a still shoulder moves it by a fraction of that.
        expect(Math.abs(mask.smoothMaskValue(0.9, 0.85) - 0.9)).toBeLessThan(0.03);
    });

    it("takes a large change at once, which is movement", () => {
        expect(mask.blendWeight(mask.TEMPORAL.high)).toBeCloseTo(1, 6);
        expect(mask.blendWeight(-1)).toBeCloseTo(1, 6);
        // A hand moved out of a pixel leaves no ghost behind it.
        expect(mask.smoothMaskValue(1, 0)).toBeCloseTo(0, 6);
        expect(mask.smoothMaskValue(0, 1)).toBeCloseTo(1, 6);
    });

    it("never weighs a bigger change less than a smaller one", () => {
        let before = 0;
        for (let delta = 0; delta <= 1; delta += 0.01) {
            const weight = mask.blendWeight(delta);
            expect(weight).toBeGreaterThanOrEqual(before - 1e-12);
            expect(weight).toBeGreaterThanOrEqual(mask.TEMPORAL.still);
            expect(weight).toBeLessThanOrEqual(1);
            before = weight;
        }
    });

    it("settles on a still answer instead of drifting", () => {
        let value = 0;
        for (let frame = 0; frame < 30; frame += 1) value = mask.smoothMaskValue(value, 0.04);
        expect(value).toBeCloseTo(0.04, 3);
    });
});

describe("compositing parameters", () => {
    it("blurs harder for strong than for blur, within what the shader can loop", () => {
        const blur = mask.compositeParams("blur", BLUR_PIXELS.blur);
        const strong = mask.compositeParams("strong", BLUR_PIXELS.strong);
        expect(strong.sigma).toBeGreaterThan(blur.sigma);
        for (const params of [blur, strong]) {
            expect(params.radius).toBeGreaterThan(0);
            expect(params.radius).toBeLessThanOrEqual(mask.MAX_BLUR_RADIUS);
            // The blur strength the settings name is in full-size pixels.
            expect(params.sigma * mask.BLUR_DOWNSCALE).toBeCloseTo(
                params === blur ? BLUR_PIXELS.blur : BLUR_PIXELS.strong,
                6
            );
        }
    });

    it("cuts a picture out with a crisper edge than a blur", () => {
        const picture = mask.compositeParams("image", 0);
        const blur = mask.compositeParams("blur", BLUR_PIXELS.blur);
        expect(picture.sigma).toBe(0);
        expect(picture.edge[1] - picture.edge[0]).toBeLessThan(blur.edge[1] - blur.edge[0]);
        for (const params of [picture, blur]) {
            expect(params.edge[0]).toBeLessThan(params.edge[1]);
            expect(params.edge[0]).toBeGreaterThan(0);
            expect(params.edge[1]).toBeLessThan(1);
            expect(params.wrap).toBeGreaterThanOrEqual(0);
            expect(params.wrap).toBeLessThan(0.5);
        }
    });

    it("refines the edge at no more than its cap, keeping the frame's shape", () => {
        expect(mask.refineSize(320, 180)).toEqual({ width: 320, height: 180 });
        const big = mask.refineSize(1920, 1080);
        expect(Math.max(big.width, big.height)).toBe(mask.REFINE.maxSide);
        expect(big.width / big.height).toBeCloseTo(16 / 9, 2);
        expect(mask.refineSize(0, 0)).toEqual({ width: 1, height: 1 });
    });

    it("blurs at a quarter size, never at zero", () => {
        expect(mask.blurSize(1280, 720)).toEqual({ width: 320, height: 180 });
        expect(mask.blurSize(2, 2)).toEqual({ width: 1, height: 1 });
    });
});

describe("which way frames go", () => {
    const none = { processor: false, generator: false, videoFrame: false, captureStream: false };

    it("prefers insertable streams, which no hidden tab throttles", () => {
        expect(
            mask.framePath({ processor: true, generator: true, videoFrame: true, captureStream: true })
        ).toBe("insertable");
    });

    it("falls back to a captured canvas when any piece is missing", () => {
        // Safari and Firefox: a processor in workers at most, no generator.
        expect(mask.framePath({ ...none, processor: true, videoFrame: true, captureStream: true })).toBe(
            "canvas"
        );
        expect(mask.framePath({ ...none, captureStream: true })).toBe("canvas");
    });

    it("has no way at all without either", () => {
        expect(mask.framePath(none)).toBeNull();
    });

    it("reads support from a global scope", () => {
        class Canvas {
            captureStream(): void {}
        }
        expect(mask.frameSupport({ HTMLCanvasElement: Canvas })).toEqual({ ...none, captureStream: true });
        expect(
            mask.frameSupport({
                MediaStreamTrackProcessor: class {},
                MediaStreamTrackGenerator: class {},
                VideoFrame: class {}
            })
        ).toEqual({ processor: true, generator: true, videoFrame: true, captureStream: false });
    });

    it("holds the rate a model can keep up with", () => {
        expect(mask.targetFps(60)).toBe(30);
        expect(mask.targetFps(5)).toBe(15);
        expect(mask.targetFps(undefined)).toBe(30);
        expect(mask.targetFps(24)).toBe(24);
    });

    it("halves a 60 fps camera, and leaves a 30 fps one alone despite jitter", () => {
        expect(mask.dropFrame(1000 / 60, 30)).toBe(true);
        expect(mask.dropFrame(1000 / 30 - 4, 30)).toBe(false);
        expect(mask.dropFrame(Infinity, 30)).toBe(false);
    });
});

describe("the files a background asks for", () => {
    it("are both runtime builds and the model", () => {
        expect(mask.wasmFiles(true)).toEqual({
            loader: "vision_wasm_internal.js",
            binary: "vision_wasm_internal.wasm"
        });
        expect(mask.wasmFiles(false).binary).toBe("vision_wasm_nosimd_internal.wasm");
        expect(mask.VIDEO_ASSETS).toContain(mask.MODEL_FILE);
        expect(new Set(mask.VIDEO_ASSETS).size).toBe(5);
    });
});

describe("a background picture behind a camera of another shape", () => {
    // The stored picture is 16:9. Drawn over the frame's own size it was
    // squashed behind a 4:3 webcam and an upright phone.
    it("keeps the picture's shape and covers the frame", () => {
        for (const [width, height] of [
            [640, 480],
            [1280, 720],
            [720, 1280]
        ] as const) {
            const at = mask.coverRect(1280, 720, width, height);
            expect(at.width / at.height).toBeCloseTo(1280 / 720, 6);
            expect(at.width).toBeGreaterThanOrEqual(width - 1e-6);
            expect(at.height).toBeGreaterThanOrEqual(height - 1e-6);
            // Centred, so the excess falls off both edges equally.
            expect(at.x * 2 + at.width).toBeCloseTo(width, 6);
            expect(at.y * 2 + at.height).toBeCloseTo(height, 6);
        }
    });

    it("draws over the frame while the picture has no size yet", () => {
        expect(mask.coverRect(0, 0, 640, 480)).toEqual({ x: 0, y: 0, width: 640, height: 480 });
    });

    it("maps the frame's corners inside the picture, centred", () => {
        // A 4:3 webcam over a 16:9 picture: the sides of the picture fall off.
        const [sx, sy, ox, oy] = mask.coverUv(1280, 720, 640, 480);
        const left = ox;
        const right = sx + ox;
        expect(left).toBeGreaterThan(0);
        expect(right).toBeLessThan(1);
        expect(left + right).toBeCloseTo(1, 6);
        expect(oy).toBeCloseTo(0, 6);
        expect(sy).toBeCloseTo(1, 6);
        expect(mask.coverUv(0, 0, 640, 480)).toEqual([1, 1, -0, -0]);
    });
});
