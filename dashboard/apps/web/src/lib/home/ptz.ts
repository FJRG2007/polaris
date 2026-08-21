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

import { cameraTarget } from "@/lib/home/cameras";
import { HomeError } from "@/lib/home/home-error";

import { getPresets, getProfiles, gotoPreset, ptzMove, ptzStop, type OnvifEndpoint } from "@/lib/home/onvif";

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

/** Start moving. Pair it with `stop`. */
export async function move(installedAppId: string, cameraId: string, direction: PtzDirection): Promise<void> {
    const controls = await controlsFor(installedAppId, cameraId);
    if (!controls) throw new HomeError("This camera does not move");
    await ptzMove(controls.endpoint, controls.profileToken, VECTORS[direction]);
}

/** Stop moving. Never refuses loudly: a stop that fails because the camera has
 *  already stopped is the state we were asking for, and the one thing worse than
 *  a failed stop is a screen that hides it behind an error. */
export async function stop(installedAppId: string, cameraId: string): Promise<void> {
    const controls = await controlsFor(installedAppId, cameraId);
    if (!controls) return;
    await ptzStop(controls.endpoint, controls.profileToken).catch(() => undefined);
}

/** The positions already saved on the camera itself. Polaris keeps none of its
 *  own: the camera remembers them, and it is the thing that has to reach them. */
export async function presets(installedAppId: string, cameraId: string): Promise<{ token: string; name: string }[]> {
    const controls = await controlsFor(installedAppId, cameraId);
    if (!controls) return [];
    return getPresets(controls.endpoint, controls.profileToken).catch(() => []);
}

export async function goTo(installedAppId: string, cameraId: string, preset: string): Promise<void> {
    const controls = await controlsFor(installedAppId, cameraId);
    if (!controls) throw new HomeError("This camera does not move");
    await gotoPreset(controls.endpoint, controls.profileToken, preset);
}
