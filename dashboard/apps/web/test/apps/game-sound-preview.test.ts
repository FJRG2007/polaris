/**
 * Hearing an Announce sound before sending it: fetched from where the game's own
 * launcher gets it, and only the sounds that screen offers.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

const OGG = new Uint8Array([0x4f, 0x67, 0x67, 0x53]);
const asked: string[] = [];

function reply(url: string): Response {
    asked.push(url);
    const body = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });
    if (url.endsWith("version_manifest_v2.json")) {
        return body({
            latest: { release: "26.3" },
            versions: [{ id: "26.3", url: "https://piston-meta.mojang.com/v/26.3.json" }]
        });
    }
    if (url.endsWith("/v/26.3.json"))
        return body({ assetIndex: { url: "https://piston-meta.mojang.com/index.json" } });
    if (url.endsWith("/index.json")) {
        return body({
            objects: {
                "minecraft/sounds.json": { hash: "aa11", size: 10 },
                "minecraft/sounds/note/pling.ogg": { hash: "bb22", size: 4 }
            }
        });
    }
    if (url.endsWith("/aa/aa11"))
        return body({ "block.note_block.pling": { sounds: ["note/pling"] } });
    if (url.endsWith("/bb/bb22")) return new Response(OGG, { status: 200 });
    return new Response(null, { status: 404 });
}

afterEach(() => {
    vi.unstubAllGlobals();
    asked.length = 0;
});

describe("a sound to hear before sending", () => {
    it("is fetched from Mojang's own asset index, once", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async (url: string) => reply(url))
        );
        const { soundPreview } = await import(
            "@polaris-app/game-servers/src/lib/minecraft/sound-preview"
        );
        expect(await soundPreview("minecraft:block.note_block.pling")).toEqual(OGG);
        const first = asked.length;
        expect(await soundPreview("minecraft:block.note_block.pling")).toEqual(OGG);
        expect(asked.length).toBe(first);
        expect(
            asked.every((url) =>
                /^https:\/\/(piston-meta\.mojang\.com|resources\.download\.minecraft\.net)\//.test(
                    url
                )
            )
        ).toBe(true);
    });

    it("fetches nothing for a sound the screen does not offer", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async (url: string) => reply(url))
        );
        const { soundPreview } = await import(
            "@polaris-app/game-servers/src/lib/minecraft/sound-preview"
        );
        expect(await soundPreview("minecraft:entity.creeper.primed")).toBeNull();
        expect(await soundPreview("https://example.com/x.ogg")).toBeNull();
        expect(asked).toEqual([]);
    });
});
