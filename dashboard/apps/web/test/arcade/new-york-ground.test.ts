// @vitest-environment jsdom

/**
 * Every tree in New York stands on the ground drawn under it.
 *
 * The city is built the way the page builds it (city grid, boroughs,
 * landmarks, blocks, street details) from the shipped data, the tree sites are
 * taken from where the tree field is handed them, and each site's base is
 * compared with the highest upward-facing surface actually drawn under its
 * trunk. A tree whose base is above that surface is hovering, which is what an
 * operator saw along Central Park South and Fifth Avenue.
 */

import { gzipSync } from "node:zlib";
import { readFileSync, writeFileSync } from "node:fs";
import { URL as FileUrl, fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

const data = fileURLToPath(new FileUrl("../../../arcade/game/new-york/data/", import.meta.url));

type Site = { x: number; y: number; z: number };
const captured = vi.hoisted(() => ({ sites: [] as Site[] }));

vi.mock("../../../arcade/game/new-york/engine/trees.js", async () => {
    const THREE = await import("../../../arcade/node_modules/three/build/three.webgpu.js");
    return {
        createTreeField: (_scene: unknown, sites: Site[]) => {
            captured.sites = sites;
            return { group: new THREE.Group(), sites: new Set(sites), stats: { trees: sites.length } };
        }
    };
});

/** The files the page names in its `<meta>` tags, served from the source data. */
function serveData() {
    const files: Record<string, () => Uint8Array> = {
        geo: () => gzipSync(readFileSync(`${data}geo.bin`)),
        buildings: () => readFileSync(`${data}buildings.bin.gz`),
        trees: () => readFileSync(`${data}trees.bin.gz`)
    };
    for (const name of Object.keys(files)) {
        const meta = document.createElement("meta");
        meta.name = name;
        meta.content = name;
        document.head.append(meta);
    }
    // Textures are painted on 2D canvases jsdom does not draw: a context that takes every call is all the build needs
    const pixels = (w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) });
    const context: object = new Proxy(() => context, {
        get: (_target, key) => {
            if (key === "getImageData") return (_x: number, _y: number, w: number, h: number) => pixels(w, h);
            if (key === "createImageData") return (w: number, h: number) => pixels(w, h);
            if (key === "measureText") return () => ({ width: 10 });
            return context;
        },
        apply: () => context,
        set: () => true
    });
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context as never);
    vi.stubGlobal("fetch", async (name: string) => new Response(files[name]()));
}

const CELL = 8;
const LARGE = 64;

type Triangle = [number, number, number, number, number, number, number, number, number];

/** The highest upward-facing drawn surface under (x, z) no higher than `ceiling`. */
function groundIndex(triangles: Triangle[]) {
    const cells = new Map<string, Triangle[]>();
    const large: Triangle[] = [];
    for (const t of triangles) {
        const x0 = Math.floor(Math.min(t[0], t[3], t[6]) / CELL), x1 = Math.floor(Math.max(t[0], t[3], t[6]) / CELL);
        const z0 = Math.floor(Math.min(t[2], t[5], t[8]) / CELL), z1 = Math.floor(Math.max(t[2], t[5], t[8]) / CELL);
        if ((x1 - x0 + 1) * (z1 - z0 + 1) > LARGE) { large.push(t); continue; }
        for (let i = x0; i <= x1; i++) for (let j = z0; j <= z1; j++) {
            const key = `${i},${j}`;
            const list = cells.get(key);
            if (list) list.push(t); else cells.set(key, [t]);
        }
    }
    const heightOn = (t: Triangle, x: number, z: number) => {
        const d = (t[5] - t[8]) * (t[0] - t[6]) + (t[6] - t[3]) * (t[2] - t[8]);
        if (Math.abs(d) < 1e-9) return null;
        const a = ((t[5] - t[8]) * (x - t[6]) + (t[6] - t[3]) * (z - t[8])) / d;
        const b = ((t[8] - t[2]) * (x - t[6]) + (t[0] - t[6]) * (z - t[8])) / d;
        const c = 1 - a - b;
        if (a < -1e-6 || b < -1e-6 || c < -1e-6) return null;
        return a * t[1] + b * t[4] + c * t[7];
    };
    return (x: number, z: number, ceiling: number) => {
        let best = -Infinity;
        const near = cells.get(`${Math.floor(x / CELL)},${Math.floor(z / CELL)}`) ?? [];
        for (const list of [near, large]) for (const t of list) {
            const h = heightOn(t, x, z);
            if (h !== null && h <= ceiling && h > best) best = h;
        }
        return best;
    };
}

async function buildCity() {
    serveData();
    const THREE = await import("../../../arcade/node_modules/three/build/three.webgpu.js");
    const { buildCityGrid } = await import("../../../arcade/game/new-york/engine/city-grid.js");
    const { buildBoroughs } = await import("../../../arcade/game/new-york/engine/boroughs.js");
    const { buildLandmarks } = await import("../../../arcade/game/new-york/engine/landmarks.js");
    const { buildCityBlocks } = await import("../../../arcade/game/new-york/engine/buildings.js");
    const { buildStreetDetails } = await import("../../../arcade/game/new-york/engine/street-details.js");
    const scene = new THREE.Scene();
    const grid = buildCityGrid(scene);
    const boroughs = buildBoroughs(scene, { sidewalks: grid.sidewalks });
    const { colliders } = buildLandmarks(scene);
    const blocks = buildCityBlocks(scene, colliders);
    buildStreetDetails(scene, [...colliders, ...blocks.colliders, ...boroughs.colliders, ...(grid.colliders || [])]);
    scene.updateMatrixWorld(true);

    const triangles: Triangle[] = [];
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
    const n = new THREE.Vector3(), e1 = new THREE.Vector3(), e2 = new THREE.Vector3();
    const world = new THREE.Matrix4(), instance = new THREE.Matrix4();
    scene.traverseVisible((object: InstanceType<typeof THREE.Object3D>) => {
        const mesh = object as InstanceType<typeof THREE.Mesh>;
        if (!mesh.isMesh || !mesh.geometry?.attributes?.position) return;
        const position = mesh.geometry.attributes.position;
        const index = mesh.geometry.index;
        const count = index ? index.count : position.count;
        const instanced = (mesh as InstanceType<typeof THREE.InstancedMesh>).isInstancedMesh
            ? (mesh as InstanceType<typeof THREE.InstancedMesh>) : null;
        for (let k = 0; k < (instanced ? instanced.count : 1); k++) {
            world.copy(mesh.matrixWorld);
            if (instanced) world.multiply(instanced.getMatrixAt(k, instance) ?? instance);
            for (let i = 0; i + 2 < count; i += 3) {
                const at = (j: number) => (index ? index.getX(i + j) : i + j);
                a.fromBufferAttribute(position, at(0)).applyMatrix4(world);
                b.fromBufferAttribute(position, at(1)).applyMatrix4(world);
                c.fromBufferAttribute(position, at(2)).applyMatrix4(world);
                n.crossVectors(e1.subVectors(b, a), e2.subVectors(c, a));
                const length = n.length();
                if (length < 1e-9 || Math.abs(n.y / length) < 0.5) continue;
                triangles.push([a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z]);
            }
        }
    });
    return { sites: captured.sites, ground: groundIndex(triangles) };
}

/** How far each tree's base sits above the surface drawn under it (sunk up to 0.6 m into a bed counts as on it). */
function hovering(sites: Site[], ground: (x: number, z: number, ceiling: number) => number) {
    return sites
        .map((s) => ({ ...s, gap: s.y - ground(s.x, s.z, s.y + 0.6) }))
        .filter((s) => s.gap > 0.05);
}

describe("New York trees", () => {
    it("stand on the ground drawn under them, across the whole city", async () => {
        const { sites, ground } = await buildCity();
        const floating = hovering(sites, ground);
        const sample = floating.slice(0, 12).map((s) => `(${s.x.toFixed(1)}, ${s.y.toFixed(2)}, ${s.z.toFixed(1)} +${s.gap.toFixed(2)})`);
        console.info(`[new-york-ground] ${floating.length} of ${sites.length} trees hovering ${sample.join(" ")}`);
        // The full list, for a sweep run by hand: NEW_YORK_GROUND_DUMP=<file> npx vitest run <this file>
        if (process.env.NEW_YORK_GROUND_DUMP) writeFileSync(process.env.NEW_YORK_GROUND_DUMP, JSON.stringify(floating));
        expect(sites.length).toBeGreaterThan(1000);
        // Central Park South, Fifth Avenue and Grand Army Plaza, where an operator saw them hovering: none at all
        expect(floating.filter((s) => s.x > -900 && s.x < 40 && s.z > -1500 && s.z < -1250)).toEqual([]);
        // The rest of the city, ratcheted: 404 before the fix. What remains is the river-belt lawn at a few pier cuts
        // and three bed trees 15 cm up; the count may only go down
        expect(floating.length).toBeLessThanOrEqual(34);
    }, 600_000);
});
