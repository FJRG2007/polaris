/**
 * The world optimizer's script, run for real against region files built here.
 *
 * Every chunk, companion and player file below is genuine NBT, zlib- or
 * gzip-compressed the way the game writes it, laid out in real region files. The
 * script is the exact string Polaris puts into the container. What these pin is
 * the 2026-11-21 incident (BUG-0009): chests, beds and signs in chunks with no
 * inhabited time were deleted, and the rewritten files were left owned by root.
 *
 * Needs a Python 3 on the machine running the tests; without one the suite is
 * skipped and says so.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { deflateSync, gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import {
    WORLD_OWNER_REPAIR_SCRIPT,
    WORLD_TRIM_SCRIPT
} from "@polaris-app/game-servers/src/lib/minecraft/world-trim-script";

const python = ["python3", "python"].find(
    (command) => spawnSync(command, ["--version"], { encoding: "utf8" }).status === 0
);

// ---- NBT ------------------------------------------------------------------

type Tag =
    | { t: "byte"; v: number }
    | { t: "int"; v: number }
    | { t: "long"; v: bigint }
    | { t: "double"; v: number }
    | { t: "string"; v: string }
    | { t: "list"; of: number; v: Tag[] }
    | { t: "compound"; v: Record<string, Tag> };

const ids = { byte: 1, int: 3, long: 4, double: 6, string: 8, list: 9, compound: 10 } as const;

function name(text: string): Buffer {
    const bytes = Buffer.from(text, "utf8");
    const size = Buffer.alloc(2);
    size.writeUInt16BE(bytes.length);
    return Buffer.concat([size, bytes]);
}

function payload(tag: Tag): Buffer {
    switch (tag.t) {
        case "byte":
            return Buffer.from([tag.v]);
        case "int": {
            const out = Buffer.alloc(4);
            out.writeInt32BE(tag.v);
            return out;
        }
        case "long": {
            const out = Buffer.alloc(8);
            out.writeBigInt64BE(tag.v);
            return out;
        }
        case "double": {
            const out = Buffer.alloc(8);
            out.writeDoubleBE(tag.v);
            return out;
        }
        case "string":
            return name(tag.v);
        case "list": {
            const head = Buffer.alloc(5);
            head.writeUInt8(tag.v.length === 0 ? 0 : tag.of, 0);
            head.writeInt32BE(tag.v.length, 1);
            return Buffer.concat([head, ...tag.v.map(payload)]);
        }
        case "compound":
            return Buffer.concat([
                ...Object.entries(tag.v).map(([key, child]) =>
                    Buffer.concat([Buffer.from([ids[child.t]]), name(key), payload(child)])
                ),
                Buffer.from([0])
            ]);
    }
}

function root(value: Record<string, Tag>): Buffer {
    return Buffer.concat([Buffer.from([10]), name(""), payload({ t: "compound", v: value })]);
}

const int = (v: number): Tag => ({ t: "int", v });
const str = (v: string): Tag => ({ t: "string", v });
const compound = (v: Record<string, Tag>): Tag => ({ t: "compound", v });
const list = (v: Tag[], of = 10): Tag => ({ t: "list", of, v });

interface ChunkSpec {
    ticks?: number;
    status?: string;
    blockEntities?: string[];
    /** Leave every block-entity list out, as a format the script does not know. */
    noBlockEntityList?: boolean;
    forgeCaps?: boolean;
    /** Not NBT at all, behind a compression byte the script does not read. */
    garbage?: boolean;
}

function chunk(x: number, z: number, spec: ChunkSpec): Buffer {
    const value: Record<string, Tag> = {
        DataVersion: int(3465),
        xPos: int(x),
        zPos: int(z),
        Status: str(spec.status ?? "minecraft:full"),
        InhabitedTime: { t: "long", v: BigInt(spec.ticks ?? 0) },
        sections: list([])
    };
    if (!spec.noBlockEntityList)
        value.block_entities = list(
            (spec.blockEntities ?? []).map((id) => compound({ id: str(id), x: int(x * 16), y: int(64), z: int(z * 16) }))
        );
    if (spec.forgeCaps) value.ForgeCaps = compound({ "mymod:pollution": int(3) });
    return root(value);
}

function entitiesChunk(x: number, z: number, count: number): Buffer {
    return root({
        DataVersion: int(3465),
        Position: compound({ x: int(x), z: int(z) }),
        Entities: list(Array.from({ length: count }, () => compound({ id: str("minecraft:villager") })))
    });
}

function poiChunk(records: number): Buffer {
    return root({
        DataVersion: int(3465),
        Sections: compound(
            records === 0
                ? {}
                : { "4": compound({ Valid: { t: "byte", v: 1 }, Records: list(Array.from({ length: records }, () => compound({ type: str("minecraft:home") }))) }) }
        )
    });
}

/** A region file holding these chunks, keyed by slot (x + z * 32). */
function regionFile(chunks: Map<number, Buffer | "garbage">): Buffer {
    const header = Buffer.alloc(8192);
    const bodies: Buffer[] = [];
    let sector = 2;
    for (const [index, data] of chunks) {
        const compressed = data === "garbage" ? Buffer.from("not a chunk at all") : deflateSync(data);
        const head = Buffer.alloc(5);
        head.writeUInt32BE(compressed.length + 1, 0);
        head.writeUInt8(data === "garbage" ? 9 : 2, 4);
        const body = Buffer.concat([head, compressed]);
        const sectors = Math.ceil(body.length / 4096);
        const padded = Buffer.alloc(sectors * 4096);
        body.copy(padded);
        header.writeUInt32BE((sector << 8) | sectors, index * 4);
        header.writeUInt32BE(1_700_000_000, 4096 + index * 4);
        bodies.push(padded);
        sector += sectors;
    }
    return Buffer.concat([header, ...bodies]);
}

/** The slots present in a region file. */
function slots(file: string): number[] {
    const data = fs.readFileSync(file);
    const found: number[] = [];
    for (let index = 0; index < 1024; index += 1) if (data.readUInt32BE(index * 4) !== 0) found.push(index);
    return found;
}

// ---- a world ----------------------------------------------------------------

interface WorldSpec {
    chunks: Record<number, ChunkSpec>;
    entities?: Record<number, number>;
    poi?: Record<number, number>;
    /** Chunk the one player logged out in, in the overworld. */
    player?: { x: number; z: number };
}

const made: string[] = [];

afterEach(() => {
    for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function makeWorld(spec: WorldSpec): { data: string; world: string } {
    const data = fs.mkdtempSync(path.join(os.tmpdir(), "polaris-trim-"));
    made.push(data);
    const world = path.join(data, "world");
    for (const folder of ["region", "entities", "poi", "playerdata"]) fs.mkdirSync(path.join(world, folder), { recursive: true });
    // Spawn far from every chunk here, so the spawn area keeps none of them.
    fs.writeFileSync(
        path.join(world, "level.dat"),
        gzipSync(root({ Data: compound({ SpawnX: int(500_000), SpawnZ: int(500_000) }) }))
    );
    const region = new Map<number, Buffer | "garbage">();
    for (const [key, chunkSpec] of Object.entries(spec.chunks)) {
        const index = Number(key);
        region.set(index, chunkSpec.garbage ? "garbage" : chunk(index % 32, Math.floor(index / 32), chunkSpec));
    }
    fs.writeFileSync(path.join(world, "region", "r.0.0.mca"), regionFile(region));
    if (spec.entities)
        fs.writeFileSync(
            path.join(world, "entities", "r.0.0.mca"),
            regionFile(new Map(Object.entries(spec.entities).map(([key, count]) => [Number(key), entitiesChunk(Number(key) % 32, Math.floor(Number(key) / 32), count)])))
        );
    if (spec.poi)
        fs.writeFileSync(
            path.join(world, "poi", "r.0.0.mca"),
            regionFile(new Map(Object.entries(spec.poi).map(([key, count]) => [Number(key), poiChunk(count)])))
        );
    if (spec.player)
        fs.writeFileSync(
            path.join(world, "playerdata", "0000.dat"),
            gzipSync(
                root({
                    Pos: list([spec.player.x * 16 + 8, 64, spec.player.z * 16 + 8].map((v) => ({ t: "double", v }) as Tag), 6),
                    Dimension: str("minecraft:overworld")
                })
            )
        );
    return { data, world };
}

/**
 * Run a script against a world. `fakeOwner` makes every `.mca` look owned by
 * uid/gid 1000 with mode 0640 (and `level.dat` by `levelOwner`), and records
 * every chown and chmod - the only way to watch ownership on a machine where
 * the tests do not run as root, or on Windows, which has no owners at all.
 */
function run(
    script: string,
    world: string,
    flags: string[] = [],
    fake?: { mca: number; levelDat: number }
): { report: Record<string, unknown>; calls: [string, string, number, number?][] } {
    const dir = path.dirname(world);
    const file = path.join(dir, "tool.py");
    fs.writeFileSync(file, script);
    const harness = path.join(dir, "harness.py");
    fs.writeFileSync(
        harness,
        `import json, os, runpy, sys
fake = json.loads(sys.argv[1])
calls = []
if fake:
    real_stat = os.stat
    def fake_stat(p, *a, **k):
        r = real_stat(p, *a, **k)
        text = os.fspath(p)
        owner = fake["mca"] if text.endswith(".mca") else fake["levelDat"] if text.endswith("level.dat") else None
        if owner is None:
            return r
        fields = list(r)[:10]
        fields[0] = (r.st_mode & ~0o777) | 0o640
        fields[4] = owner
        fields[5] = owner
        return os.stat_result(fields)
    os.stat = fake_stat
    os.lstat = fake_stat
    os.chown = lambda p, u, g, **k: calls.append(["chown", os.path.basename(p), u, g])
    real_chmod = os.chmod
    def fake_chmod(p, m, **k):
        calls.append(["chmod", os.path.basename(p), m])
        real_chmod(p, m)
    os.chmod = fake_chmod
sys.argv = [sys.argv[2]] + sys.argv[3:]
try:
    runpy.run_path(sys.argv[0], run_name="__main__")
except SystemExit:
    pass
sys.stderr.write("CALLS" + json.dumps(calls) + "\\n")
`
    );
    const result = spawnSync(
        python!,
        [harness, JSON.stringify(fake ?? null), file, "--world", world, "--keep-radius", "0", ...flags],
        { encoding: "utf8" }
    );
    const line = result.stdout.trim().split(/\r?\n/).pop() ?? "";
    let report: Record<string, unknown>;
    try {
        report = JSON.parse(line) as Record<string, unknown>;
    } catch {
        throw new Error(`no report: ${result.stdout}\n${result.stderr}`);
    }
    const marker = result.stderr.lastIndexOf("CALLS");
    const calls = marker >= 0 ? (JSON.parse(result.stderr.slice(marker + 5).trim()) as [string, string, number, number?][]) : [];
    return { report, calls };
}

function backups(data: string): string[] {
    const folder = path.join(data, "backups");
    return fs.existsSync(folder) ? fs.readdirSync(folder) : [];
}

function snapshot(world: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const folder of ["region", "entities", "poi"]) {
        const file = path.join(world, folder, "r.0.0.mca");
        if (fs.existsSync(file)) out[folder] = fs.readFileSync(file).toString("base64");
    }
    return out;
}

/** Six chunks people were in, and whatever else the test adds. */
function lived(extra: Record<number, ChunkSpec>): Record<number, ChunkSpec> {
    const chunks: Record<number, ChunkSpec> = {};
    for (let index = 100; index < 106; index += 1) chunks[index] = { ticks: 5000 };
    return { ...chunks, ...extra };
}

// ---- the tests ----------------------------------------------------------------

describe.skipIf(!python)("the world optimizer, against real region files", () => {
    it("removes untouched chunks, and keeps every chunk holding anything", () => {
        const { data, world } = makeWorld({
            chunks: lived({
                0: {},
                1: {},
                2: { blockEntities: ["minecraft:chest"] },
                3: { blockEntities: ["minecraft:red_bed", "minecraft:oak_sign"] },
                4: {},
                5: {},
                6: { forgeCaps: true },
                7: { noBlockEntityList: true },
                8: { garbage: true }
            }),
            entities: { 4: 2, 0: 0 },
            poi: { 5: 1, 1: 0 }
        });
        const { report } = run(WORLD_TRIM_SCRIPT, world);
        expect(report.refused).toBeNull();
        // 0 and 1 are empty everywhere; 2-8 each hold something or cannot be read.
        expect(report.removed).toBe(2);
        const left = slots(path.join(world, "region", "r.0.0.mca"));
        expect(left).toEqual([2, 3, 4, 5, 6, 7, 8, 100, 101, 102, 103, 104, 105]);
        // The companions lose only the slots the chunk file lost.
        expect(slots(path.join(world, "entities", "r.0.0.mca"))).toEqual([4]);
        expect(slots(path.join(world, "poi", "r.0.0.mca"))).toEqual([5]);
    });

    it("never trims entities or points of interest of a chunk it kept or never had", () => {
        // Slot 9 has entities with no chunk in the region file at all.
        const { world } = makeWorld({ chunks: lived({ 0: {} }), entities: { 9: 3, 0: 0 } });
        run(WORLD_TRIM_SCRIPT, world);
        expect(slots(path.join(world, "region", "r.0.0.mca"))).not.toContain(0);
        expect(slots(path.join(world, "entities", "r.0.0.mca"))).toEqual([9]);
    });

    it("takes a backup it has read back before rewriting anything, and names it", () => {
        const { data, world } = makeWorld({ chunks: lived({ 0: {} }) });
        const { report } = run(WORLD_TRIM_SCRIPT, world);
        const backup = report.backup as { name: string; sizeBytes: number; files: number };
        expect(backup.name).toMatch(/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}-[0-9]{2}-[0-9]{2}-[0-9]{3}\.tar\.gz$/);
        expect(backup.sizeBytes).toBeGreaterThan(0);
        expect(backups(data)).toEqual([backup.name]);
        const listing = spawnSync("tar", ["-tzf", path.join(data, "backups", backup.name)], { encoding: "utf8" });
        if (listing.status === 0) {
            expect(listing.stdout).toContain("world/level.dat");
            expect(listing.stdout).toContain("world/region/r.0.0.mca");
        }
    });

    it("refuses when more than half of the finished chunks would go, and touches nothing", () => {
        // The incident's shape: almost every chunk empty with no inhabited time.
        const chunks: Record<number, ChunkSpec> = { 100: { ticks: 5000 } };
        for (let index = 0; index < 9; index += 1) chunks[index] = {};
        const { data, world } = makeWorld({ chunks });
        const before = snapshot(world);
        const { report } = run(WORLD_TRIM_SCRIPT, world);
        expect(report.refused).toMatchObject({ reason: "share", limit: 0.5 });
        expect(snapshot(world)).toEqual(before);
        expect(backups(data)).toEqual([]);
    });

    it("does not count chunks that never finished generating against the ceiling", () => {
        const chunks: Record<number, ChunkSpec> = { 100: { ticks: 5000 }, 101: { ticks: 5000 } };
        for (let index = 0; index < 8; index += 1) chunks[index] = { status: "minecraft:features" };
        const { world } = makeWorld({ chunks });
        const { report } = run(WORLD_TRIM_SCRIPT, world);
        expect(report.refused).toBeNull();
        expect(report.removed).toBe(8);
    });

    it("refuses a world that does not count inhabited time", () => {
        // The player logged out in a chunk that says nobody was ever there.
        const { data, world } = makeWorld({ chunks: lived({ 0: {}, 50: {} }), player: { x: 50 % 32, z: 1 } });
        const before = snapshot(world);
        const { report } = run(WORLD_TRIM_SCRIPT, world);
        expect(report.refused).toMatchObject({ reason: "untracked" });
        expect(snapshot(world)).toEqual(before);
        expect(backups(data)).toEqual([]);
    });

    it("changes nothing and takes no backup when it only measures", () => {
        const { data, world } = makeWorld({ chunks: lived({ 0: {}, 1: {} }) });
        const before = snapshot(world);
        const { report } = run(WORLD_TRIM_SCRIPT, world, ["--dry-run"]);
        expect(report.removed).toBe(2);
        expect(report.backup).toBeNull();
        expect(snapshot(world)).toEqual(before);
        expect(backups(data)).toEqual([]);
    });

    it("gives every file it writes the owner and mode of the one it replaces", () => {
        const { world } = makeWorld({ chunks: lived({ 0: {} }), entities: { 0: 0, 101: 1 } });
        const { report, calls } = run(WORLD_TRIM_SCRIPT, world, [], { mca: 1000, levelDat: 1000 });
        expect(report.removed).toBe(1);
        const written = calls.filter(([, file]) => file.endsWith(".mca.polaris-new"));
        // The chunk file and its entities, each chowned and chmodded before the move.
        expect(written.filter(([kind]) => kind === "chown")).toEqual([
            ["chown", "r.0.0.mca.polaris-new", 1000, 1000],
            ["chown", "r.0.0.mca.polaris-new", 1000, 1000]
        ]);
        expect(written.filter(([kind]) => kind === "chmod")).toEqual([
            ["chmod", "r.0.0.mca.polaris-new", 0o640],
            ["chmod", "r.0.0.mca.polaris-new", 0o640]
        ]);
        // The backup goes to the world's owner too.
        expect(calls).toContainEqual(["chown", expect.stringMatching(/\.tar\.gz\.part$/), 1000, 1000]);
    });

    it.skipIf(process.platform === "win32")("keeps the real mode of a rewritten file", () => {
        const { world } = makeWorld({ chunks: lived({ 0: {} }) });
        const file = path.join(world, "region", "r.0.0.mca");
        fs.chmodSync(file, 0o600);
        run(WORLD_TRIM_SCRIPT, world);
        expect(fs.statSync(file).mode & 0o777).toBe(0o600);
        expect(slots(file)).not.toContain(0);
    });
});

describe.skipIf(!python)("the ownership repair", () => {
    it("gives chunk files owned by somebody else back to the owner of level.dat", () => {
        const { world } = makeWorld({ chunks: lived({}), entities: { 100: 1 } });
        fs.writeFileSync(path.join(world, "playerdata", "not-a-chunk.mca"), "x");
        const { report, calls } = run(WORLD_OWNER_REPAIR_SCRIPT, world, [], { mca: 0, levelDat: 1000 });
        expect(report).toMatchObject({ repair: true, checked: 2, fixed: 2, failed: 0 });
        expect(calls).toEqual([
            ["chown", "r.0.0.mca", 1000, 1000],
            ["chown", "r.0.0.mca", 1000, 1000]
        ]);
    });

    it("leaves files that already belong to the world's owner alone", () => {
        const { world } = makeWorld({ chunks: lived({}) });
        const { report, calls } = run(WORLD_OWNER_REPAIR_SCRIPT, world, [], { mca: 1000, levelDat: 1000 });
        expect(report).toMatchObject({ checked: 1, fixed: 0 });
        expect(calls).toEqual([]);
    });

    it("only counts when it is asked to measure", () => {
        const { world } = makeWorld({ chunks: lived({}) });
        const { report, calls } = run(WORLD_OWNER_REPAIR_SCRIPT, world, ["--dry-run"], { mca: 0, levelDat: 1000 });
        expect(report).toMatchObject({ fixed: 1 });
        expect(calls).toEqual([]);
    });
});

it("says so when there is no Python to run the script with", () => {
    if (!python) console.warn("[game-world-trim-script] no python3 on this machine: the script tests were skipped");
    expect(true).toBe(true);
});
