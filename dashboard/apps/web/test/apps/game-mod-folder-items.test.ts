/**
 * The items of the jars actually in a server's mods folder.
 *
 * A modpack leaves its mods in `/data/mods` and nothing on the server's Modrinth
 * list, so the picker read nothing from it: "vaccine" on a 219-jar Forge pack
 * answered "Nothing matches that." The jars below are shaped like that pack's
 * (`cure-2.0.2-forge-1.20.1.jar`, a pre-1.21.4 mod read from its item models)
 * and reach the service through a fake folder, which also counts what it reads -
 * the half of this that keeps a 300-jar pack cheap on its second open.
 */

import JSZip from "jszip";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const folder = await mkdtemp(join(tmpdir(), "polaris-mod-folder-"));

// Set before the module under test is imported: the environment is read and
// validated whole the first time anything asks it where the data directory is.
process.env.POLARIS_DATA_DIR = folder;
process.env.POLARIS_DATABASE_URL ??= "postgresql://polaris:polaris@localhost:5432/polaris";
process.env.POLARIS_AUTH_SECRET ??= "a-long-enough-string-for-the-schema";
process.env.POLARIS_MASTER_KEY ??= Buffer.alloc(32, 7).toString("base64");

const { jarTitle, parseFolderListing, readModFolder, readsModFolder } = await import(
    "@polaris-app/game-servers/src/lib/minecraft/mod-items-service"
);
const { modCatalogItems, readModItems, searchItems } = await import(
    "@polaris-app/game-servers/src/lib/minecraft/items"
);

type ModFolder = Parameters<typeof readModFolder>[0];
type FolderRead = NonNullable<Awaited<ReturnType<typeof readModFolder>>>;

async function jar(files: Record<string, unknown>): Promise<Uint8Array> {
    const zip = new JSZip();
    for (const [path, body] of Object.entries(files)) {
        zip.file(path, typeof body === "string" ? body : JSON.stringify(body));
    }
    return zip.generateAsync({ type: "uint8array" });
}

const CURE = "cure-2.0.2-forge-1.20.1.jar";
const cure = await jar({
    "META-INF/mods.toml": 'modLoader="javafml"\n[[mods]]\nmodId="cure"\n',
    "assets/cure/models/item/vaccine.json": {
        parent: "minecraft:item/generated",
        textures: { layer0: "minecraft:item/potion" }
    },
    "assets/cure/lang/en_us.json": { "item.cure.vaccine": "Vaccine" },
    "assets/cure/lang/es_es.json": { "item.cure.vaccine": "Vacuna" }
});
// A library: no assets at all, which is half of any pack and not a failure.
const library = await jar({ "META-INF/mods.toml": 'modId="lib"\n', "com/lib/Lib.class": "x" });

/** A folder in memory that counts every jar read out of it. */
function fakeFolder(jars: Record<string, { bytes: Uint8Array; modified: string }>): {
    folder: ModFolder;
    reads: string[];
} {
    const reads: string[] = [];
    return {
        reads,
        folder: {
            list: async () => ({
                jars: Object.entries(jars).map(([name, file]) => ({
                    name,
                    size: file.bytes.byteLength,
                    modified: file.modified
                })),
                whole: true
            }),
            read: async (name, limit) => {
                reads.push(name);
                const file = jars[name];
                return file && file.bytes.byteLength <= limit ? file.bytes : null;
            }
        }
    };
}

/** What the route would answer for one folder read, as the panel reads it. */
function asPanelItems(read: FolderRead) {
    return modCatalogItems(
        readModItems({
            items: read.catalogs.flatMap((catalog) =>
                catalog.items.map((item) => ({ ...item, mod: catalog.title, build: catalog.build }))
            )
        })
    );
}

const later = (): number => Date.now() + 30_000;

describe("a modpack's mods folder", () => {
    it("lists every item its jars add, found by label and by id", async () => {
        const { folder: pack } = fakeFolder({
            [CURE]: { bytes: cure, modified: "1700000000.5" },
            "library-1.0.jar": { bytes: library, modified: "1700000000.5" }
        });
        const read = await readModFolder(pack, "server-search", later());
        expect(read?.complete).toBe(true);
        expect(read?.unread).toEqual([]);
        const vaccine = read?.catalogs.flatMap((catalog) => catalog.items)[0];
        expect(vaccine).toMatchObject({
            id: "cure:vaccine",
            label: "Vaccine",
            names: { es_es: "Vacuna" },
            icon: { kind: "vanilla", texture: "item/potion" }
        });
        expect(read?.catalogs.find((catalog) => catalog.items.length > 0)?.title).toBe("cure");

        const items = asPanelItems(read!);
        for (const query of ["vaccine", "VACCINE", "cure:vaccine", "cure"]) {
            expect(searchItems(items, query, 10).map((item) => item.id)).toContain("cure:vaccine");
        }
    });

    it("reads an unchanged jar once, and a changed one again", async () => {
        const files = {
            [CURE]: { bytes: cure, modified: "1700000000.5" },
            "library-1.0.jar": { bytes: library, modified: "1700000000.5" }
        };
        const first = fakeFolder(files);
        await readModFolder(first.folder, "server-cache", later());
        expect(first.reads.sort()).toEqual([CURE, "library-1.0.jar"]);

        const second = fakeFolder(files);
        const again = await readModFolder(second.folder, "server-cache", later());
        expect(second.reads).toEqual([]);
        expect(again?.catalogs.flatMap((catalog) => catalog.items).map((item) => item.id)).toEqual([
            "cure:vaccine"
        ]);

        // Touched on disk: read again to learn its hash, which is still the build
        // already kept, so its items come back unchanged.
        const touched = fakeFolder({ ...files, [CURE]: { bytes: cure, modified: "1800000000.0" } });
        const reread = await readModFolder(touched.folder, "server-cache", later());
        expect(touched.reads).toEqual([CURE]);
        expect(reread?.catalogs.flatMap((catalog) => catalog.items)).toHaveLength(1);
    });

    it("leaves what the budget did not reach for the next open, not as broken", async () => {
        const { folder: pack, reads } = fakeFolder({
            "other-1.0.jar": { bytes: library, modified: "1" }
        });
        const read = await readModFolder(pack, "server-late", Date.now() - 1);
        expect(read).toEqual({ catalogs: [], unread: [], complete: false });
        expect(reads).toEqual([]);
    });

    it("names a jar it cannot open, and keeps going", async () => {
        const { folder: pack } = fakeFolder({
            "broken-1.0.jar": { bytes: new TextEncoder().encode("not a zip"), modified: "1" },
            [CURE]: { bytes: cure, modified: "1" }
        });
        const read = await readModFolder(pack, "server-broken", later());
        expect(read?.unread).toEqual(["broken-1.0.jar"]);
        expect(read?.catalogs.flatMap((catalog) => catalog.items).map((item) => item.id)).toEqual([
            "cure:vaccine"
        ]);
    });

    it("is nothing at all when the folder cannot be listed", async () => {
        const read = await readModFolder(
            { list: async () => null, read: async () => null },
            "server-gone",
            later()
        );
        expect(read).toBeNull();
    });
});

describe("the folder listing", () => {
    it("reads find's lines and drops anything that is not a jar", () => {
        expect(
            parseFolderListing(
                `12\t1700000000.1\t${CURE}\n7\t1700000000.2\tnotes.txt\nbad line\n9\t1.0\tSpaced Mod [1.2].jar\n`
            )
        ).toEqual([
            { name: CURE, size: 12, modified: "1700000000.1" },
            { name: "Spaced Mod [1.2].jar", size: 9, modified: "1.0" }
        ]);
    });

    it("names a mod by its file without the version and loader", () => {
        expect(jarTitle(CURE)).toBe("cure");
        expect(jarTitle("jei-1.20.1-forge-15.3.0.4.jar")).toBe("jei");
        expect(jarTitle("create_1.20.1_v0.5.1.jar")).toBe("create");
        expect(jarTitle("Mekanism.jar")).toBe("Mekanism");
    });
});

describe("which servers look in a mods folder", () => {
    it("is the modded ones and the packs, never vanilla or plugins", () => {
        for (const software of ["FORGE", "NEOFORGE", "FABRIC", "QUILT", "MODRINTH", "AUTO_CURSEFORGE", "MOHIST"]) {
            expect(readsModFolder(software), software).toBe(true);
        }
        for (const software of ["", "VANILLA", "PAPER", "SPIGOT", "LIMBO"]) {
            expect(readsModFolder(software), software).toBe(false);
        }
    });
});
