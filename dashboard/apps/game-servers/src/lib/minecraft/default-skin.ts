/**
 * The skin the game draws a player in when their profile has none of its own.
 *
 * Since Java Edition 1.19.3 that is not always the same character: the client
 * picks one of eighteen - nine characters, each with classic and slim arms - from
 * the player's UUID, so the same player looks the same on every machine. This is
 * that choice, made the way the client makes it, so the panel can show what the
 * game shows.
 *
 * Read from the client jar of release 26.3, class
 * `net.minecraft.client.resources.DefaultPlayerSkin`:
 *
 * - `<clinit>` fills `DEFAULT_SKINS` with the eighteen textures in the order of
 *   `DEFAULT_SKINS` below: the nine slim ones, then the nine wide ones.
 * - `get(UUID)` returns `DEFAULT_SKINS[Math.floorMod(uuid.hashCode(), 18)]`.
 * - `getDefaultSkin()` returns `DEFAULT_SKINS[6]`, the slim Steve, which is what
 *   an id that cannot be read falls back to here.
 *
 * `UUID.hashCode()` is the JDK's: `Long.hashCode(mostSigBits ^ leastSigBits)`,
 * the high and low 32 bits of that XOR folded together as a Java `int`.
 *
 * Pure, with no Node import, so a browser screen can call it. The textures are
 * resources/default-skins, shipped in this app's bundle (scripts/stage-assets.mjs).
 */

import type { SkinModel } from "./skin";

/** Where the staged default skins are served from. */
const DEFAULT_SKIN_BASE = "/api/app-bundles/game-servers/current/assets/default-skins";

/** The folder each arm model's textures live in, in the jar and in the bundle. */
const FOLDER: Record<SkinModel, string> = { classic: "wide", slim: "slim" };

const CHARACTERS = ["alex", "ari", "efe", "kai", "makena", "noor", "steve", "sunny", "zuri"] as const;

/** The client's `DEFAULT_SKINS`, in its order. The order is the whole contract. */
const DEFAULT_SKINS: readonly { name: string; model: SkinModel }[] = [
    ...CHARACTERS.map((name) => ({ name, model: "slim" as const })),
    ...CHARACTERS.map((name) => ({ name, model: "classic" as const }))
];

/** `getDefaultSkin()`: the slim Steve. */
const FALLBACK_INDEX = 6;

/** A UUID with or without its dashes, as profiles and the server files write it. */
const UUID_PATTERN = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;

export interface DefaultSkin {
    readonly name: string;
    readonly model: SkinModel;
    readonly path: string;
}

/**
 * Java's `UUID.hashCode()` for a UUID in text form, or null when it is not one.
 *
 * BigInt keeps the 64-bit halves exact; `asIntN(32, ...)` is Java's `(int)` cast,
 * wrapping instead of losing bits.
 */
export function uuidHashCode(uuid: string): number | null {
    const value = uuid.trim();
    if (!UUID_PATTERN.test(value)) return null;
    const hex = value.replace(/-/g, "");
    const hilo = BigInt(`0x${hex.slice(0, 16)}`) ^ BigInt(`0x${hex.slice(16)}`);
    return Number(BigInt.asIntN(32, (hilo >> 32n) ^ hilo));
}

/** Where `DEFAULT_SKINS` puts a UUID: `Math.floorMod(hash, 18)`. */
export function defaultSkinIndex(uuid: string): number {
    const hash = uuidHashCode(uuid);
    if (hash === null) return FALLBACK_INDEX;
    const size = DEFAULT_SKINS.length;
    return ((hash % size) + size) % size;
}

/** The default skin the game draws for a player's UUID, and where the panel serves it. */
export function defaultSkin(uuid: string): DefaultSkin {
    const { name, model } = DEFAULT_SKINS[defaultSkinIndex(uuid)]!;
    return { name, model, path: `${DEFAULT_SKIN_BASE}/${FOLDER[model]}/${name}.png` };
}
