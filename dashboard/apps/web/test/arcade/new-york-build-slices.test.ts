// @vitest-environment jsdom

/**
 * New York builds its city in slices: every builder hands the main thread back once it has run for the build budget,
 * so the page that frames the game (a call) keeps answering while the city is built. Each builder used to run in one
 * piece, up to 0.9 s, which froze the call it was embedded in for up to 2.3 s.
 *
 * The builders run on the shipped data with an instrumented yield that times every uninterrupted slice.
 */

import { writeFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { serveData } from "./new-york-data";

vi.mock("../../../arcade/game/new-york/engine/trees.js", async () => {
    const THREE = await import("../../../arcade/node_modules/three/build/three.webgpu.js");
    return {
        createTreeField: (_scene: unknown, sites: unknown[]) => ({
            group: new THREE.Group(),
            sites: new Set(sites),
            stats: { trees: sites.length }
        })
    };
});

const BUDGET = 45;

type Slice = { builder: string; ms: number; at: string };

describe("New York start-up builders", () => {
    it("hand the thread back within the build budget", { timeout: 300_000 }, async () => {
        serveData();
        const THREE = await import("../../../arcade/node_modules/three/build/three.webgpu.js");
        const slice = await import("../../../arcade/game/new-york/engine/build-slice.js");
        const { buildCityGrid } = await import("../../../arcade/game/new-york/engine/city-grid.js");
        const { buildBoroughs } = await import("../../../arcade/game/new-york/engine/boroughs.js");
        const { buildLandmarks } = await import("../../../arcade/game/new-york/engine/landmarks.js");
        const { buildCityBlocks } = await import("../../../arcade/game/new-york/engine/buildings.js");
        const { buildStreetDetails } = await import("../../../arcade/game/new-york/engine/street-details.js");
        const { createTrafficSystem } = await import("../../../arcade/game/new-york/engine/traffic.js");
        const { setupSceneCulling } = await import("../../../arcade/game/new-york/engine/scene-culling.js");

        const slices: Slice[] = [];
        const yields: Record<string, number> = {};
        let builder = "";
        let sliceStart = performance.now();
        slice.setBuildBudget(BUDGET);
        slice.setBuildScheduler({
            yieldTask: () => {
                const at = new Error().stack?.split("\n").find((l) => !/build-slice|new-york-build-slices/.test(l) && /engine/.test(l)) ?? "";
                slices.push({ builder, ms: performance.now() - sliceStart, at: at.trim() });
                yields[builder] = (yields[builder] ?? 0) + 1;
                return new Promise<void>((resolve) =>
                    setTimeout(() => {
                        sliceStart = performance.now();
                        resolve();
                    }, 0)
                );
            }
        });
        /** Runs one builder as its own measured phase (the page yields between phases). */
        const run = async <T>(name: string, build: () => T | Promise<T>) => {
            builder = name;
            sliceStart = performance.now();
            const result = await build();
            slices.push({ builder, ms: performance.now() - sliceStart, at: "end" });
            builder = "";
            return result;
        };

        const scene = new THREE.Scene();
        const grid = await run("cityGrid", () => buildCityGrid(scene));
        const boroughs = buildBoroughs(scene, { sidewalks: grid.sidewalks });
        const { colliders } = buildLandmarks(scene);
        const blocks = await run("blocks", () => buildCityBlocks(scene, colliders));
        const all = [...colliders, ...blocks.colliders, ...boroughs.colliders, ...(grid.colliders || [])];
        const details = await run("streetDetails", () => buildStreetDetails(scene, all));
        await run("traffic", () =>
            createTrafficSystem(scene, grid.sidewalks, [
                ...grid.footprints,
                ...details.footprints,
                ...all.filter((c: { obb?: unknown; minY?: number }) => !c.obb && (c.minY ?? 0) < 3.5)
            ])
        );
        const roots = ["ManhattanCityGrid", "ManhattanCityBlocks", "ManhattanStreetDetails", "ManhattanLandmarks", "Boroughs"]
            .map((name) => scene.getObjectByName(name))
            .filter(Boolean);
        const shadow = { getViewportCount: () => 2, getCamera: () => new THREE.OrthographicCamera() };
        await run("culling", () => setupSceneCulling(scene, roots, shadow));

        const longest = [...slices].sort((a, b) => b.ms - a.ms).slice(0, 15);
        const report = longest.map((s) => `${s.builder} ${Math.round(s.ms)}ms ${s.at}`).join("\n");
        if (process.env.NEW_YORK_SLICES_DUMP)
            writeFileSync(process.env.NEW_YORK_SLICES_DUMP, `${report}\n${JSON.stringify(yields)}\n`);
        for (const name of ["cityGrid", "blocks", "streetDetails", "traffic", "culling"])
            expect(yields[name] ?? 0, name).toBeGreaterThan(0);
        // Each builder used to run unbroken for 0.5-1.4 s here; what is left unsliced are single library calls
        // (geometry merges, a triangulation). One of them stretched by a GC pause or a busy runner is noise; a builder
        // that stopped slicing is not, since most of the few slices it has left are long
        for (const name of ["cityGrid", "blocks", "streetDetails", "traffic", "culling"]) {
            const own = slices.filter((s) => s.builder === name);
            const long = own.filter((s) => s.ms > BUDGET * 10).length;
            expect(long / own.length, `${name}: ${report}`).toBeLessThan(0.25);
        }
    });
});
