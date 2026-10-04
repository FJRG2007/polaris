"use server";

/**
 * What a place's Overview reads, in one call.
 *
 * One call rather than the four the other screens make, because a browser runs
 * server actions one after another: four separate asks would be four round trips
 * in a row before the page was whole.
 *
 * Every part is narrowed exactly as on its own screen. A visitor lent one door or
 * one camera reads that and nothing else, and is never handed the house's
 * automations or what its cameras noticed - those are `home.read`, which a
 * visitor does not hold.
 */

import { prisma } from "@polaris/db";
import * as events from "../../lib/events";
import * as devices from "../../lib/devices";
import * as cameras from "../../lib/cameras";
import { guard } from "../../lib/action-guard";
import { onlyReachable } from "../../lib/sharing";
import * as automations from "../../lib/automations";
import { requireHomeShared } from "../../lib/access";
import { currentPlace } from "../../lib/current-place";
import type { DeviceView } from "../../lib/device-kinds";
import type { AutomationView } from "../../lib/automation-kinds";

/** How many of the latest detections the Overview lists. */
const RECENT_EVENTS = 6;

/** A detection as the Overview lists it: what, where and when. */
export interface OverviewEvent {
    readonly id: string;
    readonly cameraName: string;
    readonly at: string;
    readonly kind: string;
    /** Who it was, when the recognizer knew them. */
    readonly person: string | null;
    readonly acked: boolean;
}

/** An automation as the Overview's quick-run list needs it. */
export interface OverviewAutomation {
    readonly id: string;
    readonly name: string;
    readonly enabled: boolean;
    readonly lastRunAt: string | null;
    readonly lastStatus: AutomationView["lastStatus"];
}

export interface PlaceOverview {
    readonly placeId: string;
    readonly devices: DeviceView[];
    readonly cameras: cameras.CameraView[];
    /** Null for a visitor, who is shown neither of these. */
    readonly automations: OverviewAutomation[] | null;
    readonly events: OverviewEvent[] | null;
}

/**
 * The Overview of the place being looked at.
 *
 * `sync` asks the device accounts what they have now before listing, the same
 * quiet read the devices screen makes on its timer. Only for somebody who lives
 * here: it is a call to the house's accounts, and a visitor's screen refreshes
 * from what is already known.
 */
export async function placeOverviewAction(
    options: { sync?: boolean } = {}
): Promise<{ overview?: PlaceOverview; error?: string }> {
    const { install, reach } = await requireHomeShared();
    const result = await guard(async (): Promise<PlaceOverview> => {
        const { current } = await currentPlace(install.id);
        if (options.sync === true && reach.everything) {
            await devices.syncDevices(install.id, { probe: false });
        }
        const [deviceList, cameraList, automationList, eventList] = await Promise.all([
            devices.listDevices(install.id, current.id),
            cameras.listCameras(install.id, current.id),
            reach.everything ? automations.listAutomations(install.id, current.id) : null,
            reach.everything
                ? events.listEvents(install.id, { placeId: current.id, limit: RECENT_EVENTS })
                : null
        ]);
        return {
            placeId: current.id,
            devices: onlyReachable(deviceList, reach.everything || reach.devices),
            cameras: onlyReachable(cameraList, reach.everything || reach.cameras),
            automations:
                automationList?.map((automation) => ({
                    id: automation.id,
                    name: automation.name,
                    enabled: automation.enabled,
                    lastRunAt: automation.lastRunAt,
                    lastStatus: automation.lastStatus
                })) ?? null,
            events: eventList ? await withNames(install.id, eventList) : null
        };
    });
    return result.error ? { error: result.error } : { overview: result.value };
}

/** The events with the people in them named, in one read for all of them. */
async function withNames(
    installedAppId: string,
    list: readonly events.EventView[]
): Promise<OverviewEvent[]> {
    const subjects = [...new Set(list.flatMap((event) => (event.label ? [event.label] : [])))];
    const known = subjects.length
        ? await prisma.homePerson.findMany({
              where: { installedAppId, subjectId: { in: subjects } },
              select: { subjectId: true, name: true }
          })
        : [];
    const names = new Map(known.map((person) => [person.subjectId, person.name]));
    return list.map((event) => ({
        id: event.id,
        cameraName: event.cameraName,
        at: event.at,
        kind: event.kind,
        person: event.label ? (names.get(event.label) ?? null) : null,
        acked: event.acked
    }));
}
