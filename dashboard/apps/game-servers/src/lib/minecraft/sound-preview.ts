/**
 * Hearing a sound before sending it to everybody on a server.
 *
 * The sounds are Mojang's, so Polaris ships none of them. It fetches the one
 * asked for from where the game's own launcher does - the version manifest,
 * that release's asset index, the `sounds.json` that says which file an event
 * plays, and the file itself from the resources CDN - and keeps it in memory,
 * so the second press is instant and nothing is fetched twice.
 *
 * Only the sounds the Announce screen offers can be asked for. This is not a
 * way to make Polaris fetch an arbitrary URL, or an arbitrary asset: the id is
 * checked against that list before anything leaves the machine, and the only
 * hosts it ever reaches are Mojang's two.
 */

import { ANNOUNCE_SOUNDS } from "./announcement";

const MANIFEST = "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json";
const RESOURCES = "https://resources.download.minecraft.net";
const TIMEOUT_MS = 10_000;
/** The asset index barely changes; a release a day is generous. */
const INDEX_TTL_MS = 24 * 60 * 60 * 1000;
/** A sound effect is tens of kilobytes; anything past this is not one. */
const MOST_BYTES = 2 * 1024 * 1024;

interface SoundIndex {
    readonly objects: Record<string, { hash: string; size: number }>;
    readonly sounds: Record<string, { sounds?: (string | { name: string; type?: string })[] }>;
    readonly at: number;
}

let index: Promise<SoundIndex> | null = null;
const files = new Map<string, Uint8Array>();

async function json(url: string): Promise<unknown> {
    const answer = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!answer.ok) throw new Error(`Mojang answered ${answer.status}`);
    return answer.json();
}

function objectUrl(hash: string): string {
    return `${RESOURCES}/${hash.slice(0, 2)}/${hash}`;
}

async function loadIndex(): Promise<SoundIndex> {
    const manifest = (await json(MANIFEST)) as {
        latest?: { release?: string };
        versions?: { id: string; url: string }[];
    };
    const release = manifest.versions?.find((one) => one.id === manifest.latest?.release);
    if (!release) throw new Error("Mojang named no release");
    const version = (await json(release.url)) as { assetIndex?: { url?: string } };
    if (!version.assetIndex?.url) throw new Error("That release has no asset index");
    const assets = (await json(version.assetIndex.url)) as {
        objects?: Record<string, { hash: string; size: number }>;
    };
    const objects = assets.objects ?? {};
    const table = objects["minecraft/sounds.json"];
    if (!table) throw new Error("That release lists no sounds");
    const sounds = (await json(objectUrl(table.hash))) as SoundIndex["sounds"];
    return { objects, sounds, at: Date.now() };
}

async function soundIndex(): Promise<SoundIndex> {
    const held = index ? await index.catch(() => null) : null;
    if (held && Date.now() - held.at < INDEX_TTL_MS) return held;
    index = loadIndex();
    // A failed fetch is not remembered: the next press asks again.
    index.catch(() => {
        index = null;
    });
    return index;
}

/** The asset an event plays, following one `event` reference - the way the
 *  game's own table points one event at another. */
function assetFor(table: SoundIndex["sounds"], event: string, hops = 0): string | null {
    const first = table[event]?.sounds?.[0];
    if (!first) return null;
    if (typeof first === "string") return first;
    if (first.type === "event") return hops > 2 ? null : assetFor(table, first.name, hops + 1);
    return first.name;
}

/** Whether a sound id is one this will fetch. */
export function isPreviewableSound(id: string): boolean {
    return id.length > 0 && ANNOUNCE_SOUNDS.some((sound) => sound.id === id);
}

/** The sound, as the Ogg file the game plays, or null when it cannot be had. */
export async function soundPreview(id: string): Promise<Uint8Array | null> {
    if (!isPreviewableSound(id)) return null;
    const kept = files.get(id);
    if (kept) return kept;
    const table = await soundIndex();
    const asset = assetFor(table.sounds, id.replace(/^minecraft:/, ""));
    const object = asset ? table.objects[`minecraft/sounds/${asset}.ogg`] : undefined;
    if (!object || object.size > MOST_BYTES) return null;
    const answer = await fetch(objectUrl(object.hash), { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!answer.ok) return null;
    const bytes = new Uint8Array(await answer.arrayBuffer());
    if (bytes.byteLength > MOST_BYTES) return null;
    files.set(id, bytes);
    return bytes;
}
