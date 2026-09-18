/**
 * The items a mod adds, read out of its jar.
 *
 * The jar below is built to the shape a real one has, because the shape is the
 * whole feature: every path, every file and every field asserted here was read
 * out of SecurityCraft's own 1.21.4 NeoForge build, and the four cases it covers
 * are the four that actually occur in it.
 *
 * - An item with a texture under its own name (`keycard_lv1`), which is what
 *   naive path-guessing gets, and which is 149 of that mod's 692 items.
 * - A block whose model is the mod's, inherits from another of the mod's models,
 *   and lands on a vanilla texture (`reinforced_stone` -> `minecraft:block/stone`).
 *   539 of SecurityCraft's 692 items are this one.
 * - An item definition that is a tree rather than a field - a composite of a
 *   vanilla model and an overlay - where the picture has to come from the first
 *   model in it (`coal_mine`).
 * - A texture that is not a square, which is drawn as its first frame rather than
 *   squashed into the slot.
 *
 * And one jar with no items at all, which is half of what is on a normal server:
 * a data pack, a library, a mod that only changes how the game behaves.
 */

import JSZip from "jszip";
import { deflateSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildFor, forgetModrinthAnswers } from "@/lib/apps/minecraft/modrinth";
import {
    firstModelId,
    pickTexture,
    pngSize,
    readJarItems,
    type JarFiles
} from "@/lib/apps/minecraft/mod-items";
import { noteFor } from "@/app/(app)/apps/installed/[id]/minecraft-mod-items";
import {
    modCatalogItems,
    searchItems,
    modItemPicture,
    pictureFit,
    readModItems,
    vanillaTextureName,
    type ModItemView
} from "@/lib/apps/minecraft/items";

/** A real PNG of the given size. Only the header is ever read, but a file that is
 *  not actually a PNG would make the assertions about sizes meaningless. */
function png(width: number, height: number): Uint8Array {
    const chunk = (type: string, body: Buffer): Buffer => {
        const head = Buffer.alloc(8);
        head.writeUInt32BE(body.length, 0);
        head.write(type, 4, "ascii");
        const crc = Buffer.alloc(4);
        crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0);
        return Buffer.concat([head, body, crc]);
    };
    const header = Buffer.alloc(13);
    header.writeUInt32BE(width, 0);
    header.writeUInt32BE(height, 4);
    header[8] = 8;
    header[9] = 6;
    const rows = Buffer.alloc(height * (width * 4 + 1));
    return new Uint8Array(
        Buffer.concat([
            Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
            chunk("IHDR", header),
            chunk("IDAT", deflateSync(rows)),
            chunk("IEND", Buffer.alloc(0))
        ])
    );
}

function crc32(bytes: Buffer): number {
    let crc = 0xffffffff;
    for (const byte of bytes) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
    return (crc ^ 0xffffffff) >>> 0;
}

/** The jar, as the reader sees one: the same adapter the service puts over JSZip. */
async function jarOf(files: Record<string, string | Uint8Array>): Promise<JarFiles> {
    const zip = new JSZip();
    for (const [path, body] of Object.entries(files)) zip.file(path, body);
    const bytes = await zip.generateAsync({ type: "uint8array" });
    const read = await JSZip.loadAsync(bytes);
    return {
        paths: Object.keys(read.files),
        read: async (path: string) => {
            const entry = read.files[path];
            return entry && !entry.dir ? entry.async("uint8array") : null;
        }
    };
}

const SECURITYCRAFT = {
    "assets/securitycraft/lang/en_us.json": JSON.stringify({
        "item.securitycraft.keycard_lv1": "Level 1 Keycard",
        "block.securitycraft.reinforced_stone": "Reinforced Stone",
        "block.securitycraft.coal_mine": "Coal Ore Mine",
        "block.securitycraft.alarm": "Alarm",
        "gui.securitycraft.not_an_item": "Not an item at all"
    }),
    "assets/securitycraft/items/keycard_lv1.json": JSON.stringify({
        model: { type: "minecraft:model", model: "securitycraft:item/keycard_lv1" }
    }),
    "assets/securitycraft/items/reinforced_stone.json": JSON.stringify({
        model: { type: "minecraft:model", model: "securitycraft:block/reinforced_stone" }
    }),
    "assets/securitycraft/items/coal_mine.json": JSON.stringify({
        model: {
            type: "minecraft:select",
            cases: [
                {
                    model: {
                        type: "minecraft:composite",
                        models: [
                            { type: "minecraft:model", model: "minecraft:block/coal_ore" },
                            {
                                type: "minecraft:model",
                                model: "securitycraft:item/block_mine_overlay"
                            }
                        ]
                    },
                    when: ["gui"]
                }
            ]
        }
    }),
    "assets/securitycraft/items/alarm.json": JSON.stringify({
        model: { type: "minecraft:model", model: "securitycraft:item/alarm" }
    }),
    "assets/securitycraft/models/item/keycard_lv1.json": JSON.stringify({
        parent: "minecraft:item/generated",
        textures: { layer0: "securitycraft:item/keycard_lv1" }
    }),
    "assets/securitycraft/models/item/alarm.json": JSON.stringify({
        parent: "minecraft:item/generated",
        textures: { layer0: "securitycraft:item/alarm" }
    }),
    "assets/securitycraft/models/block/reinforced_stone.json": JSON.stringify({
        parent: "securitycraft:block/reinforced_cube_all",
        textures: { all: "minecraft:block/stone" }
    }),
    "assets/securitycraft/models/block/reinforced_cube_all.json": JSON.stringify({
        parent: "minecraft:block/cube_all"
    }),
    "assets/securitycraft/textures/item/keycard_lv1.png": png(16, 16),
    "assets/securitycraft/textures/item/alarm.png": png(16, 32)
};

describe("what a jar says a mod adds", () => {
    it("takes the ids from the item definitions and the names from the translations", async () => {
        const { items } = await readJarItems(await jarOf(SECURITYCRAFT));
        const ids = items.map((item) => item.id);
        expect(ids).toContain("securitycraft:keycard_lv1");
        expect(ids).toContain("securitycraft:reinforced_stone");
        // A translation key that is not an item is not an item.
        expect(ids).not.toContain("securitycraft:not_an_item");
        // The label the game shows, not the id title-cased: `keycard_lv1` is
        // "Level 1 Keycard", which no amount of capitalising the id produces.
        expect(items.find((item) => item.id === "securitycraft:keycard_lv1")?.label).toBe(
            "Level 1 Keycard"
        );
        expect(items.find((item) => item.id === "securitycraft:coal_mine")?.label).toBe(
            "Coal Ore Mine"
        );
    });

    it("keeps the picture a model points at, at its own size", async () => {
        const { items, icons } = await readJarItems(await jarOf(SECURITYCRAFT));
        const keycard = items.find((item) => item.id === "securitycraft:keycard_lv1");
        expect(keycard?.icon).toEqual({
            kind: "mod",
            name: "securitycraft.item.keycard_lv1",
            width: 16,
            height: 16
        });
        expect(icons.get("securitycraft.item.keycard_lv1")?.byteLength).toBeGreaterThan(0);
    });

    it("reports a texture that is not square, so a strip is not squashed into a slot", async () => {
        const { items } = await readJarItems(await jarOf(SECURITYCRAFT));
        expect(items.find((item) => item.id === "securitycraft:alarm")?.icon).toMatchObject({
            width: 16,
            height: 32
        });
    });

    it("follows the model's parents onto the vanilla texture it lands on", async () => {
        // Five hundred and thirty-nine of SecurityCraft's items are this: a
        // reinforced version of a vanilla block, whose picture the game ships.
        const { items } = await readJarItems(await jarOf(SECURITYCRAFT));
        expect(items.find((item) => item.id === "securitycraft:reinforced_stone")?.icon).toEqual({
            kind: "vanilla",
            texture: "block/stone"
        });
    });

    it("reads the first model out of a definition that is a tree", async () => {
        const { items } = await readJarItems(await jarOf(SECURITYCRAFT));
        // The ore itself rather than the overlay drawn on top of it.
        expect(items.find((item) => item.id === "securitycraft:coal_mine")?.icon).toEqual({
            kind: "vanilla",
            texture: "block/coal_ore"
        });
    });

    it("reads a mod built before item definitions existed from its translations", async () => {
        const { items } = await readJarItems(
            await jarOf({
                "assets/comforts/lang/en_us.json": JSON.stringify({
                    "item.comforts.sleeping_bag_red": "Red Sleeping Bag"
                }),
                "assets/comforts/models/item/sleeping_bag_red.json": JSON.stringify({
                    parent: "minecraft:item/generated",
                    textures: { layer0: "comforts:item/sleeping_bag_red" }
                }),
                "assets/comforts/textures/item/sleeping_bag_red.png": png(16, 16)
            })
        );
        expect(items).toHaveLength(1);
        expect(items[0]?.id).toBe("comforts:sleeping_bag_red");
        expect(items[0]?.label).toBe("Red Sleeping Bag");
        expect(items[0]?.icon).toMatchObject({ kind: "mod" });
    });

    it("reads a jar that adds no items as no items", async () => {
        // A data pack, which is what three of the six mods on the server this was
        // built for turned out to be.
        const { items, icons } = await readJarItems(
            await jarOf({
                "data/dt/function/light.mcfunction": "say hello",
                "pack.mcmeta": JSON.stringify({ pack: { pack_format: 61 } })
            })
        );
        expect(items).toEqual([]);
        expect(icons.size).toBe(0);
    });

    it("does not read a texture the mod never shipped", async () => {
        const { items } = await readJarItems(
            await jarOf({
                "assets/trashslot/lang/en_us.json": JSON.stringify({
                    "item.trashslot.ghost": "Ghost"
                }),
                "assets/trashslot/models/item/ghost.json": JSON.stringify({
                    textures: { layer0: "trashslot:item/missing" }
                })
            })
        );
        expect(items[0]?.icon).toBeNull();
    });

    it("refuses a path that would climb out of the jar", async () => {
        const { items, icons } = await readJarItems(
            await jarOf({
                "assets/bad/lang/en_us.json": JSON.stringify({ "item.bad.thing": "Thing" }),
                "assets/bad/models/item/thing.json": JSON.stringify({
                    textures: { layer0: "bad:../../../../etc/passwd" }
                })
            })
        );
        expect(items[0]?.icon).toBeNull();
        expect(icons.size).toBe(0);
    });
});

describe("the pieces a model is read with", () => {
    it("finds the model in a definition however deep it is", () => {
        expect(firstModelId({ model: { type: "minecraft:model", model: "a:item/b" } })).toBe(
            "a:item/b"
        );
        expect(firstModelId({ nothing: true })).toBeNull();
    });

    it("prefers the face an item is recognised by", () => {
        expect(pickTexture({ layer0: "a:item/b", particle: "a:item/c" })).toBe("a:item/b");
        expect(pickTexture({ particle: "a:block/c", front: "a:block/d" })).toBe("a:block/d");
        // A reference to a face nobody gave a texture is not a texture.
        expect(pickTexture({ all: "#side" })).toBeNull();
        expect(pickTexture({})).toBeNull();
    });

    it("reads a PNG's size and refuses anything that is not one", () => {
        expect(pngSize(png(16, 48))).toEqual({ width: 16, height: 48 });
        expect(pngSize(new Uint8Array([1, 2, 3]))).toBeNull();
        expect(pngSize(new Uint8Array(40))).toBeNull();
    });
});

describe("what the panel does with them", () => {
    const build = "d45f4a0290360cc5bcbe241cd35785a8085d1d1b";

    it("drops anything out of the answer that is not a modded item", () => {
        const read = readModItems({
            items: [
                { id: "securitycraft:keycard_lv1", label: "Level 1 Keycard", mod: "security-craft", build, icon: null },
                // Vanilla is already in the picker, and twice is twice.
                { id: "minecraft:stone", label: "Stone", mod: "x", build, icon: null },
                { id: "not an id", label: "No", mod: "x", build, icon: null },
                "nonsense"
            ]
        });
        expect(read.map((item) => item.id)).toEqual(["securitycraft:keycard_lv1"]);
    });

    it("refuses a picture name that would name a file somewhere else", () => {
        const read = readModItems({
            items: [
                {
                    id: "a:b",
                    label: "B",
                    mod: "a",
                    build,
                    icon: { kind: "mod", name: "../../secret", width: 16, height: 16 }
                }
            ]
        });
        expect(read[0]?.icon).toBeNull();
    });

    it("finds a modded item by the namespace its ids carry, not only by the list's spelling", () => {
        // The two names for one mod: `security-craft` is what the mod list says
        // and `securitycraft` is what every id it registers says, and an operator
        // has only ever seen one of them.
        const items = modCatalogItems([
            {
                id: "securitycraft:keycard_lv1",
                label: "Level 1 Keycard",
                mod: "security-craft",
                build,
                icon: null
            }
        ]);
        expect(searchItems(items, "securitycraft", 10).map((item) => item.id)).toEqual([
            "securitycraft:keycard_lv1"
        ]);
        expect(searchItems(items, "security-craft", 10)).toHaveLength(1);
        expect(searchItems(items, "keycard", 10)).toHaveLength(1);
    });

    it("says the modded items are there, and which mods could not be read", () => {
        // Without this the picker looks exactly as it did before: modded entries
        // rank behind vanilla, so an operator who types nothing sees the same
        // grid and concludes their mods are still missing.
        expect(noteFor({}, 4464)).toBe(
            "Also searching 4464 items this server's mods add. Type a mod's name for just those."
        );
        expect(noteFor({ unread: ["rechiseled"] }, 0)).toBe(
            "Could not read the items rechiseled adds. They can still be typed as ids."
        );
        expect(noteFor({}, 0)).toBeNull();
    });

    it("searches a modded item by its mod as well as its name", () => {
        const items: ModItemView[] = [
            {
                id: "securitycraft:keycard_lv1",
                label: "Level 1 Keycard",
                mod: "security-craft",
                build,
                icon: null
            }
        ];
        const [entry] = modCatalogItems(items);
        expect(entry?.search).toContain("security-craft");
        expect(entry?.search).toContain("keycard_lv1");
        expect(entry?.from).toBe("security-craft");
        // Behind the vanilla entry of the same name.
        expect(entry?.rank).toBe(1);
    });

    it("addresses a kept picture through the server it was read for", () => {
        const picture = modItemPicture(
            {
                id: "securitycraft:keycard_lv1",
                label: "Level 1 Keycard",
                mod: "security-craft",
                build,
                icon: { kind: "mod", name: "securitycraft.item.keycard_lv1", width: 16, height: 16 }
            },
            "8f1b6b2e-0000-4000-8000-000000000000",
            new Set()
        );
        expect(picture?.url).toBe(
            `/api/apps/installed/8f1b6b2e-0000-4000-8000-000000000000/minecraft/items/icon?build=${build}&name=securitycraft.item.keycard_lv1`
        );
    });

    it("borrows the vanilla picture a mod's model points at", () => {
        const known = new Set(["stone", "quartz_block", "coal_ore"]);
        expect(vanillaTextureName("block/stone", known)).toBe("stone");
        // The set is rendered items, so a block face is looked for without it.
        expect(vanillaTextureName("block/quartz_block_side", known)).toBe("quartz_block");
        // And a name it does not cover draws nothing rather than a broken image.
        expect(vanillaTextureName("block/deepslate_emerald_ore", known)).toBeNull();

        const picture = modItemPicture(
            {
                id: "securitycraft:reinforced_stone",
                label: "Reinforced Stone",
                mod: "security-craft",
                build,
                icon: { kind: "vanilla", texture: "block/stone" }
            },
            "8f1b6b2e-0000-4000-8000-000000000000",
            known
        );
        expect(picture?.url).toBe("/mcicons/minecraft_stone.png");
    });

    it("draws a square picture whole and a strip as its first square", () => {
        expect(pictureFit({ url: "", width: 16, height: 16 })).toBeNull();
        // 80x16 is five variants side by side: the first one fills the slot.
        expect(pictureFit({ url: "", width: 80, height: 16 })).toEqual({
            width: "500%",
            height: "100%"
        });
        // 16x32 is two frames stacked: the top one.
        expect(pictureFit({ url: "", width: 16, height: 32 })).toEqual({
            width: "100%",
            height: "200%"
        });
    });
});

/**
 * Which file a mod on the list actually is.
 *
 * The same three questions the next restart asks - the loader, the release, and
 * whether the entry admits a build that has not finished - answered with the file
 * rather than with its number, because what the reader opens is the file. An
 * entry nailed to a version is the case worth asserting: reading a newer jar than
 * the server installs would offer items that server does not have.
 */
describe("the build a jar is read from", () => {
    const sha1 = "d45f4a0290360cc5bcbe241cd35785a8085d1d1b";

    function answer(builds: unknown): void {
        forgetModrinthAnswers();
        vi.stubGlobal("fetch", async () => ({
            ok: true,
            status: 200,
            json: async () => builds
        }));
    }

    const file = (name: string, extra: Record<string, unknown> = {}) => ({
        url: `https://cdn.modrinth.com/data/v8jzRtAt/versions/x/${name}`,
        filename: name,
        primary: true,
        size: 5102536,
        hashes: { sha1 },
        ...extra
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        forgetModrinthAnswers();
    });

    it("takes the newest build that fits, with the file to read", async () => {
        answer([
            { id: "MV471ZmP", version_number: "v1.10.1", version_type: "release", game_versions: ["1.21.4"], files: [file("SecurityCraft v1.10.1.jar")] },
            { id: "older", version_number: "v1.10.0", version_type: "release", game_versions: ["1.21.4"], files: [file("SecurityCraft v1.10.0.jar")] }
        ]);
        const build = await buildFor("security-craft", "neoforge", "1.21.4");
        expect(build?.version).toBe("v1.10.1");
        expect(build?.sha1).toBe(sha1);
        expect(build?.filename).toBe("SecurityCraft v1.10.1.jar");
    });

    it("reads a project that has published more builds than the list is cut to", async () => {
        // JEI, Create and Fabric API all answer with hundreds of builds for one
        // loader: a list long enough to refuse is the common case, not the odd
        // one, and refusing it reported the most popular mods as unreadable.
        answer([
            { id: "newest", version_number: "v1.10.1", version_type: "release", game_versions: ["1.21.4"], files: [file("SecurityCraft v1.10.1.jar")] },
            ...Array.from({ length: 400 }, (_, index) => ({
                id: `old-${index}`,
                version_number: `v1.0.${index}`,
                version_type: "release",
                game_versions: ["1.21.4"],
                files: [file(`old-${index}.jar`)]
            }))
        ]);
        expect((await buildFor("security-craft", "neoforge", "1.21.4"))?.version).toBe("v1.10.1");
    });

    it("reads the build an entry is pinned to rather than the newest", async () => {
        answer([
            { id: "new", version_number: "v1.10.1", version_type: "release", game_versions: ["1.21.4"], files: [file("new.jar")] },
            { id: "pinned", version_number: "v1.9.0", version_type: "release", game_versions: ["1.21.4"], files: [file("pinned.jar")] }
        ]);
        expect((await buildFor("security-craft:v1.9.0", "neoforge", "1.21.4"))?.filename).toBe("pinned.jar");
    });

    it("leaves alone a build for another release, and one the entry does not admit", async () => {
        answer([
            { id: "a", version_number: "v2", version_type: "release", game_versions: ["1.21.6"], files: [file("other.jar")] }
        ]);
        expect(await buildFor("security-craft", "neoforge", "1.21.4")).toBeNull();

        answer([
            { id: "b", version_number: "v2", version_type: "beta", game_versions: ["1.21.4"], files: [file("beta.jar")] }
        ]);
        expect(await buildFor("security-craft", "neoforge", "1.21.4")).toBeNull();
        expect((await buildFor("security-craft:beta", "neoforge", "1.21.4"))?.filename).toBe("beta.jar");
    });

    it("refuses a file that is not on their own CDN, or has no hash to name it by", async () => {
        answer([
            {
                id: "a",
                version_number: "v1",
                version_type: "release",
                game_versions: ["1.21.4"],
                files: [{ ...file("elsewhere.jar"), url: "https://example.invalid/elsewhere.jar" }]
            }
        ]);
        expect(await buildFor("security-craft", "neoforge", "1.21.4")).toBeNull();

        answer([
            {
                id: "a",
                version_number: "v1",
                version_type: "release",
                game_versions: ["1.21.4"],
                files: [{ ...file("nohash.jar"), hashes: {} }]
            }
        ]);
        expect(await buildFor("security-craft", "neoforge", "1.21.4")).toBeNull();
    });
});
