/**
 * Working your own call from a deck: finding the seat you are sitting in,
 * reading what its tab last said about its controls, and telling that tab to
 * change one.
 *
 * Only ever the caller's own seat. The seat is found by the account, never by
 * anything a key sends, so a key cannot reach somebody else's call - and the
 * command goes out on the call's own stream addressed to that one seat, which
 * only the browser holding it hears (`meeting-events`, filtered per seat in the
 * stream route).
 *
 * The microphone and headphones are on the seat's row already: the beat writes
 * them for the people outside the call. The camera and the recorder are not -
 * nobody outside needs them - so the beat's word on those is held here, in
 * memory, like every other live fact about a call. Losing it on a restart costs
 * one beat: the tab says it again within seconds.
 *
 * Server-only.
 */

import { prisma } from "@polaris/db";
import { reachableSpaceIds } from "./access";
import * as soundboard from "./soundboard-service";
import { publishMeetingEvent } from "./meeting-events";
import { PARTICIPANT_TTL_MS, type MeetingSeat } from "./meetings";
import { mayRecordCall, type CallRemoteCommand, type CallSwitch } from "./call-remote";
import { DEFAULT_SOUNDS, SOUNDBOARD_SLOTS, defaultRef, type DefaultSoundId } from "./soundboard";

/** What one seat's tab last said about its controls. */
export interface SeatControls {
    readonly muted: boolean;
    readonly deafened: boolean;
    readonly camera: boolean;
    readonly recording: boolean;
    /** Whether the seat is sharing its screen. */
    readonly sharing: boolean;
}

interface Held {
    userId: string | null;
    controls: SeatControls;
    at: number;
}

type ControlsListener = (userId: string) => void;

const REGISTRY = Symbol.for("polaris.chat.call-remote-service");

interface Registry {
    seats: Map<string, Held>;
    listeners: Set<ControlsListener>;
    sweptAt?: number;
}

function registry(): Registry {
    const holder = globalThis as { [REGISTRY]?: Registry };
    holder[REGISTRY] ??= { seats: new Map(), listeners: new Set() };
    return holder[REGISTRY];
}

/** A seat nobody has spoken for in this long is forgotten, so the map holds
 *  the calls going on now and nothing else. */
const FORGET_MS = 10 * 60_000;

/** How often the map is walked for them: often enough that it stays the calls
 *  going on now, rarely enough that a beat does not pay for every seat. */
const SWEEP_MS = 60_000;

function forgetOld(now: number): void {
    const held = registry();
    if (now - (held.sweptAt ?? 0) < SWEEP_MS) return;
    held.sweptAt = now;
    for (const [id, seat] of held.seats) if (now - seat.at > FORGET_MS) held.seats.delete(id);
}

/**
 * Note what a seat's beat said. Fields the beat left out - a tab older than
 * them - keep what was said before. Tells the decks listening when anything
 * changed.
 */
export async function noteControls(
    participantId: string,
    said: {
        muted?: boolean;
        deafened?: boolean;
        camera?: boolean;
        recording?: boolean;
        /** The beat's own word for a screen being shared. */
        streaming?: boolean;
    }
): Promise<void> {
    const now = Date.now();
    forgetOld(now);
    const seats = registry().seats;
    let held = seats.get(participantId);
    if (!held) {
        // Whose seat this is, read once per seat rather than on every beat.
        const row = await prisma.meetingParticipant
            .findUnique({ where: { id: participantId }, select: { userId: true } })
            .catch(() => null);
        held = {
            userId: row?.userId ?? null,
            controls: {
                muted: false,
                deafened: false,
                camera: false,
                recording: false,
                sharing: false
            },
            at: now
        };
        seats.set(participantId, held);
    }
    const before = held.controls;
    const next: SeatControls = {
        muted: said.muted ?? before.muted,
        deafened: said.deafened ?? before.deafened,
        camera: said.camera ?? before.camera,
        recording: said.recording ?? before.recording,
        sharing: said.streaming ?? before.sharing
    };
    held.at = now;
    held.controls = next;
    const changed = (Object.keys(next) as (keyof SeatControls)[]).some(
        (key) => next[key] !== before[key]
    );
    if (changed && held.userId) {
        for (const listener of registry().listeners) {
            try {
                listener(held.userId);
            } catch (caught) {
                console.error(caught);
            }
        }
    }
}

/** Hear about an account's controls moving, until the returned function is
 *  called. */
export function onControlsChanged(listener: ControlsListener): () => void {
    const { listeners } = registry();
    listeners.add(listener);
    return () => listeners.delete(listener);
}

/** The call an account is sitting in now, if any. */
export interface LiveCall {
    readonly seat: MeetingSeat;
    readonly controls: SeatControls;
    readonly mayRecord: boolean;
}

/** The lookups in flight, by account: a deck reads every call key at once,
 *  and they all ask the same question. */
const asking = new Map<string, Promise<LiveCall | null>>();

/**
 * The seat this account holds in a call that is going on, newest beat first.
 * Admitted, not left, and heard from inside the time a seat counts as there -
 * a tab closed without saying goodbye is not "in a call".
 */
export function liveCallOf(userId: string): Promise<LiveCall | null> {
    const pending = asking.get(userId);
    if (pending) return pending;
    const lookup = readLiveCall(userId).finally(() => asking.delete(userId));
    asking.set(userId, lookup);
    return lookup;
}

async function readLiveCall(userId: string): Promise<LiveCall | null> {
    const row = await prisma.meetingParticipant.findFirst({
        where: {
            userId,
            leftAt: null,
            admission: "admitted",
            lastSeenAt: { gte: new Date(Date.now() - PARTICIPANT_TTL_MS) },
            meeting: { endedAt: null }
        },
        orderBy: { lastSeenAt: "desc" },
        select: {
            id: true,
            meetingId: true,
            muted: true,
            deafened: true,
            streaming: true,
            meeting: { select: { hostId: true, channelId: true } }
        }
    });
    if (!row) return null;
    const channel = row.meeting.channelId
        ? await prisma.chatChannel.findUnique({
              where: { id: row.meeting.channelId },
              select: { kind: true }
          })
        : null;
    const held = registry().seats.get(row.id)?.controls;
    return {
        seat: { meetingId: row.meetingId, participantId: row.id, admission: "admitted" },
        controls: {
            // The row is the seat's own record of these three; the tab's word on
            // the other two is held here.
            muted: row.muted,
            deafened: row.deafened,
            sharing: row.streaming,
            camera: held?.camera ?? false,
            recording: held?.recording ?? false
        },
        mayRecord: mayRecordCall({
            viewerId: userId,
            hostId: row.meeting.hostId,
            channelKind: channel?.kind ?? null
        })
    };
}

/** Why a command was not sent. */
export type RemoteRefusal = "notInCall" | "mayNotRecord";

/** Where a switch should go, from where the seat says it is. */
export function wantedOn(which: CallSwitch, controls: SeatControls): boolean {
    switch (which) {
        case "mic":
            return controls.muted;
        case "deafen":
            return !controls.deafened;
        case "camera":
            return !controls.camera;
        case "record":
            return !controls.recording;
        case "share":
            return !controls.sharing;
    }
}

function send(seat: MeetingSeat, remote: CallRemoteCommand): void {
    publishMeetingEvent({
        meetingId: seat.meetingId,
        kind: "remote",
        participantId: seat.participantId,
        remote
    });
}

/** Flip one of the caller's own call switches. Answers where it was sent to. */
export async function flipCallSwitch(
    userId: string,
    which: CallSwitch
): Promise<{ ok: true; on: boolean } | { ok: false; refusal: RemoteRefusal }> {
    const live = await liveCallOf(userId);
    if (!live) return { ok: false, refusal: "notInCall" };
    // The call screen's own rule for the record button, asked of the same call.
    if (which === "record" && !live.mayRecord) return { ok: false, refusal: "mayNotRecord" };
    const on = wantedOn(which, live.controls);
    send(live.seat, { command: which, on });
    return { ok: true, on };
}

/** Hang up the caller's own call, in the tab that is on it. */
export async function hangUpCall(
    userId: string
): Promise<{ ok: true } | { ok: false; refusal: RemoteRefusal }> {
    const live = await liveCallOf(userId);
    if (!live) return { ok: false, refusal: "notInCall" };
    send(live.seat, { command: "hangup" });
    return { ok: true };
}

/**
 * Play a sound into the caller's own call. The soundboard's own play, with
 * every one of its checks; a room with nobody else in it has the tab sound it,
 * as the picker would.
 */
export async function playCallSound(
    userId: string,
    ref: string
): Promise<{ ok: true } | { ok: false; refusal: RemoteRefusal }> {
    const live = await liveCallOf(userId);
    if (!live) return { ok: false, refusal: "notInCall" };
    const alone = await soundboard.playSound(live.seat, ref);
    if (alone) send(live.seat, { command: "sound", played: alone });
    return { ok: true };
}

/** Most sounds a deck's picker lists. */
const PICKER_LIMIT = 100;

/**
 * The sounds a deck key can be set to: Polaris's own, then those of every space
 * this account reaches. Whether one may be played in a given call is the play's
 * question, asked on the press.
 *
 * Taken a sound from each space in turn - every space's first, then every
 * space's second - so a few full boards never crowd the other spaces out of a
 * picker that holds only so many.
 */
export async function deckSounds(
    userId: string,
    defaultName: (id: DefaultSoundId) => string
): Promise<{ value: string; label: string }[]> {
    const own = DEFAULT_SOUNDS.map((sound) => ({
        value: defaultRef(sound.id),
        label: `${sound.emoji} ${defaultName(sound.id)}`
    }));
    const spaces = [...(await reachableSpaceIds({ id: userId }))];
    if (spaces.length === 0) return own;
    const room = PICKER_LIMIT - own.length;
    if (room <= 0) return own.slice(0, PICKER_LIMIT);
    const rows = await prisma.$queryRaw<
        { id: string; name: string; emoji: string; spaceName: string; turn: bigint }[]
    >`SELECT "id", "name", "emoji", "spaceName", "turn" FROM (
        SELECT s."id", s."name", s."emoji", c."name" AS "spaceName", s."createdAt",
               ROW_NUMBER() OVER (PARTITION BY s."spaceId" ORDER BY s."createdAt", s."id") AS "turn"
        FROM "ChatSpaceSound" s
        JOIN "ChatSpace" c ON c."id" = s."spaceId"
        WHERE s."spaceId" = ANY(${spaces}::uuid[])
    ) ranked
    WHERE "turn" <= ${SOUNDBOARD_SLOTS}
    ORDER BY "turn", "spaceName", "createdAt", "id"
    LIMIT ${room}`;
    // Listed a space at a time, as a picker reads best.
    const theirs = [...rows]
        .sort((a, b) => a.spaceName.localeCompare(b.spaceName) || Number(a.turn - b.turn))
        .map((row) => ({
            value: row.id,
            label: `${row.emoji ? `${row.emoji} ` : ""}${row.name} (${row.spaceName})`
        }));
    return [...own, ...theirs].slice(0, PICKER_LIMIT);
}
