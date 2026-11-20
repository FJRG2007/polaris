/**
 * Locations on messages: reading them back, moving a live share, stopping one,
 * and finding a place nearby.
 *
 * A location is a message, sent by `messages.send` with the point handed to it,
 * so the room's rules, slow mode, blocks and notifications are the ones every
 * message gets. What lives here is what only a location has.
 *
 * Privacy is the shape of it: a coordinate exists only on its message, is read
 * only through the conversation check that drew the screen, and a live share
 * stops being writable the moment its clock runs out or its sender stops it -
 * the server refuses the update, it does not rely on the sender's device to go
 * quiet.
 *
 * Server-only.
 */

import { z } from "zod";
import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import { publishChatChange } from "./live";
import * as history from "./history-visibility";
import { follow, readCapped } from "@/lib/safe-fetch";
import { ChatAccessError, ChatRuleError, channelAccess, requireChannel } from "./access";

/** A location as the message list draws it. */
export interface ChatLocationView {
    readonly mode: core.ChatLocationMode;
    readonly latitude: number | null;
    readonly longitude: number | null;
    readonly accuracy: number | null;
    readonly placeName: string | null;
    readonly address: string | null;
    /** ISO; set for a live share only. */
    readonly liveUntil: string | null;
    /** Whether a live share is still moving right now. */
    readonly live: boolean;
    /** Whether its sender stopped it before its time. */
    readonly endedEarly: boolean;
    /** ISO; when the point last moved. */
    readonly movedAt: string;
}

/** One live share of the reader's own, for the "sharing in N chats" strip. */
export interface LiveShareView {
    readonly messageId: string;
    readonly channelId: string;
    readonly liveUntil: string;
}

/** The most live shares one person may hold at once. Bounds every update. */
export const MAX_LIVE_SHARES = 20;
/** The shortest gap between two accepted moves, so a device cannot flood a room. */
export const MIN_MOVE_GAP_MS = 5_000;

const SELECT = {
    messageId: true,
    mode: true,
    latitude: true,
    longitude: true,
    accuracy: true,
    placeName: true,
    address: true,
    liveUntil: true,
    endedAt: true,
    movedAt: true
} as const;

type Row = {
    messageId: string;
    mode: string;
    latitude: number | null;
    longitude: number | null;
    accuracy: number | null;
    placeName: string | null;
    address: string | null;
    liveUntil: Date | null;
    endedAt: Date | null;
    movedAt: Date;
};

const MODES = new Set<string>(core.chatLocationModes);

/** A stored row as the card reads it. Pure; exported for tests. */
export function viewOf(row: Row, now: Date = new Date()): ChatLocationView {
    const mode = (MODES.has(row.mode) ? row.mode : "pin") as core.ChatLocationMode;
    return {
        mode,
        latitude: row.latitude,
        longitude: row.longitude,
        accuracy: row.accuracy,
        placeName: row.placeName,
        address: row.address,
        liveUntil: row.liveUntil?.toISOString() ?? null,
        live: mode === "live" && core.liveLocationRunning(row, now),
        endedEarly: row.endedAt !== null,
        movedAt: row.movedAt.toISOString()
    };
}

/** The locations on a page of messages, keyed by message. One query for the page. */
export async function locationsFor(messageIds: readonly string[]): Promise<Map<string, ChatLocationView>> {
    const found = new Map<string, ChatLocationView>();
    if (messageIds.length === 0) return found;
    const rows = await prisma.chatLocation.findMany({
        where: { messageId: { in: [...messageIds] } },
        select: SELECT
    });
    const now = new Date();
    for (const row of rows) found.set(row.messageId, viewOf(row, now));
    return found;
}

/** One location again, for a card catching up. The channel is proved first. */
export async function readLocation(actor: { id: string }, messageId: string): Promise<ChatLocationView | null> {
    const message = await prisma.chatMessage.findUnique({
        where: { id: messageId },
        select: { channelId: true, deletedAt: true }
    });
    if (!message) return null;
    await requireChannel(actor, message.channelId);
    await history.requireReadable(actor, message.channelId, messageId);
    if (message.deletedAt) return null;
    return (await locationsFor([messageId])).get(messageId) ?? null;
}

/** What the reader is sharing live right now, newest first. */
export async function liveShares(actor: { id: string }, now: Date = new Date()): Promise<LiveShareView[]> {
    const rows = await prisma.chatLocation.findMany({
        where: {
            mode: "live",
            endedAt: null,
            liveUntil: { gt: now },
            message: { authorId: actor.id, deletedAt: null }
        },
        orderBy: { liveUntil: "desc" },
        take: MAX_LIVE_SHARES,
        select: { messageId: true, liveUntil: true, message: { select: { channelId: true } } }
    });
    return rows.map((row) => ({
        messageId: row.messageId,
        channelId: row.message.channelId,
        liveUntil: (row.liveUntil as Date).toISOString()
    }));
}

/** Whether somebody may start one more live share. */
export async function mayStartLive(actor: { id: string }): Promise<boolean> {
    return (await liveShares(actor)).length < MAX_LIVE_SHARES;
}

/**
 * Move every live share this person is running to a new point.
 *
 * One position for all of them, the way WhatsApp's is: the device knows where it
 * is, not which chats it is in. A share in a conversation the sender can no
 * longer reach is ended here rather than moved - leaving a room must not leave a
 * tracker behind in it.
 *
 * Answers how many shares are still running, so a device knows to stop asking
 * the moment it reaches zero.
 */
export async function moveLive(
    actor: { id: string },
    point: core.GeoPoint,
    now: Date = new Date()
): Promise<{ running: number; moved: number }> {
    const shares = await prisma.chatLocation.findMany({
        where: {
            mode: "live",
            endedAt: null,
            liveUntil: { gt: now },
            message: { authorId: actor.id, deletedAt: null }
        },
        take: MAX_LIVE_SHARES,
        select: { messageId: true, movedAt: true, message: { select: { channelId: true } } }
    });
    if (shares.length === 0) return { running: 0, moved: 0 };

    const lost: string[] = [];
    const due: { messageId: string; channelId: string }[] = [];
    for (const share of shares) {
        if (!(await channelAccess(actor, share.message.channelId))) {
            lost.push(share.messageId);
            continue;
        }
        if (now.getTime() - share.movedAt.getTime() < MIN_MOVE_GAP_MS) continue;
        due.push({ messageId: share.messageId, channelId: share.message.channelId });
    }
    if (lost.length) {
        await prisma.chatLocation.updateMany({ where: { messageId: { in: lost } }, data: { endedAt: now } });
    }
    if (due.length) {
        await prisma.chatLocation.updateMany({
            // The clock again, in the write itself: a share that ran out between
            // the read and here is not moved.
            where: { messageId: { in: due.map((one) => one.messageId) }, endedAt: null, liveUntil: { gt: now } },
            data: {
                latitude: point.latitude,
                longitude: point.longitude,
                accuracy: point.accuracy ?? null,
                movedAt: now
            }
        });
        for (const channelId of new Set(due.map((one) => one.channelId))) {
            publishChatChange({
                channelId,
                kind: "posted",
                actorId: actor.id,
                messageIds: due.filter((one) => one.channelId === channelId).map((one) => one.messageId)
            });
        }
    }
    return { running: shares.length - lost.length, moved: due.length };
}

/**
 * Stop a live share before its time, or every one of them when no message is
 * named. Only the sender's own. Stopping one that already stopped is not an
 * error: the button sits on a card that may not have caught up.
 */
export async function stopLive(
    actor: { id: string },
    messageId: string | null,
    now: Date = new Date()
): Promise<void> {
    if (messageId) {
        const message = await prisma.chatMessage.findUnique({
            where: { id: messageId },
            select: { authorId: true, channelId: true, location: { select: { mode: true } } }
        });
        if (!message?.location) throw new ChatAccessError({ key: "errors.locationGone" });
        if (message.authorId !== actor.id) throw new ChatAccessError({ key: "errors.locationNotYours" });
        if (message.location.mode !== "live") throw new ChatRuleError({ key: "errors.locationNotLive" });
    }
    const running = (await liveShares(actor, now)).filter((share) => !messageId || share.messageId === messageId);
    if (running.length === 0) return;
    await prisma.chatLocation.updateMany({
        where: { messageId: { in: running.map((share) => share.messageId) }, endedAt: null },
        data: { endedAt: now }
    });
    for (const channelId of new Set(running.map((share) => share.channelId))) {
        publishChatChange({
            channelId,
            kind: "posted",
            actorId: actor.id,
            messageIds: running.filter((share) => share.channelId === channelId).map((share) => share.messageId)
        });
    }
}

// ---------------------------------------------------------------------------
// Places nearby
// ---------------------------------------------------------------------------

/** A place a search found, with how far it is from where the person stands. */
export interface NearbyPlace {
    readonly name: string;
    readonly address: string | null;
    readonly latitude: number;
    readonly longitude: number;
    readonly meters: number;
}

/**
 * OpenStreetMap's Nominatim, the service Polaris already names VPN spots with:
 * free, no key. Its policy allows one request a second from one application, so
 * asks from the whole instance are queued one behind the other, and answers are
 * kept so the same search asks nobody twice.
 */
const SEARCH_URL = "https://nominatim.openstreetmap.org/search";
const ANSWER_BYTES = 512 * 1024;
const GAP_MS = 1_100;
/** How far around the point a search reaches, in degrees (about 5 km). */
const REACH_DEG = 0.05;
const RESULTS = 10;
const KEPT = 300;
const KEPT_MS = 60 * 60 * 1000;
const kept = new Map<string, { at: number; value: NearbyPlace[] }>();
let queue: Promise<unknown> = Promise.resolve();

const searchSchema = z.array(
    z.object({
        lat: z.coerce.number().min(-90).max(90),
        lon: z.coerce.number().min(-180).max(180),
        name: z.string().optional().nullable(),
        display_name: z.string().optional().nullable()
    })
);

/** Metres between two points, on a sphere. Pure; exported for tests. */
export function metersBetween(a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }): number {
    const rad = Math.PI / 180;
    const dLat = (b.latitude - a.latitude) * rad;
    const dLon = (b.longitude - a.longitude) * rad;
    const h =
        Math.sin(dLat / 2) ** 2 + Math.cos(a.latitude * rad) * Math.cos(b.latitude * rad) * Math.sin(dLon / 2) ** 2;
    return Math.round(2 * 6_371_000 * Math.asin(Math.min(1, Math.sqrt(h))));
}

function line(value: string | null | undefined): string | null {
    const text = (value ?? "").replace(/\s+/g, " ").trim().slice(0, core.MAX_PLACE_TEXT);
    return text || null;
}

/** A search answer as the picker lists it, nearest first. Pure; exported for tests. */
export function placesOf(answer: z.infer<typeof searchSchema>, from: { latitude: number; longitude: number }): NearbyPlace[] {
    const places: NearbyPlace[] = [];
    for (const hit of answer) {
        const full = line(hit.display_name);
        const name = line(hit.name) ?? full?.split(",")[0]?.trim() ?? null;
        if (!name) continue;
        const point = { latitude: hit.lat, longitude: hit.lon };
        places.push({ name, address: full, ...point, meters: metersBetween(from, point) });
    }
    return places.sort((left, right) => left.meters - right.meters).slice(0, RESULTS);
}

/** Places matching what was typed around a point. Null when the service could not be asked. */
export async function nearbyPlaces(
    input: z.infer<typeof core.nearbyPlacesSchema>,
    language: string
): Promise<NearbyPlace[] | null> {
    // Rounded to about a hundred metres, so the kept answers are reused by
    // somebody a few steps away and the exact point is never a cache key.
    const lat = Math.round(input.latitude * 1000) / 1000;
    const lon = Math.round(input.longitude * 1000) / 1000;
    const key = `${language}:${lat},${lon}:${input.query.toLowerCase()}`;
    const hit = kept.get(key);
    if (hit && Date.now() - hit.at < KEPT_MS) return hit.value;

    const url = new URL(SEARCH_URL);
    url.search = new URLSearchParams({
        format: "jsonv2",
        q: input.query,
        viewbox: `${lon - REACH_DEG},${lat + REACH_DEG},${lon + REACH_DEG},${lat - REACH_DEG}`,
        bounded: "1",
        limit: String(RESULTS),
        "accept-language": language
    }).toString();

    const ask = queue.then(async () => {
        const started = Date.now();
        try {
            const response = await follow(url, "application/json");
            if (!response || !response.ok) return null;
            const bytes = await readCapped(response, ANSWER_BYTES);
            if (!bytes) return null;
            const parsed = searchSchema.safeParse(JSON.parse(new TextDecoder().decode(bytes)));
            return parsed.success ? placesOf(parsed.data, { latitude: lat, longitude: lon }) : null;
        } catch {
            return null;
        } finally {
            const wait = GAP_MS - (Date.now() - started);
            if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
        }
    });
    queue = ask.catch(() => undefined);
    const places = await ask;
    if (places) {
        if (kept.size >= KEPT) kept.delete(kept.keys().next().value as string);
        kept.set(key, { at: Date.now(), value: places });
    }
    return places;
}
