/**
 * Pictures chosen by what an item carries rather than by its id.
 *
 * Every TaCZ gun is `tacz:modern_kinetic_gun` with a `GunId` in its tag, every
 * round `tacz:ammo` with an `AmmoId`, every scope `tacz:attachment` with an
 * `AttachmentId`, and the slot picture follows the tag. The packs below are laid
 * out the way TaCZ 1.1.x lays them out - `data/<ns>/index/<kind>/`, a display
 * under `assets/<ns>/display/<kind>/` whose `slot` names the texture - once
 * inside a mod jar and once as a folder in `/data/tacz`. Ids and names are
 * fixtures.
 */

import JSZip from "jszip";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { mkdtemp } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const folder = await mkdtemp(join(tmpdir(), "polaris-mod-variants-"));
process.env.POLARIS_DATA_DIR = folder;
process.env.POLARIS_DATABASE_URL ??= "postgresql://polaris:polaris@localhost:5432/polaris";
process.env.POLARIS_AUTH_SECRET ??= "a-long-enough-string-for-the-schema";
process.env.POLARIS_MASTER_KEY ??= Buffer.alloc(32, 7).toString("base64");

const { readJarItems } = await import("@polaris-app/game-servers/src/lib/minecraft/mod-items");
const { readGunPacks } =
    await import("@polaris-app/game-servers/src/lib/minecraft/mod-items-service");
const { itemTagString } = await import("@polaris-app/game-servers/src/lib/minecraft/inventory");
const { readModVariants } = await import("@polaris-app/game-servers/src/lib/minecraft/items");

type JarFiles = Parameters<typeof readJarItems>[0];
type GunPackFolder = Parameters<typeof readGunPacks>[0];

function png(width: number, height: number): Uint8Array {
    const chunk = (type: string, body: Buffer): Buffer => {
        const head = Buffer.alloc(8);
        head.writeUInt32BE(body.length, 0);
        head.write(type, 4, "ascii");
        return Buffer.concat([head, body, Buffer.alloc(4)]);
    };
    const header = Buffer.alloc(13);
    header.writeUInt32BE(width, 0);
    header.writeUInt32BE(height, 4);
    header[8] = 8;
    header[9] = 6;
    return new Uint8Array(
        Buffer.concat([
            Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
            chunk("IHDR", header),
            chunk("IDAT", deflateSync(Buffer.alloc(height * (width * 4 + 1)))),
            chunk("IEND", Buffer.alloc(0))
        ])
    );
}

async function jarOf(files: Record<string, string | Uint8Array>): Promise<JarFiles> {
    const zip = new JSZip();
    for (const [path, body] of Object.entries(files)) zip.file(path, body);
    const read = await JSZip.loadAsync(await zip.generateAsync({ type: "uint8array" }));
    return {
        paths: Object.keys(read.files),
        read: async (path: string) => {
            const entry = read.files[path];
            return entry && !entry.dir ? entry.async("uint8array") : null;
        }
    };
}

/** One gun pack's files, under `root`. */
function pack(root: string, ns: string, gun: string): Record<string, string | Uint8Array> {
    return {
        [`${root}gunpack.meta.json`]: JSON.stringify({ namespace: ns }),
        [`${root}data/${ns}/index/guns/${gun}.json`]: JSON.stringify({
            name: `${ns}.gun.${gun}.name`,
            display: `${ns}:${gun}_display`,
            type: "rifle"
        }),
        [`${root}assets/${ns}/display/guns/${gun}_display.json`]: JSON.stringify({
            model: `${ns}:gun/${gun}_geo`,
            slot: `${ns}:gun/slot/${gun}`
        }),
        [`${root}assets/${ns}/textures/gun/slot/${gun}.png`]: png(48, 16)
    };
}

const DEFAULT_PACK = "assets/tacz/custom/fixture_default_gun/";
const TACZ_JAR = {
    "META-INF/mods.toml": 'modId="tacz"\n',
    ...pack(DEFAULT_PACK, "tacz", "fixture_rifle"),
    [`${DEFAULT_PACK}data/tacz/index/ammo/fixture_round.json`]: JSON.stringify({
        display: "tacz:fixture_round_display"
    }),
    [`${DEFAULT_PACK}assets/tacz/display/ammo/fixture_round_display.json`]: JSON.stringify({
        slot: "tacz:ammo/slot/fixture_round"
    }),
    [`${DEFAULT_PACK}assets/tacz/textures/ammo/slot/fixture_round.png`]: png(16, 16),
    [`${DEFAULT_PACK}data/tacz/index/attachments/fixture_grip.json`]: JSON.stringify({
        display: "tacz:fixture_grip_display"
    }),
    [`${DEFAULT_PACK}assets/tacz/display/attachments/fixture_grip_display.json`]: JSON.stringify({
        slot: "tacz:attachment/slot/fixture_grip"
    }),
    [`${DEFAULT_PACK}assets/tacz/textures/attachment/slot/fixture_grip.png`]: png(16, 16),
    // An entry whose display names a picture the pack does not carry.
    [`${DEFAULT_PACK}data/tacz/index/guns/fixture_missing.json`]: JSON.stringify({
        display: "tacz:fixture_missing_display"
    }),
    [`${DEFAULT_PACK}assets/tacz/display/guns/fixture_missing_display.json`]: JSON.stringify({
        slot: "tacz:gun/slot/fixture_missing"
    })
};

describe("TaCZ gun pack variants", () => {
    it("reads the gun, ammo and attachment slot pictures of a pack inside a mod jar", async () => {
        const { variants, icons } = await readJarItems(await jarOf(TACZ_JAR));
        expect(variants).toEqual(
            [
                {
                    item: null,
                    key: "GunId",
                    value: "tacz:fixture_missing",
                    icon: expect.anything()
                },
                {
                    item: null,
                    key: "GunId",
                    value: "tacz:fixture_rifle",
                    icon: {
                        kind: "mod",
                        name: "tacz.gun.slot.fixture_rifle",
                        width: 48,
                        height: 16
                    }
                },
                {
                    item: "tacz:ammo",
                    key: "AmmoId",
                    value: "tacz:fixture_round",
                    icon: {
                        kind: "mod",
                        name: "tacz.ammo.slot.fixture_round",
                        width: 16,
                        height: 16
                    }
                },
                {
                    item: "tacz:attachment",
                    key: "AttachmentId",
                    value: "tacz:fixture_grip",
                    icon: {
                        kind: "mod",
                        name: "tacz.attachment.slot.fixture_grip",
                        width: 16,
                        height: 16
                    }
                }
            ].filter((variant) => variant.value !== "tacz:fixture_missing")
        );
        expect([...icons.keys()].sort()).toEqual([
            "tacz.ammo.slot.fixture_round",
            "tacz.attachment.slot.fixture_grip",
            "tacz.gun.slot.fixture_rifle"
        ]);
    });

    it("reads a third-party pack folder in /data/tacz, and only once", async () => {
        const files = pack("Fixture Pack [v1]/", "fixturepack", "fixture_carbine");
        let reads = 0;
        const fake: GunPackFolder = {
            list: async () => ({
                zips: [],
                whole: true,
                // Pictures are not listed; a display names its own.
                files: Object.keys(files)
                    .filter((path) => !path.endsWith(".png"))
                    .map((path) => ({ path, size: 10, modified: "1700000000.0" }))
            }),
            readZip: async () => null,
            readFile: async (path) => {
                reads += 1;
                const body = files[path];
                return body === undefined
                    ? null
                    : typeof body === "string"
                      ? Buffer.from(body)
                      : body;
            }
        };
        const first = await readGunPacks(fake, Date.now() + 10_000);
        expect(first?.unread).toEqual([]);
        expect(first?.catalogs[0]?.variants).toEqual([
            {
                item: null,
                key: "GunId",
                value: "fixturepack:fixture_carbine",
                icon: {
                    kind: "mod",
                    name: "fixturepack.gun.slot.fixture_carbine",
                    width: 48,
                    height: 16
                }
            }
        ]);
        const before = reads;
        const second = await readGunPacks(fake, Date.now() + 10_000);
        expect(second?.catalogs[0]?.variants).toHaveLength(1);
        expect(reads).toBe(before);
    });

    it("carries variants through the route's answer and drops malformed ones", () => {
        const build = "a".repeat(40);
        const read = readModVariants({
            variants: [
                {
                    item: null,
                    key: "GunId",
                    value: "tacz:m",
                    build,
                    icon: { kind: "mod", name: "tacz.gun.slot.m", width: 16, height: 16 }
                },
                { item: null, key: "Gun Id", value: "tacz:m", build, icon: null }
            ]
        });
        expect(read).toHaveLength(1);
        expect(read[0]?.build).toBe(build);
    });
});

describe("an item drawn in code", () => {
    it("falls back to the item's flat texture when its custom-loader model names none", async () => {
        const { items } = await readJarItems(
            await jarOf({
                "assets/fixturebags/lang/en_us.json": JSON.stringify({
                    "item.fixturebags.bag": "Bag",
                    "item.fixturebags.pouch": "Pouch"
                }),
                "assets/fixturebags/models/item/bag.json": JSON.stringify({
                    parent: "fixturebags:block/bag"
                }),
                "assets/fixturebags/models/block/bag.json": JSON.stringify({
                    loader: "fixturebags:bag"
                }),
                "assets/fixturebags/textures/item/bag.png": png(16, 16),
                // Same shape with no flat texture: still the neutral tile, never a guess.
                "assets/fixturebags/models/item/pouch.json": JSON.stringify({
                    parent: "fixturebags:block/pouch"
                }),
                "assets/fixturebags/models/block/pouch.json": JSON.stringify({
                    loader: "fixturebags:bag"
                })
            })
        );
        expect(items.find((item) => item.id === "fixturebags:bag")?.icon).toEqual({
            kind: "mod",
            name: "fixturebags.item.bag",
            width: 16,
            height: 16
        });
        expect(items.find((item) => item.id === "fixturebags:pouch")?.icon).toBeNull();
    });
});

describe("reading a tag value", () => {
    it("finds a string at the top of a 1.20 tag and inside custom data", () => {
        expect(itemTagString('{GunId:"tacz:m4a1",GunFireMode:"AUTO",Damage:0}', "GunId")).toBe(
            "tacz:m4a1"
        );
        expect(
            itemTagString(
                '{"minecraft:custom_data":{AmmoId:"tacz:308"},"minecraft:damage":0}',
                "AmmoId"
            )
        ).toBe("tacz:308");
        expect(itemTagString("{Damage:3}", "GunId")).toBeNull();
        expect(itemTagString("{GunId:3b}", "GunId")).toBeNull();
    });
});
