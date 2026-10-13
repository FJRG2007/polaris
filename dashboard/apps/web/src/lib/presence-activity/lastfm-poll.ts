/**
 * Asking Last.fm what people are listening to.
 *
 * The same card as a Spotify song, for the people the Spotify app cannot serve:
 * it is stored under the `spotify` source, so the one privacy switch for music
 * and the one card beside a name cover both, with a key that says where it came
 * from (`isLastfmKey`) so the card offers to open it rather than to follow it.
 *
 * Bounded the way the Spotify poll is, and tighter:
 * - only somebody linked, here (a session seen in the last few minutes) and
 *   sharing music, and never somebody with a Spotify link of their own - the
 *   Spotify poll reads them, with a position and a length Last.fm does not have;
 * - each person at most once per `LASTFM_WINDOW_MS`, backing off while nothing
 *   plays, and at most `MOST_PER_PASS` per pass;
 * - a 29 stops every request for a while, a refused key for longer, and a
 *   username Last.fm does not know is left alone until it is changed.
 *
 * Only ever from the server, with the deployment's key: the browser never talks
 * to Last.fm. The schedule is held in memory and the job is leased.
 */

import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import { activitySettingsFor } from "./settings";
import { clearActivity, putActivity } from "./service";
import { SPOTIFY_PROVIDER } from "@/lib/connections/spotify";
import { getIntegrationSecret, getIntegrationState } from "@/lib/integration-service";
import {
    LASTFM_PROVIDER,
    LastfmKeyRefused,
    LastfmRateLimited,
    LastfmUnknownUser,
    readLastfmPlaying
} from "@/lib/connections/lastfm";

/** How recently a session has to have been seen for its owner to count as here. */
const HERE_MS = 3 * 60_000;

/** The shortest gap between two questions about one person. */
export const LASTFM_WINDOW_MS = 30_000;

/** How long a stored song is believed past the next time it is due. */
const GRACE_MS = 45_000;

/** Last.fm said 29: every request waits this long. */
const RATE_LIMITED_MS = 2 * 60_000;

/** The key was refused: every request waits this long. The Integrations
 *  screen is where it is fixed. */
const KEY_REFUSED_MS = 30 * 60_000;

/** A failure that is not about the key or the name: asked again after this. */
const FAILED_MS = 2 * 60_000;

/** A username Last.fm does not know: left alone this long, or until it changes. */
const UNKNOWN_MS = 60 * 60_000;

/** Nothing playing: asked again after a minute, doubling to five. */
const IDLE_MS = 60_000;
const IDLE_MOST_MS = 5 * 60_000;

function nextIdleCheck(streak: number): number {
    return Math.min(IDLE_MOST_MS, IDLE_MS * 2 ** Math.max(0, streak - 1));
}

/** The most people asked about in one pass. */
export const MOST_PER_PASS = 40;

interface Schedule {
    /** When each person is next due, by user id and the name it was for. */
    readonly due: Map<string, { name: string; at: number }>;
    readonly idle: Map<string, number>;
    /** The song each person was last seen on and when it was first seen, so a
     *  song's elapsed time counts from its start rather than from each read. */
    readonly started: Map<string, { key: string; at: number }>;
    pausedUntil: number;
    pausedFor: string;
}

const REGISTRY = Symbol.for("polaris.activity.lastfm");

function schedule(): Schedule {
    const holder = globalThis as { [REGISTRY]?: Schedule };
    holder[REGISTRY] ??= {
        due: new Map(),
        idle: new Map(),
        started: new Map(),
        pausedUntil: 0,
        pausedFor: ""
    };
    return holder[REGISTRY];
}

/** Forget everything, for a test. */
export function resetLastfmSchedule(): void {
    const held = schedule();
    held.due.clear();
    held.idle.clear();
    held.started.clear();
    held.pausedUntil = 0;
    held.pausedFor = "";
}

/** The deployment's Last.fm API key, or null when none is connected or it is
 *  switched off. */
export async function lastfmApiKey(): Promise<string | null> {
    const state = await getIntegrationState(LASTFM_PROVIDER);
    if (!state?.enabled) return null;
    return (await getIntegrationSecret(LASTFM_PROVIDER))?.trim() || null;
}

export interface LastfmPass {
    readonly asked: number;
    readonly skipped?: string;
}

/** One pass: ask about every person who is due, most overdue first. */
export async function pollLastfm(now: number = Date.now()): Promise<LastfmPass> {
    const held = schedule();
    if (now < held.pausedUntil) return { asked: 0, skipped: held.pausedFor };
    const apiKey = await lastfmApiKey();
    if (!apiKey) return { asked: 0, skipped: "no Last.fm API key is connected" };

    const links = await prisma.userConnection.findMany({
        where: { provider: LASTFM_PROVIDER },
        select: { userId: true, label: true },
        orderBy: { linkedAt: "asc" }
    });
    const byUser = new Map<string, string>();
    for (const link of links) if (!byUser.has(link.userId)) byUser.set(link.userId, link.label);
    if (byUser.size === 0) return { asked: 0 };
    const userIds = [...byUser.keys()];

    const [spotify, here, settings] = await Promise.all([
        prisma.userConnection.findMany({
            where: {
                provider: SPOTIFY_PROVIDER,
                userId: { in: userIds },
                encryptedToken: { not: null }
            },
            select: { userId: true }
        }),
        prisma.sessionState.groupBy({
            by: ["userId"],
            where: { userId: { in: userIds }, lastSeenAt: { gt: new Date(now - HERE_MS) } }
        }),
        activitySettingsFor(userIds)
    ]);
    const onSpotify = new Set(spotify.map((row) => row.userId));
    const present = new Set(here.map((row) => row.userId));

    const due: { userId: string; name: string; at: number }[] = [];
    for (const [userId, name] of byUser) {
        if (onSpotify.has(userId)) continue;
        const shares = core.activitySourceOn(
            settings.get(userId) ?? core.DEFAULT_ACTIVITY_SETTINGS,
            "spotify"
        );
        if (!shares || !present.has(userId)) {
            if (held.due.has(userId)) {
                held.due.delete(userId);
                held.idle.delete(userId);
                held.started.delete(userId);
                await clearActivity(userId, "spotify").catch(() => undefined);
            }
            continue;
        }
        const scheduled = held.due.get(userId);
        // A changed name is a new question, whatever the old one's schedule said.
        const at = scheduled && scheduled.name === name ? scheduled.at : 0;
        if (at <= now) due.push({ userId, name, at });
    }
    due.sort((a, b) => a.at - b.at);

    let asked = 0;
    for (const entry of due.slice(0, MOST_PER_PASS)) {
        asked += 1;
        try {
            await askOne(apiKey, entry, now);
        } catch (caught) {
            if (caught instanceof LastfmRateLimited || caught instanceof LastfmKeyRefused) {
                const limited = caught instanceof LastfmRateLimited;
                held.pausedUntil = now + (limited ? RATE_LIMITED_MS : KEY_REFUSED_MS);
                held.pausedFor = limited
                    ? "Last.fm asked for fewer requests"
                    : "Last.fm refused the API key";
                held.due.set(entry.userId, { name: entry.name, at: held.pausedUntil });
                break;
            }
            const wait = caught instanceof LastfmUnknownUser ? UNKNOWN_MS : FAILED_MS;
            held.due.set(entry.userId, { name: entry.name, at: now + wait });
        }
    }
    return { asked };
}

async function askOne(
    apiKey: string,
    entry: { userId: string; name: string },
    now: number
): Promise<void> {
    const held = schedule();
    const track = await readLastfmPlaying(apiKey, entry.name);
    if (!track) {
        held.started.delete(entry.userId);
        await clearActivity(entry.userId, "spotify", new Date(now));
        const streak = (held.idle.get(entry.userId) ?? 0) + 1;
        held.idle.set(entry.userId, streak);
        held.due.set(entry.userId, {
            name: entry.name,
            at: now + nextIdleCheck(streak)
        });
        return;
    }
    const seen = held.started.get(entry.userId);
    const startedAt = seen && seen.key === track.key ? seen.at : now;
    held.started.set(entry.userId, { key: track.key, at: startedAt });
    held.idle.delete(entry.userId);
    held.due.set(entry.userId, { name: entry.name, at: now + LASTFM_WINDOW_MS });
    await putActivity(
        entry.userId,
        "spotify",
        {
            key: track.key,
            name: track.name,
            details: track.artists,
            state: track.album,
            imageUrl: track.imageUrl,
            linkUrl: track.linkUrl,
            startedAt: new Date(startedAt),
            // Last.fm says nothing about a song's length, so the card counts
            // up from when it was first seen instead of drawing a bar.
            endsAt: null
        },
        new Date(now + LASTFM_WINDOW_MS + GRACE_MS),
        new Date(now)
    );
}
