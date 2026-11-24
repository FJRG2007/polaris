/**
 * Which copy of a picture each tile asks the media server for (BUG-0036).
 */

import { describe, expect, it, vi } from "vitest";
import * as layer from "@/app/(app)/chat/call-layer";

describe("what one tile asks for", () => {
    it("asks for the top copy of the picture somebody is looking at", () => {
        expect(layer.layerWant({ screen: true, focused: true, width: 300, height: 200, density: 1 })).toEqual({
            top: true
        });
        expect(layer.layerWant({ screen: false, focused: true, width: 100, height: 100, density: 1 })).toEqual({
            top: true
        });
    });

    it("asks for a face at the size it is drawn, in device pixels", () => {
        expect(layer.layerWant({ screen: false, focused: false, width: 160, height: 90, density: 2 })).toEqual({
            width: 320,
            height: 180
        });
    });

    it("never asks for a shared screen below 720p, however small its tile", () => {
        expect(layer.layerWant({ screen: true, focused: false, width: 960, height: 540, density: 1 })).toEqual({
            width: 1280,
            height: 720
        });
        expect(layer.layerWant({ screen: true, focused: false, width: 1600, height: 900, density: 1 })).toEqual({
            width: 1600,
            height: 900
        });
    });

    it("says nothing for a tile that is not laid out", () => {
        expect(layer.layerWant({ screen: false, focused: false, width: 0, height: 0, density: 1 })).toBeNull();
    });
});

describe("a track shown in several tiles", () => {
    it("takes the top copy if any tile wants it, else the largest size", () => {
        expect(layer.combineWants([{ width: 320, height: 180 }, { top: true }])).toEqual({ top: true });
        expect(
            layer.combineWants([
                { width: 320, height: 180 },
                { width: 1280, height: 720 }
            ])
        ).toEqual({ width: 1280, height: 720 });
        expect(layer.combineWants([])).toBeNull();
    });

    it("reaches the publication once it is subscribed, and only when the ask changes", () => {
        const sink = vi.fn();
        const small = Symbol("small");
        const big = Symbol("big");
        layer.setLayerWant("track-a", small, { width: 320, height: 180 });
        layer.bindLayerSink("track-a", sink);
        expect(sink).toHaveBeenLastCalledWith({ width: 320, height: 180 });
        layer.setLayerWant("track-a", small, { width: 320, height: 180 });
        expect(sink).toHaveBeenCalledTimes(1);
        layer.setLayerWant("track-a", big, { top: true });
        expect(sink).toHaveBeenLastCalledWith({ top: true });
        layer.setLayerWant("track-a", big, null);
        expect(sink).toHaveBeenLastCalledWith({ width: 320, height: 180 });
        layer.bindLayerSink("track-a", null);
        layer.setLayerWant("track-a", small, null);
    });
});
