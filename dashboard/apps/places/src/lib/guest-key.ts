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
import { host } from "@polaris/app-host";
import type { AppHostTypes } from "@polaris/app-host";
import { HomeError } from "./home-error";
import { homeInstall } from "./access";
import { requireNearby } from "./nearby";
import { countDeviceUse } from "./sharing";
import { actionsFor, grantActionFor, type DeviceAction, type DeviceView } from "./device-kinds";

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

/**
 * Press one button on a link's door. Throws a `HomeError` the guest can read -
 * a `NearbyRefusal` when the link is fenced and the browser is not near.
 */
export async function pressGuestKey(
    token: string,
    action: DeviceAction,
    where: core.ReportedLocation | null,
    ip: string
): Promise<DeviceView> {
    const reached = await host.accessGrants.linkReach(token);
    if (!reached || reached.subjectType !== "place.device" || reached.standing !== "live") {
        throw new HomeError("This link does not open anything right now");
    }
    const limited = await host.rateLimitService.rateLimit(
        `guest-key:${reached.grant.id}:${ip}`,
        PRESSES_PER_MINUTE,
        60_000
    );
    if (!limited.ok) throw new HomeError("Too many presses. Wait a minute and try again");
    const install = await homeInstall();
    if (!install) throw new HomeError("This link does not open anything right now");
    const grant = reached.grant;
    if (
        !core.atLeast("place.device", grant.capability, "control") ||
        !grant.actions.includes(grantActionFor(action))
    ) {
        throw new HomeError("This link does not allow that");
    }
    const device = await devices.getDevice(install.id, reached.subjectId);
    const near = await requireNearby(grant.nearbyMeters, device.placeId, where);
    let done: DeviceView;
    try {
        done = await devices.actOnDevice(install.id, device.id, action, "Guest link");
    } catch (caught) {
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
    await host.auditService.recordAudit({
        actorId: null,
        action: `places.device.${action}`,
        targetType: "placeDevice",
        targetId: device.id,
        metadata: { name: device.name, lent: true, link: true, ...(near ? { nearby: true } : {}) }
    });
    return done;
}
