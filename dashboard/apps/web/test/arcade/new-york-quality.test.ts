/**
 * The graphics levels: what Auto picks from the chip the browser reports, and
 * that every level costs at least as much as the one below it.
 */

import { describe, expect, it } from "vitest";

import * as quality from "../../../arcade/game/new-york/engine/quality.js";

const webgpu = (adapterInfo?: object) => ({ backend: { isWebGPUBackend: true, device: { adapterInfo, limits: { maxTextureDimension2D: 16384 } } } });

describe("gpuQuality", () => {
    it("sends software rasterizers to low", () => {
        expect(quality.gpuQuality("Google SwiftShader")).toBe("low");
        expect(quality.gpuQuality("llvmpipe (LLVM 15.0.7, 256 bits)")).toBe("low");
        expect(quality.gpuQuality("Microsoft Basic Render Driver")).toBe("low");
    });

    it("sends integrated chips to medium", () => {
        expect(quality.gpuQuality("ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11)")).toBe("medium");
        expect(quality.gpuQuality("intel gen-12lp Iris Xe")).toBe("medium");
        expect(quality.gpuQuality("AMD Radeon(TM) Graphics")).toBe("medium");
        expect(quality.gpuQuality("Adreno (TM) 740")).toBe("medium");
    });

    it("lets only the top discrete cards start at ultra", () => {
        expect(quality.gpuQuality("NVIDIA GeForce RTX 4080")).toBe("ultra");
        expect(quality.gpuQuality("AMD Radeon RX 7900 XTX")).toBe("ultra");
        expect(quality.gpuQuality("NVIDIA GeForce RTX 3050")).toBeNull();
        expect(quality.gpuQuality("Intel(R) Arc(TM) A770 Graphics")).toBeNull();
    });

    it("says nothing about an unknown or hidden name", () => {
        expect(quality.gpuQuality("")).toBeNull();
        expect(quality.gpuQuality(undefined)).toBeNull();
        expect(quality.gpuQuality("NVIDIA GeForce GTX 1060")).toBeNull();
    });
});

describe("deviceQuality", () => {
    it("reads the WebGPU adapter's name", () => {
        expect(quality.deviceQuality(webgpu({ vendor: "intel", description: "Intel(R) UHD Graphics 770" }))).toBe("medium");
        expect(quality.deviceQuality(webgpu({ vendor: "nvidia", description: "NVIDIA GeForce RTX 4090" }))).toBe("ultra");
    });

    it("keeps a capable desktop with an unknown chip at high", () => {
        expect(quality.deviceQuality(webgpu({ vendor: "nvidia", description: "GeForce GTX 1080" }))).toBe("high");
        expect(quality.deviceQuality(webgpu())).toBe("high");
    });

    it("keeps the WebGL fallback and software rendering at low", () => {
        expect(quality.deviceQuality({ backend: { isWebGPUBackend: false } }, "NVIDIA GeForce RTX 4090")).toBe("low");
        expect(quality.deviceQuality(webgpu(), "Google SwiftShader")).toBe("low");
    });
});

describe("PRESETS", () => {
    it("offers four levels, each costing at least as much as the one below", () => {
        expect(quality.LEVELS).toEqual(["low", "medium", "high", "ultra"]);
        const costs = quality.LEVELS.map((level: string) => {
            const p = quality.PRESETS[level];
            return [p.resolutionScale, p.shadowMapSize, p.shafts, Number(p.ao), Number(p.softShadows), Number(p.motionBlur), p.rain];
        });
        for (let i = 1; i < costs.length; i++) costs[i].forEach((value: number, k: number) => expect(value).toBeGreaterThanOrEqual(costs[i - 1][k]));
    });

    it("keeps the integrated-GPU level free of the costliest passes", () => {
        expect(quality.PRESETS.medium).toMatchObject({ ao: false, reflections: false, motionBlur: false, softShadows: false });
        expect(quality.PRESETS.medium.resolutionScale).toBeLessThanOrEqual(1);
    });
});
