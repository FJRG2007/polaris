/**
 * Pointing a camera somewhere else.
 *
 * Only some cameras move, and whether a particular one does is asked of it
 * rather than assumed from its make - a model that generally pans says nothing
 * about the one bolted to a wall bracket. What comes back decides whether the
 * arrows are drawn at all, because an arrow that does nothing is worse than no
 * arrow.
 *
 * Movement is continuous: the camera starts when the button goes down and keeps
 * going until it is told to stop. That is what a person holding an arrow
 * expects, and it is also the failure mode to respect - a camera left moving
 * keeps moving, so every start is paired with a stop, and the stop is sent on
 * release, on leaving the button, and when the page goes away.
 *
 * Server-only.
 */

import { prisma } from "@polaris/db";
import { cameraTarget } from "./cameras";
import { HomeError } from "./home-error";
import { hasNativePrivacy } from "./vendors";
import {
    getPresets,
    getProfiles,
    gotoPreset,
    removePreset,
    setPreset,
    ptzMove,
    ptzStop,
    OnvifError,
    type OnvifEndpoint
} from "./onvif";

/** Which way, as a person would say it. */
export type PtzDirection = "up" | "down" | "left" | "right" | "in" | "out";

/** How fast, as a fraction of the camera's own top speed. Deliberately not
 *  configurable: half speed is controllable on every camera anybody owns, and
 *  full speed on a cheap one overshoots the doorway every time. */
const SPEED = 0.5;

const VECTORS: Readonly<Record<PtzDirection, { pan: number; tilt: number; zoom: number }>> = {
    left: { pan: -SPEED, tilt: 0, zoom: 0 },
    right: { pan: SPEED, tilt: 0, zoom: 0 },
    up: { pan: 0, tilt: SPEED, zoom: 0 },
    down: { pan: 0, tilt: -SPEED, zoom: 0 },
    in: { pan: 0, tilt: 0, zoom: SPEED },
    out: { pan: 0, tilt: 0, zoom: -SPEED }
};

/** The camera's main profile token, which every PTZ call has to name.
 *
 *  Held for a few minutes: it never changes while a camera is a camera, and
 *  asking for it before every arrow press would put a round trip in front of
 *  something that has to feel immediate. */
const profiles = new Map<string, { token: string; at: number }>();
const PROFILE_TTL_MS = 5 * 60_000;

interface Controls {
    endpoint: OnvifEndpoint;
    profileToken: string;
}

/** What is needed to command one camera, or null when it does not speak ONVIF. */
async function controlsFor(installedAppId: string, cameraId: string): Promise<Controls | null> {
    const target = await cameraTarget(installedAppId, cameraId);
    if (!target?.onvifPort) return null;
    const endpoint: OnvifEndpoint = {
        address: target.address,
        port: target.onvifPort,
        username: target.username,
        password: target.password
    };
    const cached = profiles.get(cameraId);
    if (cached && Date.now() - cached.at < PROFILE_TTL_MS) {
        return { endpoint, profileToken: cached.token };
    }
    const found = await getProfiles(endpoint);
    const token = found[0]?.token;
    if (!token) return null;
    profiles.set(cameraId, { token, at: Date.now() });
    return { endpoint, profileToken: token };
}

/**
 * What each camera was last asked to do, so a start that answers late can tell
 * whether it was overtaken.
 *
 * The press and the release are separate requests, and on a slow camera the
 * release can reach Polaris - and its stop the camera - before the start has
 * been answered. A camera that takes the start after the stop is a camera left
 * moving with nobody holding the arrow, so a start that comes back to find a
 * stop was asked for since is followed by another stop.
 */
const lastAsked = new Map<string, { readonly press: number; readonly stopped: boolean }>();
let presses = 0;

/** Whether a start that has just been answered must be followed by a stop:
 *  the last thing asked of this camera since was a stop. Pure for the test. */
export function overtakenByStop(
    asked: { readonly press: number; readonly stopped: boolean } | undefined,
    press: number
): boolean {
    return asked !== undefined && asked.press === press && asked.stopped;
}

/** A start that ran into trouble, in the words the screen shows. */
function moveFailure(error: unknown): never {
    if (error instanceof OnvifError && error.failure === "timeout") {
        throw new HomeError("The camera did not take that move in time and was told to stop");
    }
    if (error instanceof OnvifError && error.failure === "unreachable") {
        throw new HomeError("Could not reach the camera to move it");
    }
    throw error;
}

/** Start moving. Pair it with `stop`. */
export async function move(
    installedAppId: string,
    cameraId: string,
    direction: PtzDirection
): Promise<void> {
    // Recorded before anything is awaited, so a release that arrives while the
    // camera's profile is still being looked up already counts as after it.
    presses += 1;
    const press = presses;
    lastAsked.set(cameraId, { press, stopped: false });
    const controls = await controlsFor(installedAppId, cameraId);
    if (!controls) throw new HomeError("This camera does not move");
    try {
        await ptzMove(controls.endpoint, controls.profileToken, VECTORS[direction]);
    } catch (error) {
        // A start nobody heard back from may still be carried out, after
        // whatever stop the release sent. Another stop goes behind it, so a
        // camera that queues its requests stops after it moves.
        if (error instanceof OnvifError && error.failure !== "refused") {
            await ptzStop(controls.endpoint, controls.profileToken).catch(() => undefined);
        }
        moveFailure(error);
    }
    if (overtakenByStop(lastAsked.get(cameraId), press)) {
        await ptzStop(controls.endpoint, controls.profileToken).catch(() => undefined);
    }
}

/** Stop moving. Never refuses loudly: a stop that fails because the camera has
 *  already stopped is the state we were asking for, and the one thing worse than
 *  a failed stop is a screen that hides it behind an error. */
export async function stop(installedAppId: string, cameraId: string): Promise<void> {
    const asked = lastAsked.get(cameraId);
    if (asked) lastAsked.set(cameraId, { press: asked.press, stopped: true });
    const controls = await controlsFor(installedAppId, cameraId);
    if (!controls) return;
    await ptzStop(controls.endpoint, controls.profileToken).catch(() => undefined);
}

/** The positions already saved on the camera itself. Polaris keeps none of its
 *  own: the camera remembers them, and it is the thing that has to reach them. */
export async function presets(
    installedAppId: string,
    cameraId: string
): Promise<{ token: string; name: string }[]> {
    const controls = await controlsFor(installedAppId, cameraId);
    if (!controls) return [];
    return getPresets(controls.endpoint, controls.profileToken).catch(() => []);
}

export async function goTo(
    installedAppId: string,
    cameraId: string,
    preset: string
): Promise<void> {
    const controls = await controlsFor(installedAppId, cameraId);
    if (!controls) throw new HomeError("This camera does not move");
    await gotoPreset(controls.endpoint, controls.profileToken, preset);
}

/** The name the privacy position is saved under on the camera, so it is
 *  recognisable in the camera's own app. */
const PRIVACY_PRESET_NAME = "Polaris privacy";

async function privacyRow(installedAppId: string, cameraId: string) {
    const row = await prisma.camera.findFirst({
        where: { id: cameraId, installedAppId },
        select: { vendor: true, privacyPreset: true }
    });
    if (!row) throw new HomeError("Camera not found");
    // A camera with a privacy mode of its own is switched itself; Polaris never
    // points it anywhere for privacy.
    if (hasNativePrivacy(row.vendor)) throw new HomeError("This camera has its own privacy mode");
    return row;
}

/**
 * Where the camera points now becomes where it turns when it goes private:
 * saved as a preset on the camera (the one saved before is moved, not
 * duplicated) and its token stored. Answers the token.
 */
export async function savePrivacyPosition(installedAppId: string, cameraId: string): Promise<string> {
    const row = await privacyRow(installedAppId, cameraId);
    const controls = await controlsFor(installedAppId, cameraId);
    if (!controls) throw new HomeError("This camera does not move");
    let token: string;
    try {
        token = await setPreset(controls.endpoint, controls.profileToken, PRIVACY_PRESET_NAME, row.privacyPreset);
    } catch (error) {
        if (error instanceof OnvifError && error.failure !== "refused")
            throw new HomeError("Could not reach the camera to move it");
        throw new HomeError("The camera would not save that position");
    }
    await prisma.camera.update({ where: { id: cameraId }, data: { privacyPreset: token } });
    return token;
}

/** Forget the privacy position. The preset is taken off the camera too, best
 *  effort: a camera that cannot be reached still stops being turned. */
export async function clearPrivacyPosition(installedAppId: string, cameraId: string): Promise<void> {
    const row = await privacyRow(installedAppId, cameraId);
    if (!row.privacyPreset) return;
    const controls = await controlsFor(installedAppId, cameraId).catch(() => null);
    if (controls)
        await removePreset(controls.endpoint, controls.profileToken, row.privacyPreset).catch(() => undefined);
    await prisma.camera.update({ where: { id: cameraId }, data: { privacyPreset: null } });
}
