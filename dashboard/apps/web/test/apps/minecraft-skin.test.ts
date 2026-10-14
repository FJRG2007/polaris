/**
 * Player skins: what counts as a skin file, where one can come from, and the
 * signed lines the mod takes - an unsigned value would show the default skin to
 * everybody but the player, so none is ever produced.
 */

import { describe, expect, it } from "vitest";
import * as skin from "@polaris-app/game-servers/src/lib/minecraft/skin";
import { COMMAND_BYTES_MAX, commandBytes } from "@polaris-app/game-servers/src/lib/minecraft/command-size";

const HASH = "a".repeat(64);

function packed(url: string, slim = false): string {
    const textures = { SKIN: { url, ...(slim ? { metadata: { model: "slim" } } : {}) } };
    return Buffer.from(
        JSON.stringify({ timestamp: 1, profileId: "0".repeat(32), profileName: "player-one", textures })
    ).toString("base64");
}

const VALUE = packed(`http://textures.minecraft.net/texture/${HASH}`, true);
// A 4096-bit signature is 512 bytes: 684 characters of base64.
const SIGNATURE = Buffer.alloc(512, 7).toString("base64");

function png(width: number, height: number): Uint8Array {
    const bytes = new Uint8Array(40);
    bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    bytes.set([0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52], 8);
    const view = new DataView(bytes.buffer);
    view.setUint32(16, width);
    view.setUint32(20, height);
    return bytes;
}

describe("checkSkinPng", () => {
    it("takes 64x64 and 64x32 by their header", () => {
        expect(skin.checkSkinPng(png(64, 64))).toEqual({ ok: true, width: 64, height: 64 });
        expect(skin.checkSkinPng(png(64, 32))).toEqual({ ok: true, width: 64, height: 32 });
    });

    it("refuses other sizes, other formats and oversized files", () => {
        expect(skin.checkSkinPng(png(128, 128))).toEqual({ ok: false, problem: "wrongSize" });
        expect(skin.checkSkinPng(new TextEncoder().encode("GIF89a not a png at all, padded out"))).toEqual({
            ok: false,
            problem: "notPng"
        });
        expect(skin.checkSkinPng(new Uint8Array(skin.SKIN_MAX_BYTES + 1))).toEqual({
            ok: false,
            problem: "tooBig"
        });
    });
});

describe("classifySource", () => {
    it("sorts a name, a texture link, a profile page and a plain link", () => {
        expect(skin.classifySource(" player_one ")).toEqual({ kind: "player", name: "player_one" });
        expect(skin.classifySource(`https://textures.minecraft.net/texture/${HASH}`)).toEqual({
            kind: "texture",
            hash: HASH
        });
        expect(skin.classifySource("https://namemc.com/profile/player_one.1")).toEqual({
            kind: "player",
            name: "player_one"
        });
        expect(skin.classifySource("skins.example.test/skin.png")).toEqual({
            kind: "link",
            url: "https://skins.example.test/skin.png"
        });
        expect(skin.classifySource("ftp://example.test/skin.png")).toBeNull();
    });
});

describe("pageSkinLinks", () => {
    it("puts Mojang textures first, then PNG links resolved against the page", () => {
        const html = `<img src="/skins/a.png"><a href="https://textures.minecraft.net/texture/${HASH}">t</a>`;
        expect(skin.pageSkinLinks(html, "https://skins.example.test/page")).toEqual([
            `https://textures.minecraft.net/texture/${HASH}`,
            "https://skins.example.test/skins/a.png"
        ]);
    });
});

describe("signed skins", () => {
    it("reads the signed property of a Mojang profile and refuses an unsigned one", () => {
        const signed = { properties: [{ name: "textures", value: VALUE, signature: SIGNATURE }] };
        expect(skin.profileSkin(signed)).toEqual({ value: VALUE, signature: SIGNATURE });
        expect(skin.profileSkin({ properties: [{ name: "textures", value: VALUE }] })).toBeNull();
    });

    it("reads a signing service's reply", () => {
        const reply = { skin: { texture: { data: { value: VALUE, signature: SIGNATURE } } } };
        expect(skin.generatedSkin(reply)).toEqual({ value: VALUE, signature: SIGNATURE });
        expect(skin.generatedSkin({ skin: {} })).toBeNull();
    });

    it("refuses a value that points anywhere but Mojang's texture host", () => {
        const elsewhere = packed(`http://skins.example.test/texture/${HASH}`);
        expect(skin.signedSkin({ value: elsewhere, signature: SIGNATURE })).toBeNull();
        expect(skin.decodeSkinValue(VALUE)).toEqual({ hash: HASH, model: "slim" });
    });

    it("stages the value and signs it off in two lines that each fit one command", () => {
        const lines = skin.skinCommands("player_one", { value: VALUE, signature: SIGNATURE });
        expect(lines[0]).toBe(`polaris skin stage player_one ${VALUE}`);
        expect(lines[1]).toBe(`polaris skin apply player_one ${SIGNATURE}`);
        for (const line of lines) expect(commandBytes(line)).toBeLessThanOrEqual(COMMAND_BYTES_MAX);
        expect(() => skin.skinCommands("player one", { value: VALUE, signature: SIGNATURE })).toThrow();
    });
});

describe("parseSkinReply", () => {
    it("reads what the mod answered, signed or not", () => {
        expect(
            skin.parseSkinReply(`{"ok":true,"player":"player_one","hash":"${HASH}","model":"slim","signed":true}`)
        ).toEqual({ ok: true, skin: { hash: HASH, model: "slim", signed: true } });
        expect(skin.parseSkinReply(`{"ok":true,"player":"player_one"}`)).toEqual({ ok: true, skin: null });
        expect(skin.parseSkinReply(`{"ok":false,"why":"offline"}`)).toEqual({ ok: false, why: "offline" });
        expect(skin.parseSkinReply("Unknown command")).toBeNull();
    });
});

describe("export names", () => {
    it("carries the model in the file name and reads it back", () => {
        expect(skin.exportFileName("player_one", "slim")).toBe("player_one.slim.png");
        expect(skin.modelFromFileName("player_one.slim.png")).toBe("slim");
        expect(skin.modelFromFileName("skin.png")).toBeNull();
    });
});
