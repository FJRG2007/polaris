/**
 * Player skins: what counts as one, where one can come from, and the lines the
 * Polaris mod is told and answers with.
 *
 * A server in offline mode gets no skin from Mojang, so the Polaris mod puts one
 * on the profile itself. Since 1.20.2 the client draws another player's skin only
 * when the profile's `textures` property carries Mojang's signature; an unsigned
 * one shows the default skin to everybody else. So what is applied is always a
 * signed value: a Mojang profile's own (asked for with `unsigned=false`), or one
 * a skin-signing service returned for an uploaded PNG. Value and signature go to
 * the mod on two lines, since together they are longer than one command may be,
 * both under one token so a change made at the same time cannot cross them.
 */

import { z } from "zod";
import { stripFormatting } from "./parse";
import { COMMAND_BYTES_MAX, commandBytes } from "./command-size";

export const SKIN_MODELS = ["classic", "slim"] as const;
export type SkinModel = (typeof SKIN_MODELS)[number];

/** The mod's capability name for the skin commands. */
export const SKIN_CAP = "skin";

/** Far above any real skin (a few KB), and small enough to hold in memory. */
export const SKIN_MAX_BYTES = 256 * 1024;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export type SkinProblem = "notPng" | "wrongSize" | "tooBig";

/** Whether these bytes are a PNG skin: the signature, then a 64x64 or 64x32 header. */
export function checkSkinPng(
    bytes: Uint8Array
): { ok: true; width: 64; height: 64 | 32 } | { ok: false; problem: SkinProblem } {
    if (bytes.length > SKIN_MAX_BYTES) return { ok: false, problem: "tooBig" };
    if (bytes.length < 33 || PNG_SIGNATURE.some((byte, at) => bytes[at] !== byte))
        return { ok: false, problem: "notPng" };
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const chunk = String.fromCharCode(bytes[12]!, bytes[13]!, bytes[14]!, bytes[15]!);
    if (chunk !== "IHDR") return { ok: false, problem: "notPng" };
    const width = view.getUint32(16);
    const height = view.getUint32(20);
    if (width !== 64 || (height !== 64 && height !== 32))
        return { ok: false, problem: "wrongSize" };
    return { ok: true, width: 64, height };
}

const TEXTURE_HOST = "textures.minecraft.net";
const HASH = /^[0-9a-f]{16,128}$/;
const TEXTURE_LINK = /textures\.minecraft\.net\/texture\/([0-9a-fA-F]{16,128})/;
const PLAYER_NAME = /^[A-Za-z0-9_]{1,16}$/;

/** The Mojang texture a link names, or null. */
export function textureHashOf(link: string): string | null {
    const match = TEXTURE_LINK.exec(link);
    return match ? match[1]!.toLowerCase() : null;
}

export function textureUrl(hash: string): string {
    return `https://${TEXTURE_HOST}/texture/${hash}`;
}

export function isTextureHash(value: string): boolean {
    return HASH.test(value);
}

/** What somebody typed into the import box, sorted into where to look. */
export type SkinSource =
    | { readonly kind: "player"; readonly name: string }
    | { readonly kind: "texture"; readonly hash: string }
    | { readonly kind: "link"; readonly url: string };

export function classifySource(input: string): SkinSource | null {
    const text = input.trim();
    if (PLAYER_NAME.test(text)) return { kind: "player", name: text };
    const hash = textureHashOf(text);
    if (hash) return { kind: "texture", hash };
    // Another scheme is refused, not read as a host named after it.
    if (/^[a-z][a-z0-9+.-]*:/i.test(text) && !/^https?:\/\//i.test(text)) return null;
    let url: URL;
    try {
        url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
    } catch {
        return null;
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    // A profile page names a player: their skin is the one Mojang has.
    const profile = /^\/profile\/([A-Za-z0-9_]{1,16})(?:[./]|$)/.exec(url.pathname);
    if (/(^|\.)namemc\.com$/i.test(url.hostname) && profile)
        return { kind: "player", name: profile[1]! };
    return { kind: "link", url: url.toString() };
}

/** The skin links a page offers, best first: Mojang textures, then PNG links. */
export function pageSkinLinks(html: string, base: string): string[] {
    const found: string[] = [];
    const add = (link: string) => {
        if (!found.includes(link)) found.push(link);
    };
    for (const match of html.matchAll(/textures\.minecraft\.net\/texture\/([0-9a-fA-F]{16,128})/g))
        add(textureUrl(match[1]!.toLowerCase()));
    for (const match of html.matchAll(/(?:href|src)\s*=\s*["']([^"']+)["']/gi)) {
        const raw = match[1]!.replace(/&amp;/g, "&");
        if (!/\.png(?:[?#]|$)|\/download\b/i.test(raw)) continue;
        try {
            add(new URL(raw, base).toString());
        } catch {
            // Not a link.
        }
    }
    return found.slice(0, 6);
}

/** A `textures` property as Mojang signed it. */
export interface SignedSkin {
    readonly value: string;
    readonly signature: string;
}

const BASE64 = /^[A-Za-z0-9+/]{16,4096}={0,2}$/;

/** The signed skin a Mojang profile reply (`?unsigned=false`) carries, or null. */
export function profileSkin(profile: unknown): SignedSkin | null {
    const parsed = z
        .object({
            properties: z.array(
                z.object({ name: z.string(), value: z.string(), signature: z.string().optional() })
            )
        })
        .safeParse(profile);
    if (!parsed.success) return null;
    const packed = parsed.data.properties.find((property) => property.name === "textures");
    if (!packed?.signature) return null;
    return signedSkin({ value: packed.value, signature: packed.signature });
}

/** The signed skin a signing service answered with (`skin.texture.data`), or null. */
export function generatedSkin(reply: unknown): SignedSkin | null {
    const parsed = z
        .object({
            skin: z.object({
                texture: z.object({ data: z.object({ value: z.string(), signature: z.string() }) })
            })
        })
        .safeParse(reply);
    return parsed.success ? signedSkin(parsed.data.skin.texture.data) : null;
}

/** The pair, when both are base64 and the value names a Mojang texture. */
export function signedSkin(pair: { value: string; signature: string }): SignedSkin | null {
    if (!BASE64.test(pair.value) || !BASE64.test(pair.signature)) return null;
    return decodeSkinValue(pair.value) ? { value: pair.value, signature: pair.signature } : null;
}

/** The texture hash and arm model a packed value names, or null. */
export function decodeSkinValue(value: string): { hash: string; model: SkinModel } | null {
    try {
        return texturesSkin(JSON.parse(Buffer.from(value, "base64").toString("utf8")));
    } catch {
        return null;
    }
}

const texturesSchema = z.object({
    textures: z.object({
        SKIN: z
            .object({
                url: z.string(),
                metadata: z.object({ model: z.string() }).partial().optional()
            })
            .optional()
    })
});

function texturesSkin(payload: unknown): { hash: string; model: SkinModel } | null {
    const parsed = texturesSchema.safeParse(payload);
    const skin = parsed.success ? parsed.data.textures.SKIN : undefined;
    const hash = skin ? textureHashOf(skin.url) : null;
    if (!skin || !hash) return null;
    return { hash, model: skin.metadata?.model === "slim" ? "slim" : "classic" };
}

const STAGE_TOKEN = /^[0-9a-f]{8,32}$/;

/** A fresh token tying a staged value to the line that signs it off. */
export function stageToken(): string {
    return crypto.randomUUID().replace(/-/g, "").slice(0, 16);
}

/** The mod's lines for a skin: the value staged, then signed off, under one token. */
export function skinCommands(
    player: string,
    skin: SignedSkin,
    token: string = stageToken()
): [string, string] {
    if (!PLAYER_NAME.test(player)) throw new Error("Not a player name");
    if (!STAGE_TOKEN.test(token)) throw new Error("Not a stage token");
    if (!signedSkin(skin)) throw new Error("Not a signed skin");
    const lines: [string, string] = [
        `polaris skin stage ${player} ${token} ${skin.value}`,
        `polaris skin apply ${player} ${token} ${skin.signature}`
    ];
    if (lines.some((line) => commandBytes(line) > COMMAND_BYTES_MAX))
        throw new Error("Skin too long for one command");
    return lines;
}

export function skinClearCommand(player: string): string {
    if (!PLAYER_NAME.test(player)) throw new Error("Not a player name");
    return `polaris skin clear ${player}`;
}

export function skinReadCommand(player: string): string {
    if (!PLAYER_NAME.test(player)) throw new Error("Not a player name");
    return `polaris skin get ${player}`;
}

/** What the mod answered about a player's skin. */
export type SkinReply =
    | {
          readonly ok: true;
          readonly skin: { hash: string; model: SkinModel; signed: boolean } | null;
          /** Not on the server: the skin is what is kept for their next join. */
          readonly offline?: true;
      }
    | { readonly ok: false; readonly why: string };

const replySchema = z.union([
    z.object({
        ok: z.literal(true),
        hash: z.string().regex(HASH).optional(),
        model: z.enum(SKIN_MODELS).optional(),
        signed: z.boolean().optional(),
        offline: z.boolean().optional()
    }),
    z.object({ ok: z.literal(false), why: z.string().max(40) })
]);

export function parseSkinReply(reply: string): SkinReply | null {
    const text = stripFormatting(reply).trim();
    const start = text.indexOf("{");
    if (start < 0) return null;
    let value: unknown;
    try {
        value = JSON.parse(text.slice(start, text.lastIndexOf("}") + 1));
    } catch {
        return null;
    }
    const parsed = replySchema.safeParse(value);
    if (!parsed.success) return null;
    if (!parsed.data.ok) return { ok: false, why: parsed.data.why };
    return {
        ok: true,
        skin: parsed.data.hash
            ? {
                  hash: parsed.data.hash,
                  model: parsed.data.model ?? "classic",
                  signed: parsed.data.signed ?? false
              }
            : null,
        ...(parsed.data.offline ? { offline: true as const } : {})
    };
}

/** The name an exported skin is saved under; the model rides in it. */
export function exportFileName(player: string, model: SkinModel): string {
    return `${player.replace(/[^A-Za-z0-9_]/g, "") || "skin"}.${model}.png`;
}

/** The model an exported file names, if it was one of ours. */
export function modelFromFileName(name: string): SkinModel | null {
    const match = /\.(classic|slim)\.png$/i.exec(name);
    return match ? (match[1]!.toLowerCase() as SkinModel) : null;
}
