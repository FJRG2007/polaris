/**
 * A Minecraft server's own sounds: the library, the pack built from it, and
 * getting that pack to the players without a restart.
 *
 * The rules are `sounds.ts` (what a file and the settings may be) and
 * `sounds-env.ts` (what the server has to carry); this keeps the files, builds
 * the pack once per change, answers the server's jar when it asks what to hand
 * its players, and tells a running server to ask again after every change.
 *
 * The pack is built the same way every time from the same sounds - entries in
 * order, one fixed date, stored rather than compressed (Ogg is compressed
 * already) - so its checksum is a property of the library, not of the moment it
 * was built, and every copy of the dashboard agrees on it.
 */

import JSZip from "jszip";
import * as rules from "./sounds";
import { prisma, type Prisma } from "@polaris/db";
import { host } from "@polaris/app-host";
import { loadEnv } from "@polaris/config";
import * as soundsEnv from "./sounds-env";
import { SOFTWARE_KEY } from "./join-guard";
import { TOKEN_KEY } from "./polaris-login";
import { gameMessage } from "../game-message";
import { ownerWords } from "../owner-words";
import { withServerContainer } from "./service";
import { replyObject } from "./events/in-server";
import { anticheatBundled } from "./polaris-mod-files";
import { forgetMomentOverrides } from "./sound-moments-service";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const { publicAppUrl, appBaseUrl } = host.domainService;
const { listEnvVars, setEnvVars } = host.envVarService;
const { readInstallEnvSecret } = host.appsInstallSecret;

/** One sound as the screen lists it: everything but the file. */
export interface SoundEntry {
    readonly id: string;
    readonly key: string;
    readonly name: string;
    readonly size: number;
    readonly seconds: number;
    readonly channels: number;
    readonly subtitle: string;
    readonly stream: boolean;
    readonly replaces: string;
    readonly updatedAt: string;
}

export interface SoundLibrary {
    readonly sounds: readonly SoundEntry[];
    readonly settings: rules.SoundSettings;
    readonly totalBytes: number;
}

/** A refusal the screen shows as it is: what was wrong with what was sent. */
export class SoundRefusal extends Error {}

const entrySelect = {
    id: true,
    key: true,
    name: true,
    size: true,
    seconds: true,
    channels: true,
    subtitle: true,
    stream: true,
    replaces: true,
    updatedAt: true
} as const;

type EntryRow = {
    id: string;
    key: string;
    name: string;
    size: number;
    seconds: number;
    channels: number;
    subtitle: string;
    stream: boolean;
    replaces: string;
    updatedAt: Date;
};

function entry(row: EntryRow): SoundEntry {
    return { ...row, updatedAt: row.updatedAt.toISOString() };
}

export async function soundLibrary(installedAppId: string): Promise<SoundLibrary> {
    const [rows, pack] = await Promise.all([
        prisma.minecraftSound.findMany({
            where: { installedAppId },
            select: entrySelect,
            orderBy: { name: "asc" },
            take: rules.MAX_SOUNDS
        }),
        prisma.minecraftSoundPack.findUnique({
            where: { installedAppId },
            select: { settings: true }
        })
    ]);
    return {
        sounds: rows.map(entry),
        settings: rules.readSoundSettings(pack?.settings),
        totalBytes: rows.reduce((sum, row) => sum + row.size, 0)
    };
}

/** Why a file is not a sound the game can play, in a sentence. */
function refusal(reason: rules.VorbisRefusal): string {
    switch (reason) {
        case "notOgg":
            return gameMessage("minecraft", "sounds.refused.notOgg");
        case "opus":
            return gameMessage("minecraft", "sounds.refused.opus");
        case "notVorbis":
            return gameMessage("minecraft", "sounds.refused.notVorbis");
        case "channels":
            return gameMessage("minecraft", "sounds.refused.channels");
        case "broken":
            return gameMessage("minecraft", "sounds.refused.broken");
        case "chained":
            return gameMessage("minecraft", "sounds.refused.chained");
    }
}

/** The file checked as the game will read it, or a refusal. */
function checked(bytes: Uint8Array): Extract<rules.VorbisInfo, { ok: true }> {
    if (bytes.length === 0)
        throw new SoundRefusal(gameMessage("minecraft", "sounds.refused.empty"));
    if (bytes.length > rules.MAX_SOUND_BYTES)
        throw new SoundRefusal(gameMessage("minecraft", "sounds.refused.tooLarge"));
    const info = rules.readVorbis(bytes);
    if (!info.ok) throw new SoundRefusal(refusal(info.reason));
    return info;
}

/** The library changed: the next pack is a new one, and the moments are read
 *  again. */
async function bump(installedAppId: string): Promise<void> {
    await prisma.minecraftSoundPack.upsert({
        where: { installedAppId },
        create: { installedAppId, revision: 1 },
        update: { revision: { increment: 1 } }
    });
    forgetMomentOverrides(installedAppId);
}

/** Read the library and write to it as one step: two uploads at once (several
 *  files dropped together) take turns, so neither takes the other's key or
 *  slips past the limits with it. */
function withLibrary<T>(
    installedAppId: string,
    work: (tx: Prisma.TransactionClient) => Promise<T>
): Promise<T> {
    return prisma.$transaction(
        async (tx) => {
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`polaris.minecraft.sounds:${installedAppId}`}))`;
            return work(tx);
        },
        { timeout: 30_000 }
    );
}

/** Add one sound. Its key is made from its name, numbered when taken. */
export async function addSound(
    installedAppId: string,
    input: { readonly name: string; readonly bytes: Uint8Array }
): Promise<SoundEntry> {
    const name = rules.soundNameSchema.safeParse(input.name);
    if (!name.success) throw new SoundRefusal(gameMessage("minecraft", "sounds.refused.name"));
    const info = checked(input.bytes);
    const row = await withLibrary(installedAppId, async (tx) => {
        const existing = await tx.minecraftSound.findMany({
            where: { installedAppId },
            select: { key: true, size: true }
        });
        if (existing.length >= rules.MAX_SOUNDS)
            throw new SoundRefusal(
                gameMessage("minecraft", "sounds.refused.tooMany", { count: rules.MAX_SOUNDS })
            );
        const total = existing.reduce((sum, row) => sum + row.size, 0);
        if (total + input.bytes.length > rules.MAX_LIBRARY_BYTES)
            throw new SoundRefusal(gameMessage("minecraft", "sounds.refused.libraryFull"));
        const key = rules.freeKey(
            rules.soundKey(name.data),
            new Set(existing.map((row) => row.key))
        );
        return tx.minecraftSound.create({
            data: {
                installedAppId,
                key,
                name: name.data,
                data: Buffer.from(input.bytes),
                sha1: createHash("sha1").update(input.bytes).digest("hex"),
                size: input.bytes.length,
                channels: info.channels,
                sampleRate: info.sampleRate,
                seconds: info.seconds,
                stream: info.seconds > rules.STREAM_AFTER_SECONDS
            },
            select: entrySelect
        });
    });
    await bump(installedAppId);
    return entry(row);
}

/** Put a new file under a sound that is already in use: same key, same name,
 *  everything that plays it plays the new one. */
export async function replaceSound(
    installedAppId: string,
    id: string,
    bytes: Uint8Array
): Promise<SoundEntry> {
    const info = checked(bytes);
    const updated = await withLibrary(installedAppId, async (tx) => {
        const others = await tx.minecraftSound.findMany({
            where: { installedAppId, id: { not: id } },
            select: { size: true }
        });
        const total = others.reduce((sum, row) => sum + row.size, 0);
        if (total + bytes.length > rules.MAX_LIBRARY_BYTES)
            throw new SoundRefusal(gameMessage("minecraft", "sounds.refused.libraryFull"));
        return tx.minecraftSound.updateMany({
            where: { installedAppId, id },
            data: {
                data: Buffer.from(bytes),
                sha1: createHash("sha1").update(bytes).digest("hex"),
                size: bytes.length,
                channels: info.channels,
                sampleRate: info.sampleRate,
                seconds: info.seconds,
                stream: info.seconds > rules.STREAM_AFTER_SECONDS
            }
        });
    });
    if (updated.count === 0)
        throw new SoundRefusal(gameMessage("minecraft", "sounds.refused.gone"));
    await bump(installedAppId);
    const row = await prisma.minecraftSound.findFirstOrThrow({
        where: { installedAppId, id },
        select: entrySelect
    });
    return entry(row);
}

/** What the screen may change about a sound besides its file. The key stays:
 *  it is what commands and datapacks already name. */
export interface SoundChange {
    readonly name?: string;
    readonly subtitle?: string;
    readonly stream?: boolean;
    readonly replaces?: string;
}

export async function updateSound(
    installedAppId: string,
    id: string,
    change: SoundChange
): Promise<void> {
    const data: { name?: string; subtitle?: string; stream?: boolean; replaces?: string } = {};
    if (change.name !== undefined) {
        const name = rules.soundNameSchema.safeParse(change.name);
        if (!name.success) throw new SoundRefusal(gameMessage("minecraft", "sounds.refused.name"));
        data.name = name.data;
    }
    if (change.subtitle !== undefined)
        data.subtitle = rules.normalizeSoundName(change.subtitle).slice(0, rules.MAX_SUBTITLE);
    if (change.stream !== undefined) data.stream = change.stream;
    if (change.replaces !== undefined) {
        const replaces = rules.vanillaIdSchema.safeParse(change.replaces);
        if (!replaces.success)
            throw new SoundRefusal(gameMessage("minecraft", "sounds.refused.vanilla"));
        data.replaces = replaces.data;
    }
    const updated = await prisma.minecraftSound.updateMany({ where: { installedAppId, id }, data });
    if (updated.count === 0)
        throw new SoundRefusal(gameMessage("minecraft", "sounds.refused.gone"));
    // A name is only the screen's; everything else is in the pack.
    if (data.subtitle !== undefined || data.stream !== undefined || data.replaces !== undefined)
        await bump(installedAppId);
}

export async function deleteSound(installedAppId: string, id: string): Promise<void> {
    await prisma.minecraftSound.deleteMany({ where: { installedAppId, id } });
    const keys = await prisma.minecraftSound.findMany({
        where: { installedAppId },
        select: { key: true }
    });
    const pack = await prisma.minecraftSoundPack.findUnique({
        where: { installedAppId },
        select: { settings: true }
    });
    const settings = rules.withoutMissing(
        rules.readSoundSettings(pack?.settings),
        new Set(keys.map((row) => row.key))
    );
    await prisma.minecraftSoundPack.upsert({
        where: { installedAppId },
        create: { installedAppId, revision: 1, settings: JSON.stringify(settings) },
        update: { revision: { increment: 1 }, settings: JSON.stringify(settings) }
    });
    forgetMomentOverrides(installedAppId);
}

/** Save what the server does with its sounds. Anything pointing at a sound that
 *  is not in the library is refused rather than kept. */
export async function saveSoundSettings(
    installedAppId: string,
    input: unknown
): Promise<rules.SoundSettings> {
    const parsed = rules.soundSettingsSchema.safeParse(input);
    if (!parsed.success)
        throw new SoundRefusal(gameMessage("minecraft", "sounds.refused.settings"));
    const keys = await prisma.minecraftSound.findMany({
        where: { installedAppId },
        select: { key: true }
    });
    const kept = rules.withoutMissing(parsed.data, new Set(keys.map((row) => row.key)));
    const seen = new Set<string>();
    const settings: rules.SoundSettings = {
        ...kept,
        prompt: rules.normalizeSoundName(kept.prompt),
        // One arrival sound per player, the last one given.
        players: [...kept.players]
            .reverse()
            .filter((one) => {
                const name = one.player.toLowerCase();
                if (seen.has(name)) return false;
                seen.add(name);
                return true;
            })
            .reverse()
    };
    await prisma.minecraftSoundPack.upsert({
        where: { installedAppId },
        create: { installedAppId, settings: JSON.stringify(settings) },
        update: { settings: JSON.stringify(settings) }
    });
    forgetMomentOverrides(installedAppId);
    return settings;
}

/** One sound's file, for the screen's player. */
export async function soundFile(installedAppId: string, id: string): Promise<Uint8Array | null> {
    const row = await prisma.minecraftSound.findFirst({
        where: { installedAppId, id },
        select: { data: true }
    });
    return row ? new Uint8Array(row.data) : null;
}

/** Everything kept about a server that no longer exists. */
export async function clearSounds(installedAppId: string): Promise<void> {
    await Promise.all([
        prisma.minecraftSound.deleteMany({ where: { installedAppId } }),
        prisma.minecraftSoundPack.deleteMany({ where: { installedAppId } })
    ]).catch(() => undefined);
    forgetMomentOverrides(installedAppId);
    packs.delete(installedAppId);
}

// ------------------------------------------------------------------ the pack

/** A zip's entries carry a date; a fixed one keeps two builds byte-identical. */
const ZIP_DATE = new Date("2000-01-01T00:00:00Z");

export interface BuiltPack {
    readonly revision: number;
    readonly bytes: Uint8Array;
    readonly sha1: string;
}

/** The last pack built per server. Bounded: a pack can be tens of megabytes. */
const packs = new Map<
    string,
    { readonly revision: number; readonly built: Promise<BuiltPack | null> }
>();
const PACKS_KEPT = 4;

async function build(installedAppId: string, revision: number): Promise<BuiltPack | null> {
    const rows = await prisma.minecraftSound.findMany({
        where: { installedAppId },
        select: { key: true, data: true, subtitle: true, stream: true, replaces: true },
        orderBy: { key: "asc" },
        take: rules.MAX_SOUNDS
    });
    if (rows.length === 0) return null;
    const zip = new JSZip();
    const add = (path: string, content: string | Uint8Array) =>
        zip.file(path, content, { date: ZIP_DATE, compression: "STORE", createFolders: false });
    add("pack.mcmeta", rules.packMeta(rules.PACK_DESCRIPTION));
    add(`assets/${rules.NAMESPACE}/sounds.json`, rules.soundsJson(rows));
    const replaced = rules.replacedJson(rows);
    if (replaced) add("assets/minecraft/sounds.json", replaced);
    const subtitles = rules.subtitlesJson(rows);
    if (subtitles) add(`assets/${rules.NAMESPACE}/lang/en_us.json`, subtitles);
    for (const row of rows) add(rules.soundPath(row.key), new Uint8Array(row.data));
    const bytes = await zip.generateAsync({ type: "uint8array", platform: "UNIX" });
    return { revision, bytes, sha1: createHash("sha1").update(bytes).digest("hex") };
}

/** The server's pack as its library stands, or null when it has no sounds. */
export async function currentPack(installedAppId: string): Promise<BuiltPack | null> {
    const [pack, install] = await Promise.all([
        prisma.minecraftSoundPack.findUnique({
            where: { installedAppId },
            select: { revision: true }
        }),
        prisma.installedApp.findUnique({ where: { id: installedAppId }, select: { id: true } })
    ]);
    if (!pack || !install) return null;
    const cached = packs.get(installedAppId);
    if (cached && cached.revision === pack.revision) return cached.built;
    const built = build(installedAppId, pack.revision).catch((caught) => {
        packs.delete(installedAppId);
        throw caught;
    });
    packs.delete(installedAppId);
    packs.set(installedAppId, { revision: pack.revision, built });
    while (packs.size > PACKS_KEPT) packs.delete(packs.keys().next().value as string);
    return built;
}

/** The token in a pack's address: this instance's secret over the server's id,
 *  so the address cannot be guessed from the id and nothing is stored. */
export function soundPackToken(installedAppId: string): string {
    return createHmac("sha256", loadEnv().POLARIS_AUTH_SECRET || "")
        .update(`minecraft-sound-pack:${installedAppId}`)
        .digest("base64url")
        .slice(0, 32);
}

export function soundPackTokenMatches(installedAppId: string, token: string): boolean {
    const expected = Buffer.from(soundPackToken(installedAppId));
    const given = Buffer.from(token);
    return expected.length === given.length && timingSafeEqual(expected, given);
}

/** Where players download it from: this Polaris's public address when it has
 *  one, since players are anywhere; its own address otherwise. */
export async function soundPackBase(): Promise<{ base: string; public: boolean }> {
    const open = await publicAppUrl().catch(() => null);
    if (open) return { base: open, public: true };
    return { base: (await appBaseUrl()).replace(/\/+$/, ""), public: false };
}

export function soundPackUrl(base: string, installedAppId: string, file: string): string {
    return `${base}${soundsEnv.serverPackMarker(installedAppId)}${soundPackToken(installedAppId)}/${file}`;
}

/** The id the pack is pushed under: the same for a server forever, so pushing a
 *  new one replaces the last, and never the id of the server's own pack. */
export function soundPackId(installedAppId: string): string {
    const hash = createHash("sha1").update(`polaris-sounds:${installedAppId}`).digest();
    hash[6] = ((hash[6] as number) & 0x0f) | 0x50;
    hash[8] = ((hash[8] as number) & 0x3f) | 0x80;
    const hex = hash.subarray(0, 16).toString("hex");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** What the server's jar hands its players, as it asks for it. */
export interface JarConfig {
    readonly ok: true;
    readonly pack: {
        readonly id: string;
        readonly url: string;
        readonly sha1: string;
        readonly required: boolean;
        readonly prompt: string;
        readonly kick: string;
    } | null;
    readonly join: JarSound | null;
    readonly welcome: JarSound | null;
    readonly players: readonly (JarSound & { readonly player: string })[];
    /** The everyday moments with a sound, and who hears each. */
    readonly moments: rules.JarMoments;
}

interface JarSound {
    readonly sound: string;
    readonly volume: number;
    readonly pitch: number;
}

function jarSound(use: rules.SoundUse | undefined): JarSound | null {
    return use ? { sound: rules.soundId(use.sound), volume: use.volume, pitch: use.pitch } : null;
}

export async function jarConfig(installedAppId: string): Promise<JarConfig> {
    const [pack, settingsRow, install] = await Promise.all([
        currentPack(installedAppId),
        prisma.minecraftSoundPack.findUnique({
            where: { installedAppId },
            select: { settings: true }
        }),
        prisma.installedApp.findUnique({ where: { id: installedAppId }, select: { ownerId: true } })
    ]);
    if (!pack || !install)
        return { ok: true, pack: null, join: null, welcome: null, players: [], moments: {} };
    const keys = await prisma.minecraftSound.findMany({
        where: { installedAppId },
        select: { key: true }
    });
    const settings = rules.withoutMissing(
        rules.readSoundSettings(settingsRow?.settings),
        new Set(keys.map((row) => row.key))
    );
    const { base } = await soundPackBase();
    return {
        ok: true,
        pack: {
            id: soundPackId(installedAppId),
            url: soundPackUrl(base, installedAppId, `${pack.sha1}.zip`),
            sha1: pack.sha1,
            required: settings.required,
            prompt: settings.prompt,
            kick: (await ownerWords(install.ownerId, "minecraft"))("sounds.kick")
        },
        join: jarSound(settings.moments.join),
        welcome: jarSound(settings.moments.welcome),
        players: settings.players.map((one) => ({
            player: one.player.toLowerCase(),
            sound: rules.soundId(one.sound),
            volume: one.volume,
            pitch: one.pitch
        })),
        moments: rules.jarMoments(settings.moments)
    };
}

/** The server a request comes from, when it carries that server's token. An
 *  unknown server and a wrong token are the same answer. */
export async function authorizeServer(request: Request, installedAppId: string): Promise<boolean> {
    const header = request.headers.get("authorization") ?? "";
    const presented = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    if (!presented) return false;
    const install = await prisma.installedApp.findFirst({
        where: { id: installedAppId, status: { not: "removed" }, applicationId: { not: null } },
        select: { applicationId: true, ownerId: true }
    });
    if (!install?.applicationId) return false;
    const token = await readInstallEnvSecret(install.applicationId, install.ownerId, TOKEN_KEY);
    const digest = (value: string) => createHash("sha256").update(value).digest();
    return (
        token !== null && token !== undefined && timingSafeEqual(digest(presented), digest(token))
    );
}

// ------------------------------------------------------------------ the server

/** How the sounds reach this server's players. */
export interface SoundsDelivery {
    /** Live through Polaris's jar, as the server's own resource pack, or not at
     *  all on this software. */
    readonly mode: "jar" | "serverPack" | "none";
    /** The jar's kind where there is one. */
    readonly kind: "mod" | "plugin" | null;
    /** Whether the server carries the jar and knows where Polaris is. */
    readonly ready: boolean;
    /** Whether this Polaris has an address players and the server can reach. */
    readonly reachable: boolean;
    /** Where the server's own resource pack is free for the sounds (fallback). */
    readonly serverPackFree: boolean;
    readonly serverPackOn: boolean;
    /** The link that always serves the newest pack. */
    readonly latestUrl: string;
}

async function envOf(applicationId: string, ownerId: string): Promise<Map<string, string>> {
    const vars = await listEnvVars("application", applicationId, ownerId);
    return new Map(vars.map((one) => [one.key, one.value ?? ""]));
}

export async function soundsDelivery(
    installedAppId: string,
    applicationId: string,
    ownerId: string,
    edition: "java" | "bedrock"
): Promise<SoundsDelivery> {
    const [env, base] = await Promise.all([envOf(applicationId, ownerId), soundPackBase()]);
    const build = soundsEnv.soundsBuildFor(env.get(SOFTWARE_KEY) ?? "", env.get("VERSION") ?? "");
    const bundled = build ? await anticheatBundled(build.file).catch(() => false) : false;
    return {
        mode: edition === "bedrock" ? "none" : build && bundled ? "jar" : "serverPack",
        kind: build?.kind ?? null,
        ready: build !== null && soundsEnv.soundsReady(env, installedAppId),
        reachable: base.public,
        serverPackFree: soundsEnv.serverPackFree(env, installedAppId),
        serverPackOn: soundsEnv.serverPackIsOurs(env, installedAppId),
        latestUrl: soundPackUrl(base.base, installedAppId, "latest.zip")
    };
}

/** Put the jar on the server and tell it where Polaris is. Answers whether a
 *  restart is needed for it to load. */
export async function enableSounds(
    installedAppId: string,
    applicationId: string,
    ownerId: string
): Promise<boolean> {
    const env = await envOf(applicationId, ownerId);
    const build = soundsEnv.soundsBuildFor(env.get(SOFTWARE_KEY) ?? "", env.get("VERSION") ?? "");
    if (!build) throw new SoundRefusal(gameMessage("minecraft", "sounds.refused.noBuild"));
    // The server downloads the jar and asks for the pack at this address, and a
    // LAN-only name does not resolve inside a container.
    const baseUrl = await publicAppUrl().catch(() => null);
    if (baseUrl === null)
        throw new SoundRefusal(gameMessage("minecraft", "sounds.refused.noAddress"));
    if (!(await anticheatBundled(build.file).catch(() => false)))
        throw new SoundRefusal(gameMessage("games", "lib.noModBuild"));
    const existing = await readInstallEnvSecret(applicationId, ownerId, TOKEN_KEY);
    const writes = soundsEnv.soundsEnableEnv(env, {
        baseUrl,
        installedAppId,
        token: existing ?? randomBytes(32).toString("hex"),
        hasToken: Boolean(existing)
    });
    if (writes.size > 0)
        await setEnvVars(
            "application",
            applicationId,
            ownerId,
            [...writes].map(([key, value]) => ({ key, value, isSecret: key === TOKEN_KEY }))
        );
    return soundsEnv.soundsNeedRestart(writes);
}

/** Offer the pack as the server's own resource pack, or take it back. Only
 *  where the server has none of its own. The caller restarts the server. */
export async function setServerPack(
    installedAppId: string,
    applicationId: string,
    ownerId: string,
    on: boolean
): Promise<void> {
    const env = await envOf(applicationId, ownerId);
    if (on && !soundsEnv.serverPackFree(env, installedAppId))
        throw new SoundRefusal(gameMessage("minecraft", "sounds.refused.packTaken"));
    if (!on && !soundsEnv.serverPackIsOurs(env, installedAppId)) return;
    const pack = await prisma.minecraftSoundPack.findUnique({
        where: { installedAppId },
        select: { settings: true }
    });
    const { base } = await soundPackBase();
    const writes = on
        ? soundsEnv.serverPackEnv(
              soundPackUrl(base, installedAppId, "latest.zip"),
              rules.readSoundSettings(pack?.settings).required
          )
        : soundsEnv.serverPackOffEnv();
    await setEnvVars(
        "application",
        applicationId,
        ownerId,
        [...writes].map(([key, value]) => ({ key, value, isSecret: false }))
    );
}

/** Keep the server's own resource pack's "required" in step with the
 *  setting, where that pack is the sounds'. Read at the next start. */
export async function syncServerPackRequired(
    installedAppId: string,
    applicationId: string,
    ownerId: string,
    required: boolean
): Promise<void> {
    const env = await envOf(applicationId, ownerId);
    if (!soundsEnv.serverPackIsOurs(env, installedAppId)) return;
    const value = required ? "true" : "false";
    if (env.get(soundsEnv.RESOURCE_PACK_ENFORCE_KEY) === value) return;
    await setEnvVars("application", applicationId, ownerId, [
        { key: soundsEnv.RESOURCE_PACK_ENFORCE_KEY, value, isSecret: false }
    ]);
}

/** What the jar on a running server says about the pack. */
export interface LiveSounds {
    readonly running: boolean;
    /** Whether the running jar has the sounds at all: false for one that
     *  predates them, until a restart. */
    readonly loaded: boolean;
    /** The pack it is handing out, by checksum. */
    readonly sha1: string;
    /** Who has it loaded, and who turned it down or could not get it. */
    readonly players: readonly {
        readonly name: string;
        readonly state: "loaded" | "pending" | "declined" | "failed";
    }[];
}

const NOT_RUNNING: LiveSounds = { running: false, loaded: false, sha1: "", players: [] };

const STATES = new Set(["loaded", "pending", "declined", "failed"]);

/** Ask the running server's jar. */
export async function liveSounds(ownerId: string, installedAppId: string): Promise<LiveSounds> {
    return withServerContainer(ownerId, installedAppId, async (server) => {
        if (!server.running || server.edition !== "java") return NOT_RUNNING;
        const reply = replyObject(
            await server.say(["polaris", "sounds", "status"]).catch(() => "")
        );
        if (!reply || reply.ok !== true) return { ...NOT_RUNNING, running: true };
        const players = Array.isArray(reply.players) ? reply.players : [];
        return {
            running: true,
            loaded: true,
            sha1: typeof reply.sha1 === "string" ? reply.sha1 : "",
            players: players.flatMap((one) => {
                if (!one || typeof one !== "object") return [];
                const { name, state } = one as { name?: unknown; state?: unknown };
                return typeof name === "string" && typeof state === "string" && STATES.has(state)
                    ? [{ name, state: state as LiveSounds["players"][number]["state"] }]
                    : [];
            })
        };
    });
}

/** Tell a running server to fetch the pack again and hand it to everybody on.
 *  Answers whether a running jar took it. A stopped server fetches it when it
 *  starts. */
export async function refreshServer(ownerId: string, installedAppId: string): Promise<boolean> {
    return withServerContainer(ownerId, installedAppId, async (server) => {
        if (!server.running || server.edition !== "java") return false;
        const reply = replyObject(
            await server.say(["polaris", "sounds", "refresh"]).catch(() => "")
        );
        return reply?.ok === true;
    }).catch(() => false);
}

const PLAYER = /^[A-Za-z0-9_]{1,16}$/;

/** Play one of the server's sounds now, to everybody or to one player, at
 *  their own position. Only players whose game loaded the pack hear it. */
export async function playSound(
    ownerId: string,
    installedAppId: string,
    input: {
        readonly key: string;
        readonly player: string | null;
        readonly volume: number;
        readonly pitch: number;
    }
): Promise<string> {
    const sound = await prisma.minecraftSound.findFirst({
        where: { installedAppId, key: input.key },
        select: { key: true }
    });
    if (!sound) throw new SoundRefusal(gameMessage("minecraft", "sounds.refused.gone"));
    if (input.player !== null && !PLAYER.test(input.player))
        throw new SoundRefusal(gameMessage("minecraft", "sounds.refused.player"));
    const volume = rules.commandNumber(Math.min(1, Math.max(0, input.volume)));
    const pitch = rules.commandNumber(
        Math.min(rules.MAX_PITCH, Math.max(rules.MIN_PITCH, input.pitch))
    );
    const target = input.player ?? "@a";
    return withServerContainer(ownerId, installedAppId, async (server) => {
        if (!server.running)
            throw new SoundRefusal(gameMessage("minecraft", "sounds.refused.stopped"));
        return server.say([
            `execute as ${target} at @s run playsound ${rules.soundId(sound.key)} master @s ~ ~ ~ ${volume} ${pitch}`
        ]);
    });
}
