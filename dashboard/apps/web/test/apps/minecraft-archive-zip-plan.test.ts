/**
 * Server packs and worlds people bring themselves: the archive is read by its
 * index, the parts a server must not receive are left out, and the rest is
 * copied into a new archive without being unpacked.
 */

import JSZip from "jszip";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import {
    readZipIndex,
    readZipText,
    rewriteZip,
    safeEntryName,
    ZipRefusal
} from "@polaris-app/game-servers/src/lib/minecraft/archives/zip";
import {
    detectLoader,
    loaderFileEntries,
    planPack,
    planWorld,
    PlanRefusal
} from "@polaris-app/game-servers/src/lib/minecraft/archives/plan";

const dir = mkdtempSync(join(tmpdir(), "polaris-archive-"));
let counter = 0;

async function zipFile(
    files: Record<string, string>,
    options: { compression?: "STORE" | "DEFLATE"; streamFiles?: boolean } = {}
): Promise<string> {
    const zip = new JSZip();
    for (const [name, text] of Object.entries(files)) zip.file(name, text);
    const bytes = await zip.generateAsync({
        type: "nodebuffer",
        compression: options.compression ?? "DEFLATE",
        streamFiles: options.streamFiles ?? false
    });
    const location = join(dir, `a${(counter += 1)}.zip`);
    writeFileSync(location, bytes);
    return location;
}

const CW = "Cursed Walking - 1.20.1 - v3.3(patch) Server Pack";
const CURSED_WALKING: Record<string, string> = {
    [`${CW}/eula.txt`]: "eula=false",
    [`${CW}/forge-auto-install.txt`]:
        "minecraftVersion=1.20.1\nloaderType=Forge\nloaderVersion=47.4.0\n",
    [`${CW}/server.jar`]: "jar",
    [`${CW}/server.properties`]: "motd=x",
    [`${CW}/server_starter.conf`]: "x",
    [`${CW}/start_server.bat`]: "x",
    [`${CW}/start_server.sh`]: "x",
    [`${CW}/user_jvm_args.txt`]: "-Xmx8G",
    [`${CW}/mods/tacz.jar`]: "mod",
    [`${CW}/mods/jei.jar`]: "mod",
    [`${CW}/config/jei.toml`]: "a=1",
    [`${CW}/kubejs/startup.js`]: "//",
    [`${CW}/defaultconfigs/x.toml`]: "b=2",
    [`${CW}/tacz/pack.json`]: "{}",
    [`${CW}/world/level.dat`]: "level",
    [`${CW}/libraries/net/minecraftforge/forge/1.20.1-47.4.0/forge.jar`]: "lib"
};

describe("safeEntryName", () => {
    it("refuses a path that climbs out", () => {
        expect(safeEntryName("../evil")).toBeNull();
        expect(safeEntryName("a/../../evil")).toBeNull();
        expect(safeEntryName("/etc/passwd")).toBeNull();
        expect(safeEntryName("C:/x")).toBeNull();
        expect(safeEntryName("a\\b.txt")).toBe("a/b.txt");
    });
});

describe("readZipIndex", () => {
    it("reads deflated, stored and data-descriptor archives", async () => {
        for (const options of [
            { compression: "DEFLATE" as const },
            { compression: "STORE" as const },
            { compression: "DEFLATE" as const, streamFiles: true }
        ]) {
            const location = await zipFile({ "top/a.txt": "hello", "top/b.txt": "world" }, options);
            const entries = await readZipIndex(location);
            const a = entries.find((entry) => entry.name === "top/a.txt")!;
            expect(a.size).toBe(5);
            expect(await readZipText(location, a)).toBe("hello");
        }
    });

    it("refuses what is not a zip", async () => {
        const location = join(dir, "not.zip");
        writeFileSync(location, "plain text, no index");
        await expect(readZipIndex(location)).rejects.toMatchObject({ reason: "notZip" });
    });

    it("refuses an entry that climbs out of the folder", async () => {
        const location = await zipFile({ "aa/evil.txt": "x" }, { compression: "STORE" });
        const text = readFileSync(location).toString("latin1").replaceAll("aa/evil", "../evil");
        writeFileSync(location, Buffer.from(text, "latin1"));
        await expect(readZipIndex(location)).rejects.toBeInstanceOf(ZipRefusal);
        await expect(readZipIndex(location)).rejects.toMatchObject({ reason: "unsafePath" });
    });

    it("refuses an encrypted entry", async () => {
        const location = await zipFile({ "a.txt": "x" }, { compression: "STORE" });
        const bytes = readFileSync(location);
        const central = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
        bytes.writeUInt16LE(bytes.readUInt16LE(central + 8) | 0x1, central + 8);
        writeFileSync(location, bytes);
        await expect(readZipIndex(location)).rejects.toMatchObject({ reason: "encrypted" });
    });
});

describe("planPack", () => {
    it("takes a CurseForge server pack's folder off and leaves the server files out", async () => {
        const location = await zipFile(CURSED_WALKING);
        const entries = await readZipIndex(location);
        const plan = planPack(entries);
        expect(plan.root).toBe(CW);
        expect(plan.mods).toBe(2);
        expect(plan.kept.map((entry) => entry.to).sort()).toEqual([
            "config/jei.toml",
            "defaultconfigs/x.toml",
            "kubejs/startup.js",
            "mods/jei.jar",
            "mods/tacz.jar",
            "tacz/pack.json"
        ]);
        expect(plan.dropped).toEqual(
            expect.arrayContaining([
                "eula.txt",
                "forge-auto-install.txt",
                "libraries",
                "server.jar",
                "server.properties",
                "server_starter.conf",
                "start_server.bat",
                "start_server.sh",
                "user_jvm_args.txt",
                "world"
            ])
        );

        const texts = new Map<string, string>();
        for (const [base, entry] of loaderFileEntries(entries, plan.root))
            texts.set(base, (await readZipText(location, entry))!);
        expect(
            detectLoader(
                texts,
                entries.map((entry) => entry.name)
            )
        ).toEqual({ type: "FORGE", minecraft: "1.20.1", version: "47.4.0" });
    });

    it("refuses a world, an empty archive and two packs side by side", async () => {
        const world = await readZipIndex(
            await zipFile({ "w/level.dat": "x", "w/region/r.mca": "x" })
        );
        expect(() => planPack(world)).toThrow(PlanRefusal);
        expect(() => planPack(world)).toThrow(/isWorld/);
        const nothing = await readZipIndex(await zipFile({ "readme.txt": "x" }));
        expect(() => planPack(nothing)).toThrow(/noContent/);
        const two = await readZipIndex(
            await zipFile({ "a/mods/x.jar": "x", "b/mods/y.jar": "y" })
        );
        expect(() => planPack(two)).toThrow(/ambiguous/);
    });

    it("keeps a pack with no folder as it is", async () => {
        const entries = await readZipIndex(
            await zipFile({ "mods/x.jar": "x", "plugins/p.jar": "p", "run.sh": "x" })
        );
        const plan = planPack(entries);
        expect(plan.root).toBe("");
        expect(plan.kept.map((entry) => entry.to).sort()).toEqual(["mods/x.jar", "plugins/p.jar"]);
        expect(plan.plugins).toBe(1);
    });
});

describe("detectLoader", () => {
    it("reads the release off a NeoForge installer's name", () => {
        expect(
            detectLoader(new Map(), ["pack/neoforge-21.1.77-installer.jar", "pack/mods/a.jar"])
        ).toEqual({ type: "NEOFORGE", minecraft: "1.21.1", version: "21.1.77" });
    });

    it("reads a CurseForge manifest and a ServerStarter config", () => {
        const manifest = JSON.stringify({
            minecraft: { version: "1.20.1", modLoaders: [{ id: "forge-47.2.0", primary: true }] }
        });
        expect(detectLoader(new Map([["manifest.json", manifest]]), [])).toEqual({
            type: "FORGE",
            minecraft: "1.20.1",
            version: "47.2.0"
        });
        const starter = [
            "install:",
            "  mcVersion: \"1.21.1\"",
            "  loaderVersion: \"21.1.5\"",
            "  installerUrl: \"https://maven.neoforged.net/x\""
        ].join("\n");
        expect(detectLoader(new Map([["server-setup-config.yaml", starter]]), [])).toEqual({
            type: "NEOFORGE",
            minecraft: "1.21.1",
            version: "21.1.5"
        });
    });

    it("lets the image choose for a moving version, and is null with nothing to go on", () => {
        const vars = "MODLOADER=Fabric\nMINECRAFT_VERSION=1.21.1\nMODLOADER_VERSION=latest\n";
        expect(detectLoader(new Map([["variables.txt", vars]]), [])).toEqual({
            type: "FABRIC",
            minecraft: "1.21.1",
            version: null
        });
        expect(detectLoader(new Map(), ["mods/a.jar"])).toBeNull();
    });
});

describe("planWorld", () => {
    it("keeps the shallowest level folder and drops the game's lock", async () => {
        const entries = await readZipIndex(
            await zipFile({
                "My Server/world/level.dat": "x",
                "My Server/world/session.lock": "x",
                "My Server/world/region/r.0.0.mca": "x",
                "My Server/world/datapacks/extra.zip": "x",
                "My Server/world_nether/DIM-1/level.dat": "x",
                "My Server/server.properties": "x"
            })
        );
        const plan = planWorld(entries);
        expect(plan.root).toBe("My Server/world");
        expect(plan.levelName).toBe("world");
        expect(plan.datapacks).toBe(1);
        expect(plan.kept.map((entry) => entry.to).sort()).toEqual([
            "datapacks/extra.zip",
            "level.dat",
            "region/r.0.0.mca"
        ]);
    });

    it("refuses a pack sent as a world", async () => {
        const entries = await readZipIndex(await zipFile({ "mods/a.jar": "x" }));
        expect(() => planWorld(entries)).toThrow(/isPack/);
    });
});

describe("rewriteZip", () => {
    it("copies kept entries under new names, readable by another reader", async () => {
        for (const streamFiles of [false, true]) {
            const location = await zipFile(CURSED_WALKING, { streamFiles });
            const entries = await readZipIndex(location);
            const plan = planPack(entries);
            const byName = new Map(entries.map((entry) => [entry.name, entry]));
            const target = join(dir, `out${(counter += 1)}.zip`);
            const size = await rewriteZip(
                location,
                target,
                plan.kept.map(({ from, to }) => ({ entry: byName.get(from)!, name: to }))
            );
            const written = readFileSync(target);
            expect(written.length).toBe(size);
            const back = await JSZip.loadAsync(written, { checkCRC32: true });
            expect(Object.keys(back.files).sort()).toEqual(
                plan.kept.map((entry) => entry.to).sort()
            );
            expect(await back.file("mods/tacz.jar")!.async("string")).toBe("mod");
            expect(await back.file("config/jei.toml")!.async("string")).toBe("a=1");
            // Its own index reads back too, with no data descriptor left behind.
            const again = await readZipIndex(target);
            expect(again.every((entry) => (entry.flags & 0x8) === 0)).toBe(true);
        }
    });
});
