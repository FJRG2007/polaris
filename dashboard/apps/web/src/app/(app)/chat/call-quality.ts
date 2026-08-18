"use client";

/**
 * How much picture a call sends.
 *
 * Two ladders - one for the camera, one for a shared screen - and one setting
 * per ladder, kept for this browser. Each rung is a capture size, a framerate
 * and a ceiling on the bits, and the three move together because they have to:
 * a 180p picture given a 3 Mbps allowance is 3 Mbps of 180p, which is worse than
 * useless. The numbers are the media server client's own presets rather than
 * invented ones, so they are the sizes the layer machinery is built around.
 *
 * The default is `auto`, and auto is not a synonym for "medium". It starts where
 * a healthy line belongs and walks down a rung at a time while the connection is
 * poor, back up while it is excellent - see `driftAuto`. Somebody who would
 * rather decide for themselves picks a rung and it stays there, which is the
 * point of the setting: a laptop on tethered data and a desk on fibre want
 * opposite things and neither is a bug.
 *
 * Auto deliberately stops climbing below the top of the ladder. The top rung is
 * a decision - "send my screen at its real size, I know what it costs" - and not
 * something to be arrived at by a connection that happened to look good for half
 * a minute.
 *
 * Kept per browser rather than per account, like the volumes and the microphone
 * cleanup: it is a fact about a line and a machine, not about a person.
 */

import { useCallback, useEffect, useState } from "react";

/** A rung, once auto has resolved to one. */
export type CallLevel = "low" | "medium" | "high" | "max";

/** What somebody chose: a rung, or letting the connection choose. */
export type CallQuality = "auto" | CallLevel;

/** Low to high. The order is the ladder - `shift` walks this array. */
export const LEVELS: readonly CallLevel[] = ["low", "medium", "high", "max"];

const QUALITIES: readonly CallQuality[] = ["auto", ...LEVELS];

/** One rung: what to ask the device for, and what to let the encoder spend. */
export interface QualityRung {
    /** Absent on the top screen rung, which is "whatever the display is". */
    readonly width?: number;
    readonly height?: number;
    readonly frameRate: number;
    readonly maxBitrate: number;
    /** What the reader sees on the bar. */
    readonly label: string;
    /** The size, said plainly, for the line under the bar. */
    readonly detail: string;
}

export interface QualityLadder {
    readonly rungs: Readonly<Record<CallLevel, QualityRung>>;
    /** Where auto starts, and the highest rung it will climb back to. */
    readonly ceiling: CallLevel;
    /** The lowest rung auto will drop to. Below this is not a call. */
    readonly floor: CallLevel;
}

/**
 * The camera.
 *
 * 720p30 is the top of the automatic range for the same reason every other call
 * client stops there: it is the last size a normal upstream holds without
 * noticing, and the difference between it and 1080p on a tile the size of a
 * playing card is nothing at all. 1080p is a rung somebody asks for.
 */
export const CAMERA_LADDER: QualityLadder = {
    rungs: {
        low: {
            width: 320,
            height: 180,
            frameRate: 20,
            maxBitrate: 200_000,
            label: "Low",
            detail: "180p"
        },
        medium: {
            width: 640,
            height: 360,
            frameRate: 24,
            maxBitrate: 500_000,
            label: "Medium",
            detail: "360p"
        },
        high: {
            width: 1280,
            height: 720,
            frameRate: 30,
            maxBitrate: 1_700_000,
            label: "High",
            detail: "720p"
        },
        max: {
            width: 1920,
            height: 1080,
            frameRate: 30,
            maxBitrate: 3_000_000,
            label: "Highest",
            detail: "1080p"
        }
    },
    ceiling: "high",
    floor: "low"
};

/**
 * A shared screen.
 *
 * The framerate is the interesting axis here rather than the size, because a
 * screen is two different things: a document, which wants every pixel and does
 * not move, and a video or a game, which wants every frame and forgives a soft
 * one. So the rungs climb in framerate first and the encoder is told which of
 * the two it is looking at - see `screenIsMotion`.
 *
 * The top rung sends the display at its own resolution, uncapped. That is
 * several megabits of upstream when the picture is busy, which is why it is not
 * somewhere auto can wander.
 */
export const SCREEN_LADDER: QualityLadder = {
    rungs: {
        low: {
            width: 1280,
            height: 720,
            frameRate: 5,
            maxBitrate: 800_000,
            label: "Low",
            detail: "720p, 5 fps"
        },
        medium: {
            width: 1920,
            height: 1080,
            frameRate: 15,
            maxBitrate: 2_500_000,
            label: "Medium",
            detail: "1080p, 15 fps"
        },
        high: {
            width: 1920,
            height: 1080,
            frameRate: 30,
            maxBitrate: 5_000_000,
            label: "High",
            detail: "1080p, 30 fps"
        },
        max: {
            frameRate: 30,
            maxBitrate: 7_000_000,
            label: "Highest",
            detail: "Full size, 30 fps"
        }
    },
    ceiling: "high",
    floor: "low"
};

/** At or above this many frames a second, a screen is being watched rather than
 *  read. */
const MOTION_FROM_FPS = 30;

/**
 * Whether this rung is carrying moving pictures rather than a document.
 *
 * It decides two things the browser cannot work out for itself: the content hint
 * the encoder is given, and what it should give up first when the line narrows.
 * Read off the framerate, because the framerate is exactly what somebody was
 * choosing between when they moved the bar - nobody asks for 5 fps to watch a
 * video on.
 */
export function screenIsMotion(level: CallLevel): boolean {
    return SCREEN_LADDER.rungs[level].frameRate >= MOTION_FROM_FPS;
}

function index(level: CallLevel): number {
    return LEVELS.indexOf(level);
}

/** One rung along, stopping at the ends auto is allowed to reach. */
export function shift(ladder: QualityLadder, level: CallLevel, by: number): CallLevel {
    const low = index(ladder.floor);
    const high = index(ladder.ceiling);
    // Clamped from both directions, so a hand-picked rung above the ceiling is
    // brought back into range rather than climbing further.
    const wanted = Math.min(high, Math.max(low, index(level) + by));
    return LEVELS[wanted] ?? level;
}

/** How auto is doing: the rung it settled on, and how long it has looked good. */
export interface AutoState {
    readonly level: CallLevel;
    /** Consecutive healthy readings since the last change. */
    readonly healthy: number;
}

/** Readings of "excellent" in a row before auto tries a bigger picture. Four of
 *  them at a quarter minute each is a minute of calm, which is long enough that
 *  a lull between two bad patches does not count as a recovery. */
export const HEALTHY_TO_CLIMB = 4;

/** How often the connection is read. Not an event: the client reports a change,
 *  and a line that is quietly excellent for ten minutes reports nothing at all -
 *  so a call that dropped a rung during one bad minute would never climb back. */
export const DRIFT_EVERY_MS = 15_000;

/**
 * What auto should do next, given how the connection looks right now.
 *
 * Down immediately, up slowly, and that asymmetry is the whole design. Dropping
 * a rung costs a slightly softer picture and buys back the call; climbing one
 * costs the call again if the guess was wrong, so it waits until the line has
 * been convincingly fine.
 *
 * `quality` is whatever the media server last said - "excellent", "good",
 * "poor", "lost" or "unknown". Anything unrecognised holds, because a reading
 * nobody understands is not evidence of anything.
 */
export function driftAuto(state: AutoState, quality: string, ladder: QualityLadder): AutoState {
    if (quality === "poor" || quality === "lost") {
        return { level: shift(ladder, state.level, -1), healthy: 0 };
    }
    if (quality !== "excellent") return { level: state.level, healthy: 0 };
    const healthy = state.healthy + 1;
    if (healthy < HEALTHY_TO_CLIMB) return { level: state.level, healthy };
    return { level: shift(ladder, state.level, 1), healthy: 0 };
}

/** Where auto begins a call: the best rung it is allowed to reach, because a
 *  line is presumed fine until it says otherwise - starting low would open every
 *  call soft and take a minute to sharpen. */
export function startAuto(ladder: QualityLadder): AutoState {
    return { level: ladder.ceiling, healthy: 0 };
}

/** The rung actually in force: the one somebody picked, or the one auto is on. */
export function levelOf(setting: CallQuality, auto: CallLevel): CallLevel {
    return setting === "auto" ? auto : setting;
}

/**
 * What to ask the browser for when opening a camera.
 *
 * Every size is `ideal`, never `exact`, and that is not a detail: a webcam that
 * cannot do 720p must still open at whatever it can do. An exact constraint it
 * cannot meet is an `OverconstrainedError`, which is a call with no picture - a
 * quality setting that can leave somebody invisible is worse than no setting.
 * The device itself is the exception, and is exact for the reason it always was:
 * quietly opening a camera nobody chose is worse than saying it could not.
 */
export function cameraConstraints(level: CallLevel, deviceId?: string): MediaTrackConstraints {
    const rung = CAMERA_LADDER.rungs[level];
    return {
        ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
        width: { ideal: rung.width },
        height: { ideal: rung.height },
        frameRate: { ideal: rung.frameRate }
    };
}

/**
 * What to ask the browser for when sharing a screen.
 *
 * The top rung names no size at all, which is what "the display's own
 * resolution" means here - and on Safari it is the only thing that works, since
 * naming any resolution there caps the capture far below what was asked for.
 */
export function screenConstraints(level: CallLevel): MediaTrackConstraints {
    const rung = SCREEN_LADDER.rungs[level];
    return {
        ...(rung.width && rung.height
            ? { width: { ideal: rung.width }, height: { ideal: rung.height } }
            : {}),
        frameRate: { ideal: rung.frameRate }
    };
}

/** What the encoder is allowed to spend, in the shape the media server's client
 *  takes it. Kept here beside the capture size so the two cannot drift. */
export function encodingFor(
    ladder: QualityLadder,
    level: CallLevel
): { maxBitrate: number; maxFramerate: number } {
    const rung = ladder.rungs[level];
    return { maxBitrate: rung.maxBitrate, maxFramerate: rung.frameRate };
}

/**
 * Narrow a picture that is already open, without renegotiating.
 *
 * This is how auto moves: the track keeps its publication, its encoder and its
 * subscribers, and simply produces fewer, smaller frames. Republishing instead
 * would cost everybody in the call a second of black rectangle every time the
 * wifi wobbled, which is a cure worse than the disease.
 *
 * A refusal is ignored on purpose. Virtual cameras and some capture cards reject
 * `applyConstraints` outright, and the honest outcome there is the picture they
 * were already sending.
 */
export async function retune(
    track: MediaStreamTrack | null,
    want: MediaTrackConstraints
): Promise<void> {
    if (!track) return;
    await track.applyConstraints(want).catch(() => undefined);
}

const CAMERA_KEY = "polaris.call.quality.camera";
const SCREEN_KEY = "polaris.call.quality.screen";

/** What somebody who has never touched it gets, on both ladders. */
export const QUALITY_DEFAULT: CallQuality = "auto";

/** Same-tab announcement: the storage event only reaches other tabs. */
const CHANGED = "polaris:call-quality";

function read(key: string): CallQuality {
    if (typeof window === "undefined") return QUALITY_DEFAULT;
    try {
        const raw = window.localStorage.getItem(key);
        // Local storage belongs to whoever owns the browser, so anything that is
        // not a rung is treated as unset rather than handed to a constraint.
        return QUALITIES.includes(raw as CallQuality) ? (raw as CallQuality) : QUALITY_DEFAULT;
    } catch {
        return QUALITY_DEFAULT;
    }
}

function write(key: string, value: CallQuality): void {
    if (typeof window === "undefined") return;
    try {
        if (value === QUALITY_DEFAULT) window.localStorage.removeItem(key);
        else window.localStorage.setItem(key, value);
    } catch {
        // It still applies to this call; it just will not be remembered.
    }
    window.dispatchEvent(new Event(CHANGED));
}

export function cameraQuality(): CallQuality {
    return read(CAMERA_KEY);
}

export function screenQuality(): CallQuality {
    return read(SCREEN_KEY);
}

export function setCameraQuality(value: CallQuality): void {
    write(CAMERA_KEY, value);
}

export function setScreenQuality(value: CallQuality): void {
    write(SCREEN_KEY, value);
}

/** The two settings, and a way to change either. Read after mount rather than
 *  during render: the server has no local storage, and a value taken during
 *  render would not match the markup it sent. */
export function useCallQuality(): {
    camera: CallQuality;
    screen: CallQuality;
    setCamera: (value: CallQuality) => void;
    setScreen: (value: CallQuality) => void;
} {
    const [camera, setCameraState] = useState<CallQuality>(QUALITY_DEFAULT);
    const [screen, setScreenState] = useState<CallQuality>(QUALITY_DEFAULT);

    useEffect(() => {
        const sync = () => {
            setCameraState(cameraQuality());
            setScreenState(screenQuality());
        };
        sync();
        window.addEventListener(CHANGED, sync);
        window.addEventListener("storage", sync);
        return () => {
            window.removeEventListener(CHANGED, sync);
            window.removeEventListener("storage", sync);
        };
    }, []);

    const setCamera = useCallback((value: CallQuality) => {
        setCameraState(value);
        setCameraQuality(value);
    }, []);

    const setScreen = useCallback((value: CallQuality) => {
        setScreenState(value);
        setScreenQuality(value);
    }, []);

    return { camera, screen, setCamera, setScreen };
}
