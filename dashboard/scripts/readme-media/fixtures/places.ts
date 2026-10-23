/**
 * A place somebody looks after: an invented lakeside cabin with a door lock, a
 * garage door, lights, a heat pump and four cameras, and a second place beside
 * it in the switcher. Nothing here is a real address, device or camera; each
 * camera's picture is a drawing in `media/`, named by the camera's fixture id.
 */

import { beat } from "../runtime/tour";
import { TEAM, ago, id } from "./people";
import type { SceneContext } from "../runtime/scene";
import type { CameraView } from "../../../apps/places/src/lib/cameras";
import type { PlaceView } from "../../../apps/places/src/lib/place-kinds";
import { DEFAULT_DETECTION } from "../../../apps/places/src/lib/detection";
import type { DeviceView } from "../../../apps/places/src/lib/device-kinds";
import type { PlaceOverview } from "../../../apps/places/src/screens/overview/actions";

export const CABIN_ID = id("place", 1);
export const STUDIO_ID = id("place", 2);

export function places(ctx: SceneContext): PlaceView[] {
    return [
        {
            id: CABIN_ID,
            name: ctx.say("Lakeside cabin", "Cabaña del lago"),
            kind: "house",
            address: "1 Example Way",
            location: null,
            cameras: 4
        },
        {
            id: STUDIO_ID,
            name: ctx.say("Town studio", "Estudio centro"),
            kind: "office",
            address: "2 Example Way",
            location: null,
            cameras: 1
        }
    ];
}

/** A wired camera at the cabin. Its picture is `media/<id>.svg`. */
function camera(n: number, name: string, zone: string): CameraView {
    return {
        id: id("camera", n),
        name,
        placeId: CABIN_ID,
        zone,
        vendor: "onvif",
        model: null,
        modelId: "",
        power: "mains",
        address: `192.0.2.${20 + n}`,
        rtspPort: 554,
        onvifPort: 80,
        mainPath: "/stream1",
        subPath: "/stream2",
        username: "viewer",
        hasPassword: true,
        reachVia: "direct",
        detector: "local",
        detectorTargetId: null,
        detection: DEFAULT_DETECTION,
        recording: "events",
        storageTarget: "",
        retentionDays: 14,
        enabled: true,
        ptz: n === 2,
        lastSeenAt: null,
        offlineSince: null,
        roomId: "",
        privacy: false,
        privacyNative: false,
        privacyPreset: ""
    };
}

export function cameras(ctx: SceneContext): CameraView[] {
    const entrance = ctx.say("Entrance", "Entrada");
    const outside = ctx.say("Outside", "Exterior");
    return [
        camera(1, ctx.say("Front door", "Puerta principal"), entrance),
        camera(2, ctx.say("Driveway", "Acceso de coches"), outside),
        camera(3, ctx.say("Garden", "Jardín"), outside),
        camera(4, ctx.say("Garage", "Garaje"), ctx.say("Garage", "Garaje"))
    ];
}

type DeviceFields = Partial<DeviceView> & Pick<DeviceView, "kind" | "name" | "zone" | "state">;

function device(n: number, ctx: SceneContext, fields: DeviceFields): DeviceView {
    return {
        id: id("device", n),
        vendor: "mqtt",
        placeId: CABIN_ID,
        roomId: null,
        model: "Fixture",
        firmware: "1.0.0",
        doorState: "none",
        batteryPercent: null,
        batteryCritical: false,
        online: true,
        controllable: true,
        reading: null,
        stateAt: ago(ctx.now, 2),
        ...fields
    };
}

export function devices(ctx: SceneContext): DeviceView[] {
    const entrance = ctx.say("Entrance", "Entrada");
    const living = ctx.say("Living room", "Salón");
    const kitchen = ctx.say("Kitchen", "Cocina");
    const garage = ctx.say("Garage", "Garaje");
    return [
        device(1, ctx, {
            kind: "lock",
            name: ctx.say("Front door", "Puerta principal"),
            zone: entrance,
            state: beat() >= 2 ? "unlocked" : "locked",
            doorState: "closed",
            batteryPercent: 82
        }),
        device(2, ctx, {
            kind: "light",
            name: ctx.say("Porch light", "Luz del porche"),
            zone: entrance,
            state: beat() >= 1 ? "on" : "off"
        }),
        device(3, ctx, {
            kind: "lock",
            name: ctx.say("Back door", "Puerta trasera"),
            zone: kitchen,
            state: "locked",
            doorState: "closed",
            batteryPercent: 9,
            batteryCritical: true
        }),
        device(4, ctx, {
            kind: "light",
            name: ctx.say("Ceiling lights", "Luces del techo"),
            zone: living,
            state: "on",
            light: {
                brightness: { level: 70 },
                temperature: { kelvin: 2700, min: 2200, max: 6500 },
                color: null
            }
        }),
        device(5, ctx, {
            kind: "light",
            name: ctx.say("Reading lamp", "Lámpara de lectura"),
            zone: living,
            state: "on",
            light: { brightness: { level: 40 }, temperature: null, color: null }
        }),
        device(6, ctx, {
            kind: "climate",
            name: ctx.say("Heat pump", "Bomba de calor"),
            zone: living,
            state: "on",
            climate: {
                mode: "heat",
                modes: ["cool", "heat", "dry", "fan", "auto"],
                target: 21,
                min: 16,
                max: 30,
                step: 0.5,
                unit: "C",
                fan: "auto",
                fans: ["auto", "low", "medium", "high"],
                options: { swing: false, quiet: true },
                current: 19.5
            }
        }),
        device(7, ctx, {
            kind: "outlet",
            name: ctx.say("Coffee machine", "Cafetera"),
            zone: kitchen,
            state: "on"
        }),
        device(8, ctx, {
            kind: "sensor",
            name: ctx.say("Humidity", "Humedad"),
            zone: kitchen,
            state: "unknown",
            controllable: false,
            reading: { value: "48", unit: "%" }
        }),
        device(9, ctx, {
            kind: "opener",
            name: ctx.say("Garage door", "Puerta del garaje"),
            zone: garage,
            state: "off",
            doorState: "open"
        }),
        device(10, ctx, {
            kind: "outlet",
            name: ctx.say("Car charger", "Cargador del coche"),
            zone: garage,
            state: "off"
        })
    ];
}

export function placeOverview(ctx: SceneContext): PlaceOverview {
    const watched = cameras(ctx);
    return {
        placeId: CABIN_ID,
        devices: devices(ctx),
        cameras: watched,
        automations: [
            {
                id: id("automation", 1),
                name: ctx.say("Good night", "Buenas noches"),
                enabled: true,
                lastRunAt: ago(ctx.now, 60 * 13),
                lastStatus: "succeeded"
            },
            {
                id: id("automation", 2),
                name: ctx.say("Leaving the cabin", "Salir de la cabaña"),
                enabled: true,
                lastRunAt: ago(ctx.now, 60 * 26),
                lastStatus: "succeeded"
            },
            {
                id: id("automation", 3),
                name: ctx.say("Porch light at sunset", "Luz del porche al anochecer"),
                enabled: true,
                lastRunAt: null,
                lastStatus: null
            }
        ],
        events: [
            {
                id: id("place-event", 1),
                cameraName: watched[0]!.name,
                at: ago(ctx.now, 6),
                kind: "package",
                person: null,
                acked: false
            },
            {
                id: id("place-event", 2),
                cameraName: watched[1]!.name,
                at: ago(ctx.now, 38),
                kind: "vehicle",
                person: null,
                acked: true
            },
            {
                id: id("place-event", 3),
                cameraName: watched[0]!.name,
                at: ago(ctx.now, 52),
                kind: "person",
                person: TEAM.ana.name,
                acked: true
            },
            {
                id: id("place-event", 4),
                cameraName: watched[2]!.name,
                at: ago(ctx.now, 140),
                kind: "animal",
                person: null,
                acked: true
            }
        ]
    };
}
