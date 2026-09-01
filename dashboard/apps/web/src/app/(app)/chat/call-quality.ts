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
 * The default is `auto`, and auto means **the top of the ladder until something
 * says otherwise**. It opens every call at the best rung there is and only comes
 * down on evidence - see `driftAuto`. Somebody who would rather decide for
 * themselves picks a rung and it stays there, which is the point of the setting:
 * a laptop on tethered data and a desk on fibre want opposite things and neither
 * is a bug.
 *
 * Auto used to stop one rung short, on the reasoning that the top is a decision
 * somebody makes rather than somewhere a connection wanders. That was wrong in
 * practice: it meant a line that could carry 1080p all day never sent it, and
 * the setting existed to work around the default rather than to serve a
 * preference. Being greedy is only reckless without a way to notice - and there
 * is one, which is the rest of this file.
 *
 * Kept per browser rather than per account, like the volumes and the microphone
 * cleanup: it is a fact about a line and a machine, not about a person.
 */

import { withCameraDevice } from "./camera-device";
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
 * The allowances are well above the sizes they carry, deliberately. A ceiling is
 * not a target - the encoder spends what the picture needs and the bandwidth
 * estimator never lets it spend more than the line has - so a generous one costs
 * nothing on a line that cannot use it and is the whole difference on a line
 * that can. The old numbers were a codec generation behind: they were chosen for
 * an encoder that needed every bit, and starving the current one of headroom is
 * how a fast connection ends up looking like a slow one.
 */
export const CAMERA_LADDER: QualityLadder = {
    rungs: {
        low: {
            width: 320,
            height: 180,
            frameRate: 20,
            maxBitrate: 250_000,
            label: "Low",
            detail: "180p"
        },
        medium: {
            width: 640,
            height: 360,
            frameRate: 24,
            maxBitrate: 800_000,
            label: "Medium",
            detail: "360p"
        },
        high: {
            width: 1280,
            height: 720,
            frameRate: 30,
            maxBitrate: 2_500_000,
            label: "High",
            detail: "720p"
        },
        max: {
            width: 1920,
            height: 1080,
            frameRate: 30,
            maxBitrate: 5_000_000,
            label: "Highest",
            detail: "1080p"
        }
    },
    ceiling: "max",
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
 * The top rung sends the display at its own resolution, uncapped, with an
 * allowance to match - a 4K monitor full of small text is the one thing in a
 * call that can genuinely use ten megabits, and giving it less is how a shared
 * terminal comes out unreadable.
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
            maxBitrate: 3_000_000,
            label: "Medium",
            detail: "1080p, 15 fps"
        },
        high: {
            width: 1920,
            height: 1080,
            frameRate: 30,
            maxBitrate: 6_000_000,
            label: "High",
            detail: "1080p, 30 fps"
        },
        max: {
            frameRate: 30,
            maxBitrate: 10_000_000,
            label: "Highest",
            detail: "Full size, 30 fps"
        }
    },
    ceiling: "max",
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

/** How auto is doing: the rung it settled on, how long it has looked good, and
 *  the rung it has already failed at. */
export interface AutoState {
    readonly level: CallLevel;
    /** Consecutive healthy readings since the last change. */
    readonly healthy: number;
    /**
     * The lowest rung that has had to be abandoned in this call, if any.
     *
     * Climbing back into it, or into anything above it, takes far longer than
     * climbing anywhere else, and that is what stops the greedy default from
     * turning into a metronome: a machine that cannot encode 1080p cannot encode
     * it a minute later either, and without this the call would rediscover that
     * every minute for as long as it lasted, changing resolution each time.
     *
     * The lowest rather than the highest, because a line that failed at 1080p
     * and then failed at 720p has said something about 720p that remembering
     * only 1080p throws away - and throwing it away is the same metronome one
     * rung down, which is where it was actually found.
     */
    readonly blocked?: CallLevel;
}

/**
 * What the encoder and the connection are saying about the picture going out.
 *
 * Two sources, because they know different things. The media server's read of
 * the line notices packets going missing; the browser's own encoder is the only
 * thing that knows it is being held back, and by which of the two things that
 * hold it back. `qualityLimitationReason` is the whole reason auto can afford to
 * be greedy: "none" is the encoder saying it produced everything it was asked
 * for, which is a far better licence to ask for more than a guess from RTT.
 */
export interface CallHealth {
    /** "excellent", "good", "poor", "lost" or "unknown". */
    readonly connection: string;
    /** "none", "bandwidth", "cpu" or "other". Absent where the browser does not
     *  report it, which is not evidence of anything either way. */
    readonly limitation?: string;
    /**
     * Frames a second actually going out.
     *
     * Camera only, and that is not an oversight. A screen that nobody is
     * touching legitimately encodes almost nothing - there is no new picture to
     * send - so a low count there means the share is working perfectly, and
     * reading it as trouble would walk a still document down to 720p for no
     * reason. A camera always has noise in it and always has frames.
     */
    readonly fps?: number;
}

/** One report from a sender's own stats, narrowed to what the walk reads. */
export interface SenderStatEntry {
    readonly qualityLimitationReason?: string;
    readonly framesPerSecond?: number;
    readonly frameHeight?: number;
}

/**
 * Turns one encoder's stats into a reading `driftAuto` can use.
 *
 * Empty rather than absent is the ordinary case, not a strange one: a track
 * published a moment ago has no outbound report yet. It is the same "no
 * evidence" as a browser that answers nothing, and it has to be checked for,
 * because reducing an empty array with no initial value throws - inside a
 * floating promise, which would take the screen's reading down with the
 * camera's.
 */
export function senderHealthFrom(
    stats: readonly SenderStatEntry[] | undefined,
    connection: string,
    countFrames: boolean
): CallHealth {
    if (!stats || stats.length === 0) return { connection };
    const top = stats.reduce((best, entry) =>
        (entry.frameHeight ?? 0) > (best.frameHeight ?? 0) ? entry : best
    );
    // Any layer naming a limit is the encoder being held back, so the whole
    // picture is. On the current codec there is one entry; the fallback path
    // has three, and a complaint from any of them counts.
    const limited = stats.find(
        (entry) => entry.qualityLimitationReason && entry.qualityLimitationReason !== "none"
    );
    return {
        connection,
        limitation: limited?.qualityLimitationReason ?? top.qualityLimitationReason,
        fps: countFrames ? top.framesPerSecond : undefined
    };
}

/** Readings in a row before auto tries a bigger picture. Four of them at a
 *  quarter minute each is a minute of calm, which is long enough that a lull
 *  between two bad patches does not count as a recovery. */
export const HEALTHY_TO_CLIMB = 4;

/** The same, for climbing back into the rung that already failed once. Three
 *  times as long: it has been wrong there before. */
export const HEALTHY_TO_RETRY = 12;

/** Below this share of the frames a rung asked for, the picture is stuttering
 *  whatever anything else claims. Half is deliberately far down - a camera in a
 *  dim room legitimately drops to two thirds on its own. */
const STALLING_BELOW = 0.5;

/** How often the picture is read. Not an event: the client reports a change of
 *  connection quality, and a line that is quietly excellent for ten minutes
 *  reports nothing at all - so a call that dropped a rung during one bad minute
 *  would never climb back. */
export const DRIFT_EVERY_MS = 15_000;

/**
 * How often the picture is read while a call is still finding its level, and how
 * many readings that lasts.
 *
 * Auto opens at the top rung on purpose, which means a line that cannot carry it
 * has to be walked down - and at the ordinary cadence walking three rungs is
 * three quarters of a minute of stuttering before the call settles, on exactly
 * the connections least able to afford it. So the first few readings come
 * quickly: long enough to cover the whole ladder, over before anybody has
 * finished saying hello.
 */
export const DRIFT_SETTLING_MS = 5_000;

/** Readings taken at the settling cadence before the ordinary one takes over.
 *  One more than the rungs there are to come down, so the walk finishes inside
 *  the window rather than on its edge. */
export const DRIFT_SETTLING_READS = LEVELS.length;

/** Whether something is actually going wrong, as opposed to merely not being
 *  perfect. Only these three things bring the picture down. */
function struggling(health: CallHealth, ladder: QualityLadder, level: CallLevel): boolean {
    if (health.connection === "poor" || health.connection === "lost") return true;
    // The encoder naming what is holding it back. Both answers mean the rung is
    // beyond this machine or this line right now, which is exactly the question.
    if (health.limitation === "bandwidth" || health.limitation === "cpu") return true;
    if (health.fps === undefined) return false;
    return health.fps < ladder.rungs[level].frameRate * STALLING_BELOW;
}

/** Whether there is room to ask for more. Stricter than "not struggling": an
 *  encoder already trimming something is not evidence that a bigger picture
 *  would arrive intact. */
function comfortable(health: CallHealth): boolean {
    if (health.limitation !== undefined && health.limitation !== "none") return false;
    return health.connection === "excellent" || health.connection === "good";
}

/** The lower of two rungs, either of which may be absent. */
function lower(one: CallLevel | undefined, two: CallLevel): CallLevel {
    if (!one) return two;
    return index(one) <= index(two) ? one : two;
}

/**
 * What auto should do next, given how the picture is doing right now.
 *
 * Down immediately, up slowly, and that asymmetry is the whole design. Dropping
 * a rung costs a slightly softer picture and buys back the call; climbing one
 * costs the call again if the guess was wrong, so it waits until things have
 * been convincingly fine.
 *
 * The point of reading the encoder rather than only the connection is that it
 * lets the default be greedy. Asking for the top rung and watching for a
 * complaint beats settling for the middle and never finding out - and the
 * complaint, when it comes, is specific: this machine cannot encode that, or
 * this line cannot carry it.
 */
export function driftAuto(state: AutoState, health: CallHealth, ladder: QualityLadder): AutoState {
    if (struggling(health, ladder, state.level)) {
        const down = shift(ladder, state.level, -1);
        return {
            level: down,
            healthy: 0,
            // Remembered only where there was somewhere to fall from. At the
            // floor the rung is not what is wrong, and blaming it would make
            // every climb out of a bad patch take three minutes.
            blocked: down === state.level ? state.blocked : lower(state.blocked, state.level)
        };
    }
    if (!comfortable(health)) return { ...state, healthy: 0 };
    const healthy = state.healthy + 1;
    const next = shift(ladder, state.level, 1);
    // At or above the rung that failed, not merely equal to it. Equality alone
    // damped exactly one rung, and the one under it went back to the ordinary
    // pace - so a call that had already given up on two of them climbed into the
    // second every minute, failed, and came back down.
    const slow = state.blocked !== undefined && index(next) >= index(state.blocked);
    const needed = slow ? HEALTHY_TO_RETRY : HEALTHY_TO_CLIMB;
    if (healthy < needed) return { ...state, healthy };
    return { level: next, healthy: 0, blocked: state.blocked };
}

/** Where auto begins a call: the best rung there is. A line is presumed fine
 *  until it says otherwise - starting cautiously and working up means every call
 *  opens soft, and most calls are short enough that it never gets there. */
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
    const size = {
        width: { ideal: rung.width },
        height: { ideal: rung.height },
        frameRate: { ideal: rung.frameRate }
    };
    // A device named here is somebody choosing one now, and is exact. Otherwise
    // the one this browser was told to prefer, which is `ideal` for the reason
    // the sizes are: it may name a camera unplugged three days ago, and that
    // must never be why a call opens with no picture.
    return deviceId ? { ...size, deviceId: { exact: deviceId } } : withCameraDevice(size);
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
