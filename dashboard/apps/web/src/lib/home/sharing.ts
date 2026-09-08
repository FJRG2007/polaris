/**
 * Lending one door, or one camera, to somebody who does not live here.
 *
 * Places has always been all-or-nothing: `home.read` shows every camera in every
 * place and `home.control` opens every lock in them. That is right for the
 * people who live somewhere and wrong for everybody else - the cleaner, the
 * neighbour feeding the cat, the security team who should see the yard and
 * nothing else. Every lock brand solves this the same way and it is the reason
 * people buy them: a key that works on one door, on the days you say, between
 * the hours you say, a set number of times.
 *
 * So a grant (`lib/access/grants.ts`) is the second way in, and it is a
 * narrowing rather than a widening:
 *
 * - somebody holding `home.read` reaches everything, exactly as before, and
 *   nothing here is consulted for them;
 * - somebody holding nothing reaches precisely what they were given, sees only
 *   that on the screen, and is refused everything else;
 * - `home.control` is what opens a door for a resident; a `control` grant is
 *   what opens one door for a visitor, and it is counted.
 *
 * **Only an act spends a use.** Drawing the lock, reading whether it is shut,
 * refreshing the screen - none of those are opening the door, and a four-use
 * grant that spent one on every render would be finished before the visitor
 * arrived. The spend happens after the device actually moved, so a door that
 * refused costs nothing.
 */

import { cache } from "react";
import * as core from "@polaris/core";
import { HomeError } from "@/lib/home/home-error";
import { sessionCan, type SessionUser } from "@/lib/session";
import {
    grantedSubjects,
    liveGrants,
    reachesAnySubject,
    spendGrant,
    type LiveGrant
} from "@/lib/access/grants";

/** What one account reaches in Places. */
export interface PlacesReach {
    /**
     * Whether they hold the app's own read permission, and so reach the house
     * rather than a piece of it. Everything below is empty and unread for them:
     * a resident is not a visitor with a lot of grants.
     */
    readonly everything: boolean;
    /** Which cameras they were lent, and what they may do with each. */
    readonly cameras: ReadonlyMap<string, string>;
    /** The same for doors, openers, switches and sensors. */
    readonly devices: ReadonlyMap<string, string>;
}

/**
 * What this account reaches, resolved once for a screen.
 *
 * Two queries for somebody who was lent something and none for somebody who
 * lives here, which is the common case and the one worth not paying for.
 */
export async function placesReach(user: SessionUser): Promise<PlacesReach> {
    if (await sessionCan(user, "home.read")) {
        return { everything: true, cameras: new Map(), devices: new Map() };
    }
    const [cameras, devices] = await Promise.all([
        grantedSubjects(user.id, "place.camera"),
        grantedSubjects(user.id, "place.device")
    ]);
    return { everything: false, cameras, devices };
}

/**
 * Whether they reach Places at all, which is what decides if the app is in
 * their switcher. Somebody lent one door has an app to open.
 *
 * On the path that draws the navigation of every screen in the app, and asked
 * for everybody who does not hold `home.read` - which is most people. So it is
 * one query for both kinds rather than one each, and it is held for the length
 * of a request: a page that resolves its navigation, its landing path and a
 * refusal's destination asks this three times and pays for it once.
 */
export const reachesPlaces = cache(
    async (userId: string): Promise<boolean> =>
        reachesAnySubject(userId, ["place.camera", "place.device"])
);

/** Whether a reach covers one camera. */
export function reachesCamera(reach: PlacesReach, cameraId: string): boolean {
    return reach.everything || reach.cameras.has(cameraId);
}

/** And one device, at the strength asked for. */
export function reachesDevice(
    reach: PlacesReach,
    deviceId: string,
    wanted: "view" | "control" = "view"
): boolean {
    if (reach.everything) return true;
    const held = reach.devices.get(deviceId);
    return Boolean(held && core.atLeast("place.device", held, wanted));
}

/**
 * Whatever of a list this account may see.
 *
 * Given the whole list and returning part of it, rather than narrowing the
 * query: the reach is a set of ids resolved from grants that no database join
 * reaches, and a house has tens of cameras rather than thousands.
 */
export function onlyReachable<T extends { id: string }>(
    things: readonly T[],
    allowed: ReadonlyMap<string, string> | true
): T[] {
    return allowed === true ? [...things] : things.filter((thing) => allowed.has(thing.id));
}

/**
 * Whether this account may watch one camera.
 *
 * The question the three routes that serve pictures ask - the stream, the
 * snapshot and the playlist - and it has to be all three, because a camera whose
 * live view is refused and whose stills are not is a camera that is not refused.
 */
export async function mayWatchCamera(user: SessionUser, cameraId: string): Promise<boolean> {
    if (await sessionCan(user, "home.read")) return true;
    return (await liveGrants(user.id, "place.camera", cameraId)).length > 0;
}

/** Refused because this camera was not lent to them. The same sentence whether
 *  it exists or not: a stranger guessing ids learns nothing either way. */
export async function requireCameraView(user: SessionUser, cameraId: string): Promise<void> {
    if (!(await mayWatchCamera(user, cameraId))) {
        throw new HomeError("That camera is not shared with you");
    }
}

/**
 * The right to open one door, and the grant that gives it.
 *
 * A resident gets null: they hold `home.control`, and there is nothing to
 * count. A visitor gets the grant back so the caller can spend it *after* the
 * door has actually moved - see the note at the top of this file.
 */
export async function requireDeviceControl(
    user: SessionUser,
    deviceId: string
): Promise<LiveGrant | null> {
    if (await sessionCan(user, "home.control")) return null;
    const held = await liveGrants(user.id, "place.device", deviceId);
    const usable = held.find((grant) => core.atLeast("place.device", grant.capability, "control"));
    if (!usable) {
        // Deliberately one sentence for three cases - never lent, lent but out
        // of hours, lent but used up - because the screen says which: it has the
        // grant in front of it, and this is the path somebody reaches by editing
        // an address.
        throw new HomeError("You cannot operate that from here");
    }
    return usable;
}

/** Seeing a device, which is the weaker half of the same question. */
export async function requireDeviceView(user: SessionUser, deviceId: string): Promise<void> {
    if (await sessionCan(user, "home.read")) return;
    const held = await liveGrants(user.id, "place.device", deviceId);
    if (held.length === 0) throw new HomeError("That device is not shared with you");
}

/**
 * Count the use, now that the thing has happened.
 *
 * Never before: a door that would not move has not been used, and charging a
 * visitor for it would leave them locked out by a failure that was not theirs.
 *
 * And never the other way round either. This is bookkeeping about an act that is
 * already over - the door has moved - so a grant revoked in between, or anything
 * else that goes wrong writing the count, is logged rather than raised. Telling
 * somebody the door did not open when it did is the worse of the two answers.
 */
export async function countDeviceUse(grant: LiveGrant | null): Promise<void> {
    if (!grant) return;
    try {
        await spendGrant(grant);
    } catch (caught) {
        console.error("places: a use could not be counted", caught);
    }
}
