/**
 * Player skins against the running server and the services a skin comes from.
 *
 * Where a skin can come from is worked out in ./skin, which the screen shares.
 * This side fetches: a player name from Mojang (whose profile is already signed),
 * a texture or a link as PNG bytes - a link somebody typed only ever through the
 * checked fetch, a page read for the skin links it offers - and a PNG that is
 * not signed yet from the signing service, which answers without a key at a
 * lower rate. Then the mod is told, and asked again what it now has, so what
 * the screen shows is what the server holds rather than what was sent.
 */

import * as skin from "./skin";
import { host } from "@polaris/app-host";
import type { ServerContainer } from "./service";
import { capabilities } from "./events/in-server";

const { follow, readCapped, safeUrl } = host.safeFetch;

const MOJANG_NAME = "https://api.mojang.com/users/profiles/minecraft/";
const MOJANG_PROFILE = "https://sessionserver.mojang.com/session/minecraft/profile/";
/** Takes a PNG as a data URL; keyless requests are served at a lower rate. */
export const SIGNING_URL = "https://api.mineskin.org/v2/generate";
const USER_AGENT = "Polaris/1.0";
const FIXED_TIMEOUT_MS = 10_000;
/** Signing waits in the service's queue, which takes a while when it is busy. */
const SIGNING_TIMEOUT_MS = 45_000;
/** A page read for the skin links it offers. */
const PAGE_MAX_BYTES = 1024 * 1024;

/** Why a skin could not be had, in words the screen has a sentence for. */
export type SkinFailure =
    | "unknownSource"
    | "noSuchPlayer"
    | "unreachable"
    | "noSkinThere"
    | "notPng"
    | "wrongSize"
    | "tooBig"
    | "signingBusy"
    | "signingFailed";

export class SkinError extends Error {
    constructor(
        readonly failure: SkinFailure,
        readonly retryAfterSeconds?: number
    ) {
        super(failure);
        this.name = "SkinError";
    }
}

/** A skin ready to show: the PNG, its model, and the signed value when one came with it. */
export interface SkinPreview {
    readonly png: Uint8Array;
    readonly model: skin.SkinModel;
    readonly signed: skin.SignedSkin | null;
}

async function fixedFetch(url: string, init: RequestInit = {}, timeoutMs = FIXED_TIMEOUT_MS) {
    return fetch(url, {
        ...init,
        headers: { "user-agent": USER_AGENT, ...(init.headers ?? {}) },
        signal: AbortSignal.timeout(timeoutMs)
    }).catch(() => {
        throw new SkinError("unreachable");
    });
}

async function boundedBytes(response: Response, max: number): Promise<Uint8Array> {
    const declared = Number(response.headers.get("content-length") ?? 0);
    if (declared > max) throw new SkinError("tooBig");
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length > max) throw new SkinError("tooBig");
    return bytes;
}

function checked(bytes: Uint8Array): Uint8Array {
    const verdict = skin.checkSkinPng(bytes);
    if (!verdict.ok) throw new SkinError(verdict.problem);
    return bytes;
}

async function texturePng(hash: string): Promise<Uint8Array> {
    const response = await fixedFetch(skin.textureUrl(hash));
    if (!response.ok) throw new SkinError("noSkinThere");
    return checked(await boundedBytes(response, skin.SKIN_MAX_BYTES));
}

/** A player's skin as Mojang holds it, signature and all. */
export async function mojangSkin(name: string): Promise<SkinPreview> {
    const found = await fixedFetch(`${MOJANG_NAME}${encodeURIComponent(name)}`);
    if (found.status === 204 || found.status === 404) throw new SkinError("noSuchPlayer");
    if (!found.ok) throw new SkinError("unreachable");
    const id = ((await found.json().catch(() => null)) as { id?: unknown } | null)?.id;
    if (typeof id !== "string" || !/^[0-9a-f]{32}$/i.test(id))
        throw new SkinError("noSuchPlayer");
    const profile = await fixedFetch(`${MOJANG_PROFILE}${id}?unsigned=false`);
    if (!profile.ok) throw new SkinError("unreachable");
    const signed = skin.profileSkin(await profile.json().catch(() => null));
    const named = signed ? skin.decodeSkinValue(signed.value) : null;
    if (!signed || !named) throw new SkinError("noSkinThere");
    return { png: await texturePng(named.hash), model: named.model, signed };
}

/** A link somebody typed: a PNG, or a page that offers one. Every hop checked. */
async function linkPng(address: string): Promise<Uint8Array> {
    const url = await safeUrl(address);
    if (!url) throw new SkinError("unknownSource");
    const response = await follow(url, "image/png,text/html;q=0.9,*/*;q=0.5");
    if (!response || !response.ok) throw new SkinError("unreachable");
    const type = response.headers.get("content-type") ?? "";
    if (!type.includes("html")) {
        const bytes = await readCapped(response, skin.SKIN_MAX_BYTES);
        if (!bytes) throw new SkinError("tooBig");
        return checked(bytes);
    }
    const page = await readCapped(response, PAGE_MAX_BYTES);
    if (!page) throw new SkinError("noSkinThere");
    const html = new TextDecoder().decode(page);
    for (const link of skin.pageSkinLinks(html, url.toString())) {
        const hash = skin.textureHashOf(link);
        if (hash) {
            const png = await texturePng(hash).catch(() => null);
            if (png) return png;
            continue;
        }
        const next = await safeUrl(link);
        const image = next ? await follow(next, "image/png") : null;
        const bytes = image?.ok ? await readCapped(image, skin.SKIN_MAX_BYTES) : null;
        if (bytes && skin.checkSkinPng(bytes).ok) return bytes;
    }
    throw new SkinError("noSkinThere");
}

/** What the import box was given, as a skin to show. */
export async function resolveSource(
    input: { kind: "file"; bytes: Uint8Array; model: skin.SkinModel | null } | { kind: "text"; text: string }
): Promise<SkinPreview> {
    if (input.kind === "file")
        return { png: checked(input.bytes), model: input.model ?? "classic", signed: null };
    const source = skin.classifySource(input.text);
    if (!source) throw new SkinError("unknownSource");
    if (source.kind === "player") return mojangSkin(source.name);
    const png = source.kind === "texture" ? await texturePng(source.hash) : await linkPng(source.url);
    return { png, model: "classic", signed: null };
}

/** Have the signing service sign a PNG, so other players see it too. */
export async function signPng(png: Uint8Array, model: skin.SkinModel): Promise<skin.SignedSkin> {
    checked(png);
    const response = await fixedFetch(
        SIGNING_URL,
        {
            method: "POST",
            headers: { "content-type": "application/json", accept: "application/json" },
            body: JSON.stringify({
                url: `data:image/png;base64,${Buffer.from(png).toString("base64")}`,
                variant: model,
                visibility: "unlisted"
            })
        },
        SIGNING_TIMEOUT_MS
    );
    if (response.status === 429) {
        const after = Number(response.headers.get("retry-after"));
        throw new SkinError("signingBusy", Number.isFinite(after) && after > 0 ? after : undefined);
    }
    const signed = response.ok ? skin.generatedSkin(await response.json().catch(() => null)) : null;
    if (!signed) throw new SkinError("signingFailed");
    return signed;
}

/** What the server says a player wears now. */
export type LiveSkin =
    | { readonly state: "unsupported" }
    | { readonly state: "unanswered" }
    | { readonly state: "refused"; readonly why: string }
    | {
          readonly state: "read";
          readonly skin: { hash: string; model: skin.SkinModel; signed: boolean } | null;
      };

export async function readLiveSkin(server: ServerContainer, player: string): Promise<LiveSkin> {
    if (!(await capabilities(server)).has(skin.SKIN_CAP)) return { state: "unsupported" };
    const reply = skin.parseSkinReply(
        await server.say([skin.skinReadCommand(player)]).catch(() => "")
    );
    if (!reply) return { state: "unanswered" };
    return reply.ok ? { state: "read", skin: reply.skin } : { state: "refused", why: reply.why };
}

/** Put a signed skin on a player, then read back what the server holds. */
export async function applySkin(
    server: ServerContainer,
    player: string,
    signed: skin.SignedSkin
): Promise<LiveSkin> {
    if (!(await capabilities(server)).has(skin.SKIN_CAP)) return { state: "unsupported" };
    const [stage, apply] = skin.skinCommands(player, signed);
    const staged = skin.parseSkinReply(await server.say([stage]));
    if (!staged) return { state: "unanswered" };
    if (!staged.ok) return { state: "refused", why: staged.why };
    const answer = skin.parseSkinReply(await server.say([apply]));
    if (answer && !answer.ok) return { state: "refused", why: answer.why };
    return readLiveSkin(server, player);
}

/** Take a player's skin off, back to what their account wears. */
export async function clearSkin(server: ServerContainer, player: string): Promise<LiveSkin> {
    if (!(await capabilities(server)).has(skin.SKIN_CAP)) return { state: "unsupported" };
    const answer = skin.parseSkinReply(await server.say([skin.skinClearCommand(player)]));
    if (answer && !answer.ok) return { state: "refused", why: answer.why };
    return readLiveSkin(server, player);
}
