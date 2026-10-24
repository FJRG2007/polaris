/**
 * A door handed out as a link, used by somebody with no account.
 *
 * The link is a grant like any other (`lib/access/grants.ts`, principal
 * `link`): the same dates, hours, uses, actions and fence, judged the same
 * way. What is different is who is asking - nobody - so every press is
 * rate-limited by link and address, recorded with no actor, and spends a use
 * only after the door actually moved, exactly as a visitor's would.
 *
 * Server-only.
 */

import * as core from "@polaris/core";
import * as devices from "./devices";
import { prisma } from "@polaris/db";
import { host } from "@polaris/app-host";
import type { AppHostTypes } from "@polaris/app-host";
import { HomeError } from "./home-error";
import { homeInstall } from "./access";
import { requireNearby } from "./nearby";
import { countDeviceUse, isThingId, roomContents } from "./sharing";
import { getCamera } from "./cameras";
import { panelContents, panelHolds, type PanelContents } from "./panels";
import {
    actionsFor,
    grantActionFor,
    type DeviceAction,
    type DeviceCommand,
    type DeviceView
} from "./device-kinds";

type LiveGrant = AppHostTypes["LiveGrant"];

/** Presses per link and address, a minute. Enough for a person at a door who
 *  presses twice; nowhere near enough to hammer it. */
const PRESSES_PER_MINUTE = 10;

/** What the guest page draws. */
export type GuestKey =
    | {
          readonly standing: "live";
          readonly device: DeviceView;
          /** The grant actions it allows: open, close, operate. */
          readonly allowed: readonly string[];
          /** The device's buttons that spends, in the order the kind lists them. */
          readonly actions: readonly DeviceAction[];
          readonly nearbyMeters: number | null;
          readonly until: string | null;
          readonly note: string;
      }
    | { readonly standing: Exclude<core.GrantStanding, "live"> };

/** A device's actions this grant allows. */
function allowedActions(device: DeviceView, grant: LiveGrant): DeviceAction[] {
    // Buttons only: a light's sliders and an air conditioner's settings are a
    // screen of their own, and a link is one press.
    return actionsFor(device.kind).filter((action) =>
        grant.actions.includes(grantActionFor(action))
    );
}

/**
 * What a link opens right now, or null when it opens nothing at all - no such
 * link, taken back, or not a door. Says which bound stops it when one does, so
 * the guest is told "not until Tuesday" rather than "no".
 */
export async function guestKey(token: string): Promise<GuestKey | null> {
    const reached = await host.accessGrants.linkReach(token);
    if (!reached || reached.subjectType !== "place.device") return null;
    if (reached.standing !== "live") return { standing: reached.standing };
    const install = await homeInstall();
    if (!install) return null;
    const device = await devices.getDevice(install.id, reached.subjectId).catch(() => null);
    if (!device) return null;
    return {
        standing: "live",
        device,
        allowed: reached.grant.actions,
        actions: allowedActions(device, reached.grant),
        nearbyMeters: reached.grant.nearbyMeters ?? null,
        until: reached.grant.until?.toISOString() ?? null,
        note: reached.note
    };
}

/** What a room's link shows: every device and camera in the room now. */
export type GuestRoom =
    | {
          readonly standing: "live";
          readonly name: string;
          readonly devices: readonly DeviceView[];
          /** Empty unless the room was lent with `watch`. */
          readonly cameras: readonly {
              readonly id: string;
              readonly name: string;
              readonly private: boolean;
          }[];
          readonly allowed: readonly string[];
          readonly nearbyMeters: number | null;
          readonly until: string | null;
          readonly note: string;
      }
    | { readonly standing: Exclude<core.GrantStanding, "live"> };

/** A room handed out as a link, read now, or null when it names no room. */
export async function guestRoom(token: string): Promise<GuestRoom | null> {
    const reached = await host.accessGrants.linkReach(token);
    if (!reached || reached.subjectType !== "place.room") return null;
    if (reached.standing !== "live") return { standing: reached.standing };
    const install = await homeInstall();
    if (!install) return null;
    const room = await prisma.placeRoom.findFirst({
        where: { id: reached.subjectId, installedAppId: install.id },
        select: { name: true }
    });
    if (!room) return null;
    const inside = await roomContents([reached.subjectId]);
    const watches = reached.grant.actions.includes("watch");
    const [found, cameras] = await Promise.all([
        Promise.all(
            [...inside.devices.keys()].map((id) =>
                devices.getDevice(install.id, id).catch(() => null)
            )
        ),
        Promise.all(
            (watches ? [...inside.cameras.keys()] : []).map((id) =>
                getCamera(install.id, id).catch(() => null)
            )
        )
    ]);
    return {
        standing: "live",
        name: room.name,
        devices: found.filter((device): device is DeviceView => device !== null),
        cameras: cameras.flatMap((camera) =>
            camera ? [{ id: camera.id, name: camera.name, private: camera.privacy }] : []
        ),
        allowed: reached.grant.actions,
        nearbyMeters: reached.grant.nearbyMeters ?? null,
        until: reached.grant.until?.toISOString() ?? null,
        note: reached.note
    };
}

/** What a wall panel's link shows: the panel and every device on it now. */
export type GuestPanel =
    | ({
          readonly standing: "live";
          readonly allowed: readonly string[];
          readonly nearbyMeters: number | null;
          readonly until: string | null;
      } & PanelContents)
    | { readonly standing: Exclude<core.GrantStanding, "live"> };

/** A wall panel handed out as a link, read now, or null when it names none. */
export async function guestPanel(token: string): Promise<GuestPanel | null> {
    const reached = await host.accessGrants.linkReach(token);
    if (!reached || reached.subjectType !== "place.panel") return null;
    if (reached.standing !== "live") return { standing: reached.standing };
    const install = await homeInstall();
    if (!install) return null;
    const contents = await panelContents(install.id, reached.subjectId).catch(() => null);
    if (!contents) return null;
    return {
        standing: "live",
        ...contents,
        allowed: reached.grant.actions,
        nearbyMeters: reached.grant.nearbyMeters ?? null,
        until: reached.grant.until?.toISOString() ?? null
    };
}

/**
 * Press one button on a link's door. Throws a `HomeError` the guest can read -
 * a `NearbyRefusal` when the link is fenced and the browser is not near.
 */
export async function pressGuestKey(
    token: string,
    action: DeviceAction,
    where: core.ReportedLocation | null,
    ip: string,
    /** Which device, for a room's or a panel's link; a door's link names its own. */
    deviceId?: string,
    /** A light's level or colour, from a wall panel's sliders. */
    command?: DeviceCommand
): Promise<DeviceView> {
    const reached = await host.accessGrants.linkReach(token);
    const room = reached?.subjectType === "place.room";
    const panel = reached?.subjectType === "place.panel";
    if (!reached || !(room || panel || reached.subjectType === "place.device")) {
        throw new HomeError("This link does not open anything right now");
    }
    // Only a panel's link carries a setting: a door's and a room's are one press.
    if (command && !panel) throw new HomeError("This link does not allow that");
    const targetId = room || panel ? (deviceId ?? "") : reached.subjectId;
    const log = (outcome: "done" | "refused", reason = "") =>
        host.accessGrants.recordGrantUse({
            grantId: reached.standing === "live" ? reached.grant.id : null,
            subjectType: reached.subjectType,
            subjectId: reached.subjectId,
            targetType: "device",
            targetId,
            userId: null,
            linkNote: reached.note,
            action,
            outcome,
            reason
        });
    const limited = await host.rateLimitService.rateLimit(
        `guest-key:${reached.standing === "live" ? reached.grant.id : reached.subjectId}:${ip}`,
        PRESSES_PER_MINUTE,
        60_000
    );
    if (!limited.ok) throw new HomeError("Too many presses. Wait a minute and try again");
    const held = panel
        ? isThingId(targetId) && (await panelHeld(reached.subjectId, targetId))
        : !room ||
          (isThingId(targetId) && (await roomContents([reached.subjectId])).devices.has(targetId));
    if (reached.standing !== "live") {
        if (held) await log("refused", reached.standing);
        throw new HomeError("This link does not open anything right now");
    }
    if (!held) throw new HomeError("This link does not allow that");
    const install = await homeInstall();
    if (!install) throw new HomeError("This link does not open anything right now");
    const grant = reached.grant;
    if (
        !core.atLeast(reached.subjectType as core.GrantSubject, grant.capability, "control") ||
        !grant.actions.includes(grantActionFor(action))
    ) {
        await log("refused", "notThat");
        throw new HomeError("This link does not allow that");
    }
    const device = await devices.getDevice(install.id, targetId);
    const near = await requireNearby(grant.nearbyMeters, device.placeId, where).catch(
        async (caught: unknown) => {
            await log("refused", "notNearby");
            throw caught;
        }
    );
    let done: DeviceView;
    try {
        done = await devices.actOnDevice(install.id, device.id, action, "Guest link", command);
    } catch (caught) {
        await log("refused", "failed");
        await host.auditService.recordAudit({
            actorId: null,
            action: `places.device.${action}.refused`,
            targetType: "placeDevice",
            targetId: device.id,
            metadata: { link: true }
        });
        throw caught;
    }
    await countDeviceUse(grant);
    await log("done");
    await host.auditService.recordAudit({
        actorId: null,
        action: `places.device.${action}`,
        targetType: "placeDevice",
        targetId: device.id,
        metadata: { name: device.name, lent: true, link: true, ...(near ? { nearby: true } : {}) }
    });
    return done;
}

/** Whether a panel shows this device now; nothing when Places is not set up. */
async function panelHeld(panelId: string, deviceId: string): Promise<boolean> {
    const install = await homeInstall();
    return install ? panelHolds(install.id, panelId, deviceId) : false;
}
