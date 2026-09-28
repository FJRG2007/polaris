/**
 * Asking Spotify what people are listening to, and keeping listeners in step.
 *
 * Spotify has no way to be told: there is no webhook and no stream for what an
 * account is playing, so the only way to know is to ask. What keeps that from
 * becoming a request storm is who is asked and how often:
 *
 * - **Only an account somebody could be shown.** Linked, sharing switched on for
 *   Spotify, and here right now (a session seen in the last few minutes) - an
 *   activity is only ever drawn beside a presence that reads as here, so asking
 *   about anybody else would be asking for an answer nobody may see. The one
 *   exception is listening along, which is followed for as long as it lasts.
 * - **When the answer can have changed.** A track that is playing is asked about
 *   again when it is due to end, and at least every thirty seconds in between so
 *   a skip or a pause is caught (ten while somebody is listening along, where a
 *   skip is a song they are hearing late). Nothing playing backs off from a
 *   minute to five.
 * - **Never past Spotify's word.** A 429 stops every request until its
 *   Retry-After has passed, and each pass asks at most `MOST_PER_PASS`.
 *
 * The schedule is held in memory. A restart asks everybody once and settles
 * again, and the job is leased, so a second process does not double it.
 */

import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import { activitySettingsFor } from "./settings";
import { clearActivity, putActivity } from "./service";
import { readCredential, updateCredential } from "@/lib/connections/store";
import {
    getSpotifyOAuthClient,
    readSpotifyPlaying,
    SPOTIFY_PROVIDER,
    spotifyAccessToken,
    SpotifyRateLimited,
    SpotifyUnauthorized,
    type SpotifyOAuthClient,
    type SpotifyTrack
} from "@/lib/connections/spotify";
import { followHost, noticeListener, stopListenAlong } from "./listen-along";

/** How recently a session has to have been seen for its owner to count as here.
 *  The same window the presence dot uses. */
const HERE_MS = 3 * 60_000;

/** The longest a playing track goes unasked about: a skip or a pause is caught
 *  within this. */
const PLAYING_MS = 30_000;

/** The same, while somebody is listening along. */
const HOSTING_MS = 10_000;

/** The shortest gap between two questions about one account. */
const SOONEST_MS = 5_000;

/** Nothing playing: asked again after this, doubling to `IDLE_MOST_MS`. */
const IDLE_MS = 60_000;
const IDLE_MOST_MS = 5 * 60_000;

/** A link that failed: asked again after this. */
const FAILED_MS = 5 * 60_000;

/** A link Spotify no longer accepts: left alone this long. The connection
 *  health sweep is what tells its owner. */
const REFUSED_MS = 30 * 60_000;

/** The most accounts asked about in one pass. */
export const MOST_PER_PASS = 40;

/** How long a stored track is believed past the next time it is due to be
 *  asked about, so one slow pass does not blink the card off. */
const GRACE_MS = 45_000;

interface Schedule {
    /** When each link is next due, by connection id. */
    readonly due: Map<string, number>;
    /** How many passes in a row found nothing playing, by connection id. */
    readonly idle: Map<string, number>;
    /** Spotify asked for quiet until this moment. */
    pausedUntil: number;
}

const REGISTRY = Symbol.for("polaris.activity.spotify");

function schedule(): Schedule {
    const holder = globalThis as { [REGISTRY]?: Schedule };
    holder[REGISTRY] ??= { due: new Map(), idle: new Map(), pausedUntil: 0 };
    return holder[REGISTRY];
}

/** Ask about this account on the next pass, whatever its schedule says - somebody
 *  just started listening along with them. */
export function pollSoon(connectionId: string): void {
    schedule().due.set(connectionId, 0);
}

/** Forget everything, for a test. */
export function resetSpotifySchedule(): void {
    const held = schedule();
    held.due.clear();
    held.idle.clear();
    held.pausedUntil = 0;
}

/** When a playing track should next be asked about. */
export function nextPlayingCheck(track: SpotifyTrack, hosting: boolean): number {
    const remaining = track.durationMs - track.progressMs + 1_500;
    return Math.max(SOONEST_MS, Math.min(remaining, hosting ? HOSTING_MS : PLAYING_MS));
}

/** When an account with nothing playing should next be asked about. */
export function nextIdleCheck(streak: number): number {
    return Math.min(IDLE_MOST_MS, IDLE_MS * 2 ** Math.max(0, streak - 1));
}

export interface SpotifyPass {
    readonly asked: number;
    readonly skipped?: string;
}

/** One pass: ask about every account that is due, in order of how overdue. */
export async function pollSpotify(now: number = Date.now()): Promise<SpotifyPass> {
    const held = schedule();
    if (now < held.pausedUntil) return { asked: 0, skipped: "Spotify asked for fewer requests" };
    const client = await getSpotifyOAuthClient();
    if (!client) return { asked: 0, skipped: "no Spotify application is connected" };

    const [links, along] = await Promise.all([
        prisma.userConnection.findMany({
            where: { provider: SPOTIFY_PROVIDER, encryptedToken: { not: null } },
            select: { id: true, userId: true },
            orderBy: { linkedAt: "asc" }
        }),
        prisma.spotifyListenAlong.findMany({ select: { listenerId: true, hostId: true } })
    ]);
    // One link per account is the default limit; where an operator allowed more,
    // the first is the one that speaks for them.
    const byUser = new Map<string, string>();
    for (const link of links) if (!byUser.has(link.userId)) byUser.set(link.userId, link.id);
    // A host who unlinked is never read again, so nothing else would end
    // following them.
    for (const row of along) {
        if (!byUser.has(row.hostId)) await stopListenAlong(row.listenerId).catch(() => undefined);
    }
    if (byUser.size === 0) return { asked: 0 };
    const userIds = [...byUser.keys()];

    const [here, settings] = await Promise.all([
        prisma.sessionState.findMany({
            where: { userId: { in: userIds }, lastSeenAt: { gt: new Date(now - HERE_MS) } },
            select: { userId: true }
        }),
        activitySettingsFor(userIds)
    ]);
    const present = new Set(here.map((row) => row.userId));
    const hosts = new Set(along.map((row) => row.hostId));
    const listeners = new Set(along.map((row) => row.listenerId));

    const due: { userId: string; connectionId: string; at: number }[] = [];
    for (const [userId, connectionId] of byUser) {
        const shares = core.activitySourceOn(
            settings.get(userId) ?? core.DEFAULT_ACTIVITY_SETTINGS,
            "spotify"
        );
        const wanted =
            (shares && present.has(userId)) || hosts.has(userId) || listeners.has(userId);
        if (!wanted) {
            // Gone, or switched off: what was showing goes with them.
            if (held.due.has(connectionId)) {
                held.due.delete(connectionId);
                held.idle.delete(connectionId);
                await clearActivity(userId, "spotify").catch(() => undefined);
            }
            continue;
        }
        const at = held.due.get(connectionId) ?? 0;
        if (at <= now) due.push({ userId, connectionId, at });
    }
    due.sort((a, b) => a.at - b.at);

    // Each account is read later in the pass than the one before it, and a
    // position worked out against the pass's start would put every song early.
    const started = Date.now();
    const clock = () => now + Date.now() - started;

    let asked = 0;
    for (const entry of due.slice(0, MOST_PER_PASS)) {
        asked += 1;
        const shares =
            present.has(entry.userId) &&
            core.activitySourceOn(
                settings.get(entry.userId) ?? core.DEFAULT_ACTIVITY_SETTINGS,
                "spotify"
            );
        try {
            await askOne(client, entry, {
                shares,
                hosting: hosts.has(entry.userId),
                listening: listeners.has(entry.userId),
                clock
            });
        } catch (caught) {
            if (caught instanceof SpotifyRateLimited) {
                held.pausedUntil = now + caught.retryAfterMs;
                held.due.set(entry.connectionId, now + caught.retryAfterMs);
                break;
            }
            held.due.set(
                entry.connectionId,
                now + (caught instanceof SpotifyUnauthorized ? REFUSED_MS : FAILED_MS)
            );
        }
    }
    return { asked };
}

async function askOne(
    client: SpotifyOAuthClient,
    entry: { userId: string; connectionId: string },
    role: { shares: boolean; hosting: boolean; listening: boolean; clock: () => number }
): Promise<void> {
    const held = schedule();
    const credential = await readCredential(entry.connectionId);
    if (!credential) throw new SpotifyUnauthorized();
    const token = await spotifyAccessToken(client, credential);
    if (!token) throw new SpotifyUnauthorized();
    if (token.refreshed) await updateCredential(entry.connectionId, token.refreshed);

    const track = await readSpotifyPlaying(token.accessToken);
    const now = role.clock();

    let moved = false;
    if (role.shares && track) {
        const startedAt = new Date(now - track.progressMs);
        const endsAt = new Date(startedAt.getTime() + track.durationMs);
        moved = await putActivity(
            entry.userId,
            "spotify",
            {
                key: track.id,
                name: track.name,
                details: track.artists,
                state: track.album,
                imageUrl: track.imageUrl,
                linkUrl: track.linkUrl,
                startedAt,
                endsAt
            },
            new Date(now + nextPlayingCheck(track, role.hosting) + GRACE_MS),
            new Date(now)
        );
    } else {
        await clearActivity(entry.userId, "spotify", new Date(now));
    }

    if (role.hosting) await followHost(entry.userId, track, moved, now);
    if (role.listening) await noticeListener(entry.userId, track, now);

    if (track) {
        held.idle.delete(entry.connectionId);
        held.due.set(entry.connectionId, now + nextPlayingCheck(track, role.hosting));
    } else {
        const streak = (held.idle.get(entry.connectionId) ?? 0) + 1;
        held.idle.set(entry.connectionId, streak);
        held.due.set(entry.connectionId, now + (role.hosting ? HOSTING_MS : nextIdleCheck(streak)));
    }
}
