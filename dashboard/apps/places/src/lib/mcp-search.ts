/**
 * Places, as `polaris_search` finds it.
 *
 * Offered through the `mcpSearch` hook, beside the tools in `mcp-tools.ts`, and
 * held to the same rules: `placesReach` and `onlyReachable` decide what the
 * person sees, so somebody lent one door finds that door, its place and its
 * room, and nothing else of the house. Cameras are found by name and place,
 * and point at the picture tool, which holds its own scope.
 * Routines are found only by somebody who manages the house, as on the
 * routines screen.
 *
 * Server-only.
 */

import * as places from "./places";
import * as devices from "./devices";
import * as cameras from "./cameras";
import { homeInstall } from "./access";
import { host } from "@polaris/app-host";
import * as automations from "./automations";
import type { AppHostTypes } from "@polaris/app-host";
import { onlyReachable, placesReach, reachesDevice } from "./sharing";
import { DEVICE_KIND_LABELS, deviceKind } from "./device-kinds";

type McpCaller = AppHostTypes["McpCaller"];
type McpSearchHit = AppHostTypes["McpSearchHit"];
type McpSearchProvider = AppHostTypes["McpSearchProvider"];

/** The person and the house a search is for, or null when either is not
 *  there - nothing to find is not a failure. */
async function contextFor(caller: McpCaller) {
    const [user, install] = await Promise.all([host.mcp.actingUser(caller.userId), homeInstall()]);
    return user && install ? { user, install } : null;
}

/** Where something is, as one line: the place and the room. */
function whereOf(place: string | null | undefined, zone: string | null | undefined) {
    return [place, zone].filter(Boolean).join(" / ") || null;
}

const thingsProvider = () =>
    host.mcp.defineSearch({
        id: "places.things",
        app: "places",
        category: "home",
        scope: "places.read",
        async search(_query, caller, limit) {
            const context = await contextFor(caller);
            if (!context) return [];
            const reach = await placesReach(context.user);
            const [deviceList, cameraList, placeList] = await Promise.all([
                devices.listDevices(context.install.id),
                cameras.listCameras(context.install.id),
                places.listPlaces(context.install.id)
            ]);
            const placeName = new Map(placeList.map((place) => [place.id, place.name]));
            const seenDevices = onlyReachable(deviceList, reach.everything || reach.devices);
            const seenCameras = onlyReachable(cameraList, reach.everything || reach.cameras);

            const hits: McpSearchHit[] = [];
            for (const device of seenDevices) {
                const place = device.placeId ? placeName.get(device.placeId) : null;
                hits.push({
                    id: device.id,
                    name: device.name,
                    kind: "device",
                    where: whereOf(place, device.zone),
                    keywords: [device.kind, DEVICE_KIND_LABELS[deviceKind(device.kind)]],
                    next: [
                        ...(device.controllable && reachesDevice(reach, device.id, "control")
                            ? [{ tool: "places_device_control", args: { deviceId: device.id } }]
                            : []),
                        { tool: "places_devices", args: { deviceId: device.id } }
                    ]
                });
            }
            for (const camera of seenCameras) {
                hits.push({
                    id: camera.id,
                    name: camera.name,
                    kind: "camera",
                    where: whereOf(placeName.get(camera.placeId), camera.zone),
                    keywords: ["camera"],
                    next: [{ tool: "places_camera_snapshot", args: { cameraId: camera.id } }]
                });
            }

            // The places and rooms the person reaches something in: all of them
            // for somebody who lives here, only the ones holding what they were
            // lent otherwise.
            const placesSeen = reach.everything
                ? placeList.map((place) => place.id)
                : [
                      ...seenDevices.map((device) => device.placeId),
                      ...seenCameras.map((camera) => camera.placeId)
                  ];
            for (const place of placeList) {
                if (!placesSeen.includes(place.id)) continue;
                hits.push({
                    id: place.id,
                    name: place.name,
                    kind: "place",
                    keywords: [place.kind, place.address],
                    next: [{ tool: "places_devices", args: { query: place.name } }]
                });
            }
            const rooms = new Map<string, { zone: string; place: string | null }>();
            for (const thing of [...seenDevices, ...seenCameras]) {
                if (!thing.zone) continue;
                const place = thing.placeId ? (placeName.get(thing.placeId) ?? null) : null;
                rooms.set(`${thing.placeId ?? ""}:${thing.zone}`, { zone: thing.zone, place });
            }
            for (const [id, room] of rooms) {
                hits.push({
                    id,
                    name: room.zone,
                    kind: "room",
                    where: room.place,
                    keywords: ["zone"],
                    next: [{ tool: "places_devices", args: { query: room.zone } }]
                });
            }
            return hits.slice(0, limit);
        }
    });

const routinesProvider = () =>
    host.mcp.defineSearch({
        id: "places.routines",
        app: "places",
        category: "home",
        scope: "places.routines",
        async search(_query, caller, limit) {
            const context = await contextFor(caller);
            if (!context) return [];
            // The routines screen's own rule: managing the house.
            if (!(await host.session.sessionCan(context.user, "home.manage"))) return [];
            const placeList = await places.listPlaces(context.install.id);
            const lists = await Promise.all(
                placeList.map(async (place) =>
                    (await automations.listAutomations(context.install.id, place.id)).map(
                        (routine): McpSearchHit => ({
                            id: routine.id,
                            name: routine.name,
                            kind: "routine",
                            where: place.name,
                            keywords: [routine.enabled ? "on" : "off"],
                            next: [
                                { tool: "places_routine_run", args: { routineId: routine.id } },
                                { tool: "places_routines" }
                            ]
                        })
                    )
                )
            );
            return lists.flat().slice(0, limit);
        }
    });

/** Built when first asked for, as the tools are: `defineSearch` is the host's. */
let built: readonly McpSearchProvider[] | undefined;

export function placesMcpSearch(): readonly McpSearchProvider[] {
    built ??= [thingsProvider(), routinesProvider()];
    return built;
}
