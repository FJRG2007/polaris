/**
 * Listening along: one account's Spotify following another's.
 *
 * Somebody presses "Listen along" on a card that says what somebody else is
 * playing, and their own Spotify starts the same track at the same second. From
 * then on the poll that reads the host (see `spotify-poll`) puts every change on
 * the listener too: the next song, a seek, a pause.
 *
 * It ends by itself in the three ways that mean it should:
 * - the listener takes their own Spotify back - plays something else, or stops
 *   it - which is read off their own poll (`noticeListener`), with a grace
 *   period so the few seconds between the host's song ending and the next one
 *   being put on are not mistaken for it;
 * - the host stops being somebody this listener may see listening: sharing off,
 *   an audience that leaves them out, invisible, gone - checked through the
 *   presence rule itself on every change, not remembered from the press;
 * - Spotify will not take orders for the listener any more (no Premium, a
 *   revoked link).
 *
 * Only ever the listener's own Spotify is touched, and only with the grant they
 * gave for exactly this. The host's is only ever read.
 */

import { prisma } from "@polaris/db";
import type * as core from "@polaris/core";
import { sourceSharedWith } from "./service";
import { presenceFor } from "@/lib/presence-service";
import { readCredential, updateCredential } from "@/lib/connections/store";
import {
    getSpotifyOAuthClient,
    SPOTIFY_PROVIDER,
    spotifyAccessToken,
    spotifyPause,
    spotifyPlay,
    SpotifyPlayerRefusal,
    SpotifyRateLimited,
    SpotifyUnauthorized,
    type SpotifyTrack
} from "@/lib/connections/spotify";

/** A refusal the person pressing the button is shown, in a sentence. `link`
 *  means they have no Spotify linked, which the screen offers to fix. */
export class ListenAlongError extends Error {
    constructor(
        message: string,
        readonly kind: "link" | "other" = "other"
    ) {
        super(message);
        this.name = "ListenAlongError";
    }
}

/** How long after a sync a different track on the listener's side is not yet
 *  taken as them taking over: the host's next song reaches them within one
 *  host poll, which is at most this. */
const TAKEOVER_GRACE_MS = 20_000;

/** How long a listener waits on a paused host before it is over: a host who
 *  paused is still read every few seconds for as long as somebody follows. */
const PAUSED_MOST_MS = 15 * 60_000;

/** A listener whose Spotify was seen playing something else, and since when. A
 *  single sighting is the moment between two songs; two in a row, apart by the
 *  grace, is somebody who picked something of their own. */
const STRAY = Symbol.for("polaris.activity.listen-along.stray");

function strays(): Map<string, number> {
    const holder = globalThis as { [STRAY]?: Map<string, number> };
    holder[STRAY] ??= new Map();
    return holder[STRAY];
}

/** The listener's link, and a token for it that is good now. Null when they have
 *  linked no Spotify, or the one they linked no longer works; a blip on the way
 *  to Spotify throws. */
async function listenerToken(
    userId: string
): Promise<{ connectionId: string; accessToken: string } | null> {
    const client = await getSpotifyOAuthClient();
    if (!client) return null;
    const link = await prisma.userConnection.findFirst({
        where: { userId, provider: SPOTIFY_PROVIDER, encryptedToken: { not: null } },
        orderBy: { linkedAt: "asc" },
        select: { id: true }
    });
    if (!link) return null;
    const credential = await readCredential(link.id);
    if (!credential) return null;
    const token = await spotifyAccessToken(client, credential).catch((caught: unknown) => {
        if (caught instanceof SpotifyUnauthorized) return null;
        throw caught;
    });
    if (!token) return null;
    if (token.refreshed) await updateCredential(link.id, token.refreshed);
    return { connectionId: link.id, accessToken: token.accessToken };
}

/** What the host is playing as this listener may see it, through the whole
 *  presence rule, or null when they may not see any. */
async function visibleTrack(
    listener: { id: string; isAdmin: boolean },
    hostId: string
): Promise<core.ActivityView | null> {
    const found = await presenceFor(listener, [hostId]);
    return found.get(hostId)?.activity.find((one) => one.source === "spotify") ?? null;
}

/** Whether the host is still somebody this listener may see listening, with
 *  nothing playing to see: here to them, and sharing Spotify with them. */
async function hostVisible(
    listener: { id: string; isAdmin: boolean },
    hostId: string
): Promise<boolean> {
    const found = await presenceFor(listener, [hostId]);
    if ((found.get(hostId)?.status ?? "offline") === "offline") return false;
    return (await sourceSharedWith(listener, [hostId], "spotify")).has(hostId);
}

function trackUri(id: string): string {
    return `spotify:track:${id}`;
}

/**
 * Start listening along with somebody. Throws a `ListenAlongError` with the
 * sentence to show when it cannot.
 */
export async function startListenAlong(
    listener: { id: string; isAdmin: boolean },
    hostId: string,
    now: number = Date.now()
): Promise<void> {
    if (hostId === listener.id) throw new ListenAlongError("That is your own music.");
    const track = await visibleTrack(listener, hostId);
    if (!track) throw new ListenAlongError("They are not playing anything you can see right now.");
    let token: Awaited<ReturnType<typeof listenerToken>>;
    try {
        token = await listenerToken(listener.id);
    } catch (caught) {
        if (caught instanceof SpotifyRateLimited)
            throw new ListenAlongError("Spotify is busy. Try again in a moment.");
        throw new ListenAlongError("Spotify could not be reached. Try again in a moment.");
    }
    if (!token) {
        throw new ListenAlongError(
            "Link your Spotify account under Connected accounts first.",
            "link"
        );
    }
    try {
        await spotifyPlay(
            token.accessToken,
            trackUri(track.key),
            now - Date.parse(track.startedAt)
        );
    } catch (caught) {
        if (caught instanceof SpotifyPlayerRefusal) throw new ListenAlongError(caught.message);
        if (caught instanceof SpotifyRateLimited) {
            throw new ListenAlongError("Spotify is busy. Try again in a moment.");
        }
        throw new ListenAlongError(
            "Spotify would not play it. Link your account again if this keeps happening."
        );
    }
    await prisma.spotifyListenAlong.upsert({
        where: { listenerId: listener.id },
        create: { listenerId: listener.id, hostId, trackId: track.key, syncedAt: new Date(now) },
        update: { hostId, trackId: track.key, syncedAt: new Date(now), startedAt: new Date(now) }
    });
    strays().delete(listener.id);
    // Asked about sooner than their schedules say: the host is now somebody a
    // skip matters for.
    const { pollSoon } = await import("./spotify-poll");
    const host = await prisma.userConnection.findFirst({
        where: { userId: hostId, provider: SPOTIFY_PROVIDER, encryptedToken: { not: null } },
        orderBy: { linkedAt: "asc" },
        select: { id: true }
    });
    if (host) pollSoon(host.id);
}

/** Stop. Their music is left playing: stopping following somebody is not
 *  stopping the song. */
export async function stopListenAlong(listenerId: string): Promise<void> {
    await prisma.spotifyListenAlong.deleteMany({ where: { listenerId } });
    strays().delete(listenerId);
}

/** Who this account is listening along with, or null. */
export async function listenAlongOf(listenerId: string): Promise<string | null> {
    const row = await prisma.spotifyListenAlong.findUnique({
        where: { listenerId },
        select: { hostId: true }
    });
    return row?.hostId ?? null;
}

/**
 * The host was just read: put what they are playing on everybody following them.
 *
 * `moved` is whether the host's own card changed - a new song or a seek - which
 * is when a listener already on the right track needs setting again.
 */
export async function followHost(
    hostId: string,
    track: SpotifyTrack | null,
    moved: boolean,
    now: number
): Promise<void> {
    const rows = await prisma.spotifyListenAlong.findMany({
        where: { hostId },
        select: {
            listenerId: true,
            trackId: true,
            syncedAt: true,
            listener: { select: { isAdmin: true } }
        }
    });
    for (const row of rows) {
        const listener = { id: row.listenerId, isAdmin: row.listener.isAdmin };
        try {
            if (!track) {
                // The host paused or stopped. The listener pauses with them and
                // stays following, so the host pressing play brings them back -
                // while the host is still somebody they may see, and not for ever.
                const waited = row.trackId === "" && now - row.syncedAt.getTime() >= PAUSED_MOST_MS;
                if (waited || !(await hostVisible(listener, hostId))) {
                    await stopListenAlong(listener.id);
                    continue;
                }
                if (row.trackId) {
                    const token = await listenerToken(listener.id);
                    if (!token) {
                        await stopListenAlong(listener.id);
                        continue;
                    }
                    await spotifyPause(token.accessToken);
                    await prisma.spotifyListenAlong.update({
                        where: { listenerId: listener.id },
                        data: { trackId: "", syncedAt: new Date(now) }
                    });
                }
                continue;
            }
            const visible = await visibleTrack(listener, hostId);
            if (!visible || visible.key !== track.id) {
                await stopListenAlong(listener.id);
                continue;
            }
            if (row.trackId === track.id && !moved) continue;
            const token = await listenerToken(listener.id);
            if (!token) {
                await stopListenAlong(listener.id);
                continue;
            }
            await spotifyPlay(token.accessToken, trackUri(track.id), track.progressMs);
            await prisma.spotifyListenAlong.update({
                where: { listenerId: listener.id },
                data: { trackId: track.id, syncedAt: new Date(now) }
            });
            strays().delete(listener.id);
        } catch (caught) {
            if (caught instanceof SpotifyRateLimited) throw caught;
            // No Premium any more, or a revoked link: this listener can no
            // longer be followed. A timeout, a 5xx or a phone that went quiet
            // for a moment is tried again on the host's next read, and a
            // listener who closed Spotify for good ends through their own poll.
            const refused =
                caught instanceof SpotifyUnauthorized ||
                (caught instanceof SpotifyPlayerRefusal && caught.kind === "premium");
            if (refused) await stopListenAlong(listener.id).catch(() => undefined);
            else console.error("polaris: could not keep a listener in step:", caught);
        }
    }
}

/**
 * The listener was just read: if they are playing something other than what was
 * put on for them, twice in a row, they took their Spotify back.
 */
export async function noticeListener(
    listenerId: string,
    track: SpotifyTrack | null,
    now: number
): Promise<void> {
    const row = await prisma.spotifyListenAlong.findUnique({
        where: { listenerId },
        select: { trackId: true, syncedAt: true }
    });
    if (!row) return;
    if (now - row.syncedAt.getTime() < TAKEOVER_GRACE_MS) return;
    // Paused along with the host: anything playing now is theirs.
    const same = row.trackId === "" ? track === null : track?.id === row.trackId;
    const held = strays();
    if (same) {
        held.delete(listenerId);
        return;
    }
    const since = held.get(listenerId);
    if (since === undefined) {
        held.set(listenerId, now);
        return;
    }
    if (now - since >= TAKEOVER_GRACE_MS) await stopListenAlong(listenerId);
}
