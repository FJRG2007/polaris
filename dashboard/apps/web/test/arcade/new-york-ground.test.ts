// @vitest-environment jsdom

/**
 * Every tree in New York stands on the ground drawn under it, and every street-name sign names the corner it stands at.
 *
 * The city is built the way the page builds it (city grid, boroughs,
 * landmarks, blocks, street details) from the shipped data, the tree sites are
 * taken from where the tree field is handed them, and each site's base is
 * compared with the highest upward-facing surface actually drawn under its
 * trunk. A tree whose base is above that surface is hovering, which is what an
 * operator saw along Central Park South and Fifth Avenue.
 *
 * The signs are read back from the blades as built (the atlas cell each half of a blade shows) and compared with the
 * avenue and street nearest the pole, worked out here from the street plan alone. Every blade used to read
 * "5TH AVE · 42 ST", which an operator saw at Fifth Avenue and 59th Street.
 */

import { writeFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { serveData } from "./new-york-data";

type Site = { x: number; y: number; z: number };
const captured = vi.hoisted(() => ({ sites: [] as Site[] }));

vi.mock("../../../arcade/game/new-york/engine/trees.js", async () => {
    const THREE = await import("../../../arcade/node_modules/three/build/three.webgpu.js");
    return {
        createTreeField: (_scene: unknown, sites: Site[]) => {
            captured.sites = sites;
            return {
                group: new THREE.Group(),
                sites: new Set(sites),
                stats: { trees: sites.length }
            };
        }
    };
});

const CELL = 8;
const LARGE = 64;

type Triangle = [number, number, number, number, number, number, number, number, number];

/** The highest upward-facing drawn surface under (x, z) no higher than `ceiling`. */
function groundIndex(triangles: Triangle[]) {
    const cells = new Map<string, Triangle[]>();
    const large: Triangle[] = [];
    for (const t of triangles) {
        const x0 = Math.floor(Math.min(t[0], t[3], t[6]) / CELL),
            x1 = Math.floor(Math.max(t[0], t[3], t[6]) / CELL);
        const z0 = Math.floor(Math.min(t[2], t[5], t[8]) / CELL),
            z1 = Math.floor(Math.max(t[2], t[5], t[8]) / CELL);
        if ((x1 - x0 + 1) * (z1 - z0 + 1) > LARGE) {
            large.push(t);
            continue;
        }
        for (let i = x0; i <= x1; i++)
            for (let j = z0; j <= z1; j++) {
                const key = `${i},${j}`;
                const list = cells.get(key);
                if (list) list.push(t);
                else cells.set(key, [t]);
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
        for (const list of [near, large])
            for (const t of list) {
                const h = heightOn(t, x, z);
                if (h !== null && h <= ceiling && h > best) best = h;
            }
        return best;
    };
}

let city: ReturnType<typeof buildCityOnce> | undefined;
/** The city is built once for every check in this file: it takes most of a minute. */
const buildCity = () => (city ??= buildCityOnce());

async function buildCityOnce() {
    serveData();
    const THREE = await import("../../../arcade/node_modules/three/build/three.webgpu.js");
    const { buildCityGrid } = await import("../../../arcade/game/new-york/engine/city-grid.js");
    const { buildBoroughs } = await import("../../../arcade/game/new-york/engine/boroughs.js");
    const { buildLandmarks } = await import("../../../arcade/game/new-york/engine/landmarks.js");
    const { buildCityBlocks } = await import("../../../arcade/game/new-york/engine/buildings.js");
    const { buildStreetDetails } =
        await import("../../../arcade/game/new-york/engine/street-details.js");
    const scene = new THREE.Scene();
    const grid = await buildCityGrid(scene);
    const boroughs = await buildBoroughs(scene, { sidewalks: grid.sidewalks });
    const { colliders } = buildLandmarks(scene);
    const blocks = await buildCityBlocks(scene, colliders);
    await buildStreetDetails(scene, [
        ...colliders,
        ...blocks.colliders,
        ...boroughs.colliders,
        ...(grid.colliders || [])
    ]);
    scene.updateMatrixWorld(true);

    const triangles: Triangle[] = [];
    const a = new THREE.Vector3(),
        b = new THREE.Vector3(),
        c = new THREE.Vector3();
    const n = new THREE.Vector3(),
        e1 = new THREE.Vector3(),
        e2 = new THREE.Vector3();
    const world = new THREE.Matrix4(),
        instance = new THREE.Matrix4();
    scene.traverseVisible((object: InstanceType<typeof THREE.Object3D>) => {
        const mesh = object as InstanceType<typeof THREE.Mesh>;
        if (!mesh.isMesh || !mesh.geometry?.attributes?.position) return;
        const position = mesh.geometry.attributes.position;
        const index = mesh.geometry.index;
        const count = index ? index.count : position.count;
        const instanced = (mesh as InstanceType<typeof THREE.InstancedMesh>).isInstancedMesh
            ? (mesh as InstanceType<typeof THREE.InstancedMesh>)
            : null;
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
    return { scene, sites: captured.sites, ground: groundIndex(triangles) };
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
        const sample = floating
            .slice(0, 12)
            .map(
                (s) =>
                    `(${s.x.toFixed(1)}, ${s.y.toFixed(2)}, ${s.z.toFixed(1)} +${s.gap.toFixed(2)})`
            );
        console.info(
            `[new-york-ground] ${floating.length} of ${sites.length} trees hovering ${sample.join(" ")}`
        );
        // The full list, for a sweep run by hand: NEW_YORK_GROUND_DUMP=<file> npx vitest run <this file>
        if (process.env.NEW_YORK_GROUND_DUMP)
            writeFileSync(process.env.NEW_YORK_GROUND_DUMP, JSON.stringify(floating));
        expect(sites.length).toBeGreaterThan(1000);
        // 404 before the fix, 44 of them along Central Park South, Fifth Avenue and Grand Army Plaza: none anywhere now
        expect(floating).toEqual([]);
    }, 600_000);
});

type Named = { short: string };
type Avenue = Named & { x: number; isHighway?: boolean; segs?: { z0: number; z1: number }[] };
type Street = Named & { z: number; runs?: number[][] };

describe("New York street-name signs", () => {
    it("name the avenue and street of the corner they stand at, across the whole city", async () => {
        const { scene } = await buildCity();
        const { ALL_AVENUES, ALL_STREETS } =
            await import("../../../arcade/game/new-york/engine/city-config.js");
        const blades = scene.getObjectByName("StreetNameBlades") as unknown as {
            count: number;
            geometry: {
                getAttribute: (name: string) => {
                    getX: (i: number) => number;
                    getY: (i: number) => number;
                };
            };
            getMatrixAt: (
                i: number,
                m: InstanceType<
                    typeof import("../../../arcade/node_modules/three/build/three.webgpu.js").Matrix4
                >
            ) => void;
            userData: { cells: { side: string; name: string }[] };
        };
        expect(blades).toBeDefined();
        const { cells } = blades.userData;
        const names = blades.geometry.getAttribute("bladeNames");
        const THREE = await import("../../../arcade/node_modules/three/build/three.webgpu.js");
        const matrix = new THREE.Matrix4();
        // A pole stands at most ~19 m from the avenue's centre (Park Avenue's mall) and ~12 m from the street's
        const nearestAvenue = (x: number, z: number) =>
            (ALL_AVENUES as Avenue[])
                .filter(
                    (a) => !a.isHighway && a.segs?.some((s) => z >= s.z0 - 15 && z <= s.z1 + 15)
                )
                .reduce<Avenue | null>(
                    (m, a) => (!m || Math.abs(a.x - x) < Math.abs(m.x - x) ? a : m),
                    null
                );
        const nearestStreet = (x: number, z: number) =>
            (ALL_STREETS as Street[])
                .filter((s) => s.runs?.some((r) => x >= r[0] - 25 && x <= r[1] + 25))
                .reduce<Street | null>(
                    (m, s) => (!m || Math.abs(s.z - z) < Math.abs(m.z - z) ? s : m),
                    null
                );
        const wrong: string[] = [];
        let fifthAt59th = 0;
        for (let i = 0; i < blades.count; i++) {
            blades.getMatrixAt(i, matrix);
            const [x, z] = [matrix.elements[12], matrix.elements[14]];
            const avenue = cells[names.getX(i)];
            const street = cells[names.getY(i)];
            const expected = [
                nearestAvenue(x, z)?.short.toUpperCase(),
                nearestStreet(x, z)?.short.toUpperCase()
            ];
            expect(avenue.side).toBe("avenue");
            expect(street.side).toBe("street");
            if (avenue.name !== expected[0] || street.name !== expected[1]) {
                wrong.push(
                    `(${x.toFixed(0)}, ${z.toFixed(0)}) reads ${avenue.name} · ${street.name}, stands at ${expected.join(" · ")}`
                );
            }
            if (avenue.name === "5TH AVE" && street.name === "59TH ST") fifthAt59th++;
        }
        expect(blades.count).toBeGreaterThan(500);
        expect(wrong).toEqual([]);
        // The corner the operator looked at
        expect(fifthAt59th).toBeGreaterThan(0);
        // Not one name for the whole city: as many different blades as there are corners with a signal
        expect(
            new Set(
                Array.from({ length: blades.count }, (_, i) => `${names.getX(i)}:${names.getY(i)}`)
            ).size
        ).toBeGreaterThan(blades.count / 3);
    }, 600_000);
});
