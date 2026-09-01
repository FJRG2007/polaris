"use client";

/**
 * Getting hold of a microphone and a camera, and saying what happened when it
 * did not work.
 *
 * Shared by both ways a call is carried, because opening the devices is the one
 * part that is the same either way - and because the sentences below are the
 * only thing standing between somebody and a call where nobody can hear them
 * with nothing on screen saying why.
 */

import { withCameraDevice } from "./camera-device";
import type { CallDevice } from "./call-state";
import { micConstraints } from "./mic-cleanup";

/**
 * Open what this browser can, and say what it could not.
 *
 * Asked in three goes rather than one, because one is how a busy camera takes
 * the microphone with it: a single `getUserMedia` for both fails as a whole, so
 * somebody with Discord or OBS holding the camera joined a call able to hear and
 * unable to speak, with nothing on screen saying why. So both, then sound alone,
 * then picture alone.
 *
 * @param camera - The size to ask the camera for, from `call-quality`. Left out,
 *   the browser picks, and what it picks is 640x480 - which is where every
 *   report of a soft picture in a call came from.
 */
export async function openMedia(
    withVideo: boolean,
    camera?: MediaTrackConstraints
): Promise<{ stream: MediaStream | null; note: string }> {
    const ask = (audio: boolean, video: boolean) =>
        navigator.mediaDevices.getUserMedia({
            // Echo, background noise and a level that keeps somebody audible
            // from across the room, all handled by the browser before anything
            // is sent - see `mic-cleanup`.
            audio: audio ? micConstraints() : false,
            // Even with no size asked for, the camera this browser was told to
            // prefer: `true` opens whichever one the browser felt like, which on
            // a machine with a webcam and a capture card is a coin toss nobody
            // can see the result of until they are on screen.
            video: video ? withCameraDevice(camera ?? {}) : false
        });

    try {
        return { stream: await ask(true, withVideo), note: "" };
    } catch (first) {
        if (!withVideo) return { stream: null, note: refused(first, "microphone") };

        // The camera is the likelier of the two to be busy, and the one nobody
        // needs. Try again without it before giving up on being heard.
        try {
            return { stream: await ask(true, false), note: refused(first, "camera") };
        } catch (second) {
            try {
                return { stream: await ask(false, true), note: refused(second, "microphone") };
            } catch {
                return { stream: null, note: refused(second, "microphone or camera") };
            }
        }
    }
}

/**
 * What the browser refused, in words somebody can do something about.
 *
 * `NotReadable` is the one worth naming precisely: on Windows a device is held
 * exclusively, and "another application is using it" is a sentence somebody can
 * act on in a way that "could not reach your microphone" is not.
 */
export function refused(error: unknown, what: string): string {
    const name = error instanceof Error ? error.name : "";
    if (name === "NotAllowedError" || name === "SecurityError") {
        return `Polaris was not allowed to use your ${what}. Allow it in the address bar and rejoin.`;
    }
    if (name === "NotReadableError" || name === "AbortError") {
        return `Your ${what} is busy - another application is holding it. Close it, or pick a different device, and rejoin.`;
    }
    if (name === "NotFoundError" || name === "OverconstrainedError") {
        return `No ${what} was found on this device.`;
    }
    return `Polaris could not reach your ${what}.`;
}

/** What this browser has to offer, named. Labels are only filled in once a
 *  permission has been granted, which is why this is asked after the stream. */
export async function callDevices(): Promise<{
    microphones: CallDevice[];
    cameras: CallDevice[];
}> {
    const found = await navigator.mediaDevices.enumerateDevices().catch(() => []);
    const named = (kind: MediaDeviceKind, fallback: string): CallDevice[] =>
        found
            .filter((device) => device.kind === kind && device.deviceId)
            .map((device, index) => ({
                id: device.deviceId,
                label: device.label || `${fallback} ${index + 1}`
            }));
    return {
        microphones: named("audioinput", "Microphone"),
        cameras: named("videoinput", "Camera")
    };
}

/** What this browser's own screen is keyed by, whoever else is in the room and
 *  whether or not its seat has been named yet. A key that changed when the seat
 *  landed would take the video element down with it and drop the focus somebody
 *  had just asked for. */
export const LOCAL_SCREEN_KEY = "screen:self";

/** One screen with the big place in the room: which picture, whose, and how it
 *  is named while it is up there. */
export interface CallStage {
    readonly key: string;
    readonly stream: MediaStream;
    readonly name: string;
}

/**
 * Every screen being shared into the room, this browser's own included.
 *
 * Its own included, and that is the whole reason this exists. A screen used to
 * be folded into the sharer's own camera stream, so the one person in the call
 * who could not see what was being shared was the person sharing it: it turned
 * up in their head-sized tile down in the grid while everybody else had it
 * across the top of theirs.
 *
 * Theirs first, because it is the one they are responsible for and the one they
 * need to notice is going out. A list rather than a single value because several
 * people can share at once - each subscriber is only sent what they are
 * watching, so there was never a reason to allow only one.
 */
export function stagesOf(room: {
    localScreen: MediaStream | null;
    /** This browser's seat, which is how its own screen is recognised coming
     *  back from the server. Not known for the first moment of a call. */
    participantId: string | null;
    screens: ReadonlyMap<string, MediaStream>;
    nameOf: (personId: string) => string;
}): CallStage[] {
    const stages: CallStage[] = [];
    if (room.localScreen) {
        stages.push({ key: LOCAL_SCREEN_KEY, stream: room.localScreen, name: "Your screen" });
    }
    for (const [personId, stream] of room.screens) {
        // This browser's own screen coming back from the server, which happens
        // where a client subscribes to itself. Drawn twice it would be two
        // copies of one picture, one of them a round trip late.
        if (room.localScreen && personId === room.participantId) continue;
        stages.push({
            key: `screen:${personId}`,
            stream,
            name: `${room.nameOf(personId)} - screen`
        });
    }
    return stages;
}

/** How the room is laid out around whatever is being watched. */
export interface CallStaging {
    /** The screens with the big place, in the order they take it. */
    readonly showing: readonly CallStage[];
    /** Something is being watched, so the faces are a strip along the bottom
     *  rather than an even grid, and the panel is worth more of the column it
     *  sits in. */
    readonly staged: boolean;
    /** A screen was asked for by name and takes the panel whole. With one screen
     *  shared the faces are the only room left to give it: the share already had
     *  the big place and the strip, so "make this bigger" made nothing bigger
     *  until a second person shared. */
    readonly enlarged: boolean;
}

/**
 * What the room is built around right now.
 *
 * One answer rather than the same question asked in several places. The height
 * of the panel was decided a second time from the streams alone and disagreed
 * with the room: a face enlarged with nobody sharing got no more room, and a
 * screen hidden behind an enlarged face held room it was not using.
 *
 * @param live The key somebody asked to see bigger, already checked against
 *  what is in the room. A key naming nothing leaves the room as it was.
 */
export function stagingOf(stages: readonly CallStage[], live: string | null): CallStaging {
    // A face and a screen take the same place, so only one of them can have it.
    const camera = live !== null && live.startsWith("camera:");
    const showing = camera ? [] : stages.filter((stage) => live === null || live === stage.key);
    return {
        showing,
        staged: showing.length > 0 || camera,
        enlarged: !camera && live !== null && showing.length > 0
    };
}

/**
 * The new picture of the room, keeping every stream that has not changed.
 *
 * A `MediaStream` is what a tile's video element is pointed at, and pointing one
 * at a different object restarts it - a black frame, a re-attach, and on a wall
 * of faces all of them at once. Since the whole room is worked out on every
 * track event, that would be the ordinary case rather than a rare one, so a
 * participant whose set of tracks is unchanged keeps the exact object they had.
 *
 * Compared by track identity rather than by count: a camera swapped for another
 * camera is the same number of tracks and a completely different picture.
 */
export function settle(
    held: ReadonlyMap<string, MediaStream>,
    found: ReadonlyMap<string, MediaStreamTrack[]>
): ReadonlyMap<string, MediaStream> {
    const next = new Map<string, MediaStream>();
    for (const [id, tracks] of found) {
        const before = held.get(id);
        const same =
            before !== undefined &&
            before.getTracks().length === tracks.length &&
            tracks.every((track) => before.getTrackById(track.id) !== null);
        next.set(id, same ? before : new MediaStream(tracks));
    }
    return next;
}
