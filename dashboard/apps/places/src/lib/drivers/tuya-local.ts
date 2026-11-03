/**
 * Tuya devices reached on the local network first, and through Tuya's cloud
 * when they cannot be.
 *
 * Shared by both ways into a Tuya account. The account is still where the
 * devices, their names and their keys come from: every device's local key is in
 * the same answer that lists it, so nothing is typed. What changes is the
 * route: a switch Polaris has found on its own network is read and told
 * directly, in a fraction of a second and with the internet down; one it has
 * not found, or that stopped answering, goes through the cloud exactly as
 * before, and is tried locally again on the next look. The ids are the same
 * either way, so a room or an automation never notices the difference.
 *
 * The keys are kept with the account's other credentials (sealed like them),
 * handed back through `renew`, so a restart with the internet down still
 * knows them. Where each device is - an address and a protocol version - is
 * only kept in memory: it is found again in seconds, and an address written
 * down is an address that goes stale.
 *
 * Server-only.
 */

import { z } from "zod";
import type { Credentials } from "./contract";
import * as lan from "../integrations/tuya-lan";
import { subnetTargets } from "../integrations/lan-unit";
import type { TuyaVersion } from "../integrations/tuya-protocol";
import { tuyaDraws, type TuyaDeviceShape } from "./tuya-vocabulary";

/** The credentials field the keys travel in. */
export const LAN_KEYS_FIELD = "lanKeys";

/** How often devices not yet found are looked for, at most. */
const LOCATE_EVERY_MS = 10 * 60 * 1000;

/** How long announcements are listened for, per look. */
const LISTEN_MS = 4_000;

/** How many (address, device, version) guesses one look may make on a network
 *  where announcements do not arrive. */
const MAX_GUESSES = 90;

/** How many looks may guess at a device without finding it before it is left
 *  to its own announcements: a device in another home is never on this
 *  network, and every guess is a connection some device here has to turn away. */
const MAX_GUESSED_LOOKS = 3;

/** How long a device whose map came back empty waits before it is asked for
 *  again. */
const MAP_RETRY_MS = 24 * 60 * 60 * 1000;

/** How many devices are read at once. */
const READ_CONCURRENCY = 8;

const VERSIONS_TRIED: readonly TuyaVersion[] = ["3.4", "3.5", "3.3"];

/** Why a device is not reached locally, for the screen to say. */
export type TuyaLocalReason = "not-found" | "key" | "no-key";

export interface TuyaReach {
    readonly route: "local" | "cloud";
    readonly reason: TuyaLocalReason | null;
}

interface Known {
    key: string;
    /** Their data point numbers, by code. */
    dps: Record<string, number>;
    /** When the map was last asked for, where it was since this process started. */
    mappedAt?: number;
}

interface Book {
    known: Map<string, Known>;
    where: Map<string, { address: string; version: TuyaVersion }>;
    refused: Set<string>;
    /** Looks that guessed at a device and did not find it, by id. */
    missedLooks: Map<string, number>;
    shapes: TuyaDeviceShape[];
    lookedAt: number;
    locating: Promise<void> | null;
}

const books = new Map<string, Book>();

const storedSchema = z.record(
    z.string().max(64),
    z.object({ k: z.string().length(16), d: z.record(z.string().max(64), z.number().int()) })
);

function bookOf(account: string, credentials: Credentials): Book {
    let book = books.get(account);
    if (!book) {
        book = {
            known: new Map(),
            where: new Map(),
            refused: new Set(),
            missedLooks: new Map(),
            shapes: [],
            lookedAt: Number.NEGATIVE_INFINITY,
            locating: null
        };
        books.set(account, book);
    }
    if (book.known.size === 0 && credentials[LAN_KEYS_FIELD]) {
        try {
            const stored = storedSchema.parse(JSON.parse(credentials[LAN_KEYS_FIELD]!));
            for (const [id, entry] of Object.entries(stored))
                book.known.set(id, { key: entry.k, dps: entry.d });
        } catch {
            // Unreadable keys are keys read again on the next list.
        }
    }
    return book;
}

function serialized(book: Book): string {
    const out: Record<string, { k: string; d: Record<string, number> }> = {};
    for (const [id, entry] of [...book.known.entries()].sort(([a], [b]) => a.localeCompare(b)))
        out[id] = { k: entry.key, d: entry.dps };
    return JSON.stringify(out);
}

/** What `renew` should hand back so the keys are stored: the credentials with
 *  the keys as now known, or null where nothing changed. */
export function tuyaLocalRenewal(account: string, credentials: Credentials): Credentials | null {
    const book = books.get(account);
    if (!book || book.known.size === 0) return null;
    const next = serialized(book);
    return next === credentials[LAN_KEYS_FIELD] ? null : { ...credentials, [LAN_KEYS_FIELD]: next };
}

/** The usual numbering where a device's own map was not read: `switch_2` is
 *  point 2, a lone `switch` point 1. */
function guessedDp(code: string): number | null {
    if (code === "switch" || code === "switch_led") return 1;
    const gang = /^switch_(\d+)$/.exec(code);
    return gang ? Number(gang[1]) : null;
}

function dpFor(entry: Known, code: string): number | null {
    return entry.dps[code] ?? guessedDp(code);
}

export interface TuyaLocalSource {
    /** A device's data point numbers by code, from the account. */
    dpMap(deviceId: string): Promise<Record<string, number>>;
}

/** Learn the keys in a fresh list from the account, for the devices Places
 *  draws. A map that came back empty is asked for again only after
 *  `MAP_RETRY_MS`. */
async function learn(
    book: Book,
    devices: readonly (TuyaDeviceShape & { readonly local_key?: string | null })[],
    source: TuyaLocalSource,
    now: number
): Promise<void> {
    book.shapes = [...devices];
    for (const device of devices) {
        const key = device.local_key;
        if (!key || key.length !== 16 || !tuyaDraws(device)) continue;
        const known = book.known.get(device.id);
        if (known && known.key === key) {
            if (Object.keys(known.dps).length > 0) continue;
            if (known.mappedAt !== undefined && now - known.mappedAt < MAP_RETRY_MS) continue;
        }
        if (known && known.key !== key) {
            book.refused.delete(device.id);
            book.where.delete(device.id);
            book.missedLooks.delete(device.id);
        }
        const dps = await source.dpMap(device.id).catch(() => ({}));
        book.known.set(device.id, { key, dps, mappedAt: now });
    }
}

/** Look for the devices not yet found: announcements first, then, where none
 *  arrive (a container on a bridge network), the addresses on this network
 *  that answer on Tuya's port, tried against each key - until a device has
 *  been guessed at for `MAX_GUESSED_LOOKS` looks without being found, after
 *  which only its own announcement finds it. */
async function locate(book: Book, now: number): Promise<void> {
    const missing = () =>
        [...book.known.keys()].filter((id) => !book.where.has(id) && !book.refused.has(id));
    if (missing().length === 0 || now - book.lookedAt < LOCATE_EVERY_MS) return;
    book.lookedAt = now;
    for (const heard of await lan.listenForTuya(LISTEN_MS).catch(() => [])) {
        if (book.known.has(heard.id)) {
            book.where.set(heard.id, { address: heard.address, version: heard.version ?? "3.3" });
            book.missedLooks.delete(heard.id);
        }
    }
    const misses = (id: string) => book.missedLooks.get(id) ?? 0;
    const guessable = missing()
        .filter((id) => misses(id) < MAX_GUESSED_LOOKS)
        .sort((a, b) => misses(a) - misses(b));
    if (guessable.length === 0) return;
    const taken = new Set([...book.where.values()].map((entry) => entry.address));
    const open = (await lan.probeTuyaPorts(await subnetTargets().catch(() => []))).filter(
        (address) => !taken.has(address)
    );
    let guesses = 0;
    for (const id of guessable) {
        const entry = book.known.get(id)!;
        let found = false;
        for (const address of open) {
            if (taken.has(address)) continue;
            if (guesses >= MAX_GUESSES) return;
            const version = await firstVersion(address, id, entry.key, () => (guesses += 1));
            if (version) {
                book.where.set(id, { address, version });
                taken.add(address);
                found = true;
                break;
            }
        }
        if (!found) book.missedLooks.set(id, misses(id) + 1);
    }
}

async function firstVersion(
    address: string,
    id: string,
    localKey: string,
    count: () => void
): Promise<TuyaVersion | null> {
    for (const version of VERSIONS_TRIED) {
        count();
        try {
            await lan.readTuyaLocal({ id, address, version, localKey }, { guess: true });
            return version;
        } catch {
            // Not this device, or not this version.
        }
    }
    return null;
}

/** The status of a device as its local points, translated to codes. */
function statusFromDps(
    entry: Known,
    dps: Readonly<Record<string, unknown>>,
    before: TuyaDeviceShape["status"]
): TuyaDeviceShape["status"] {
    const codes = new Set([...before.map((point) => point.code), ...Object.keys(entry.dps)]);
    const status = new Map(before.map((point) => [point.code, point.value]));
    for (const code of codes) {
        const dp = dpFor(entry, code);
        if (dp !== null && String(dp) in dps) status.set(code, dps[String(dp)]);
    }
    return [...status.entries()].map(([code, value]) => ({ code, value }));
}

function reachOf(book: Book, id: string, local: boolean): TuyaReach {
    if (local) return { route: "local", reason: null };
    if (!book.known.has(id)) return { route: "cloud", reason: "no-key" };
    return { route: "cloud", reason: book.refused.has(id) ? "key" : "not-found" };
}

/**
 * The account's devices as fresh as they can be: the cloud's list, with the
 * state of every device found locally read from the device itself. With the
 * cloud unreachable (`devices` null), the last list is used instead, and only
 * what answers locally is reported as online.
 */
export async function tuyaLocalRead(
    account: string,
    credentials: Credentials,
    devices: readonly (TuyaDeviceShape & { readonly local_key?: string | null })[] | null,
    source: TuyaLocalSource,
    now: number = Date.now()
): Promise<{ devices: TuyaDeviceShape[]; reach: Map<string, TuyaReach> } | null> {
    const book = bookOf(account, credentials);
    if (devices) await learn(book, devices, source, now);
    else if (book.shapes.length === 0) return null;
    // Looking is slow next to a read (a few seconds of listening, a guess per
    // address), so it runs beside the reads rather than in front of them: what
    // it finds is used from the next read on.
    if (!book.locating) {
        book.locating = locate(book, now)
            .catch(() => undefined)
            .finally(() => {
                book.locating = null;
            });
    }
    const shapes = book.shapes;
    const reads = new Array<TuyaDeviceShape | null>(shapes.length).fill(null);
    let next = 0;
    const worker = async () => {
        for (let index = next++; index < shapes.length; index = next++) {
            const device = shapes[index]!;
            const entry = book.known.get(device.id);
            const where = book.where.get(device.id);
            if (!entry || !where) continue;
            try {
                const dps = await lan.readTuyaLocal({
                    id: device.id,
                    localKey: entry.key,
                    ...where
                });
                reads[index] = {
                    ...device,
                    online: true,
                    status: statusFromDps(entry, dps, device.status)
                };
            } catch (caught) {
                forgetPlace(book, device.id, caught);
            }
        }
    };
    await Promise.all(Array.from({ length: Math.min(READ_CONCURRENCY, shapes.length) }, worker));
    const reach = new Map<string, TuyaReach>();
    const out: TuyaDeviceShape[] = [];
    shapes.forEach((device, index) => {
        const read = reads[index] ?? null;
        reach.set(device.id, reachOf(book, device.id, read !== null));
        out.push(read ?? (devices ? device : { ...device, online: false }));
    });
    return { devices: out, reach };
}

/** A device that stopped answering where it was: looked for at the next look,
 *  like any other device not yet found, rather than straight away. */
function forgetPlace(book: Book, id: string, caught: unknown): void {
    book.where.delete(id);
    if (caught instanceof lan.TuyaLanError && caught.reason === "key") book.refused.add(id);
}

/**
 * Tell a device locally where it is found; true when it took it, false when
 * the cloud has to carry the command instead.
 */
export async function tuyaLocalAct(
    account: string,
    credentials: Credentials,
    deviceId: string,
    commands: readonly { code: string; value: unknown }[]
): Promise<boolean> {
    const book = bookOf(account, credentials);
    const entry = book.known.get(deviceId);
    const where = book.where.get(deviceId);
    if (!entry || !where) return false;
    const dps: Record<string, unknown> = {};
    for (const command of commands) {
        const dp = dpFor(entry, command.code);
        if (dp === null) return false;
        dps[String(dp)] = command.value;
    }
    try {
        await lan.writeTuyaLocal({ id: deviceId, localKey: entry.key, ...where }, dps, {
            once: true
        });
        return true;
    } catch (caught) {
        forgetPlace(book, deviceId, caught);
        return false;
    }
}

/** What a device last reported, as the account listed it, or null before
 *  the first list: how a setting is spelled back to it (`tuyaSwitchCommands`). */
export function tuyaLocalStatus(
    account: string,
    credentials: Credentials,
    deviceId: string
): TuyaDeviceShape["status"] | null {
    return (
        bookOf(account, credentials).shapes.find((shape) => shape.id === deviceId)?.status ?? null
    );
}

/** Wait for a look in progress; for tests. */
export async function settleTuyaLocal(account: string): Promise<void> {
    await books.get(account)?.locating;
}

/** Forget everything about an account; for tests, and a removed account. */
export function forgetTuyaLocal(account?: string): void {
    if (account) books.delete(account);
    else books.clear();
}

/** A specification's data point numbers by code, from either API's answer:
 *  the cloud project's `dp_id` on each point, or the app's
 *  `dpStatusRelationDTOS` with `dpId` and `statusCode`. */
export function dpMapOf(answer: unknown): Record<string, number> {
    const out: Record<string, number> = {};
    const spec = z
        .object({
            functions: z.array(z.object({ code: z.string(), dp_id: z.number().int() })).optional(),
            status: z.array(z.object({ code: z.string(), dp_id: z.number().int() })).optional()
        })
        .safeParse(answer);
    if (spec.success) {
        for (const point of [...(spec.data.status ?? []), ...(spec.data.functions ?? [])])
            out[point.code] = point.dp_id;
    }
    const relations = z
        .object({
            dpStatusRelationDTOS: z.array(
                z.object({ dpId: z.number().int(), statusCode: z.string() })
            )
        })
        .safeParse(answer);
    if (relations.success) {
        for (const point of relations.data.dpStatusRelationDTOS) out[point.statusCode] = point.dpId;
    }
    return out;
}
