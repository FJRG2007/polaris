/**
 * Places on a deck: what a device key shows is in its reader's language.
 */

import { describe, expect, it } from "vitest";

const { placesDeckActions } = await import("@polaris-app/places/src/lib/deck-actions");

const toggle = placesDeckActions().find((action) => action.id === "places.device-toggle")!;
const device = (online: boolean, state = "on") => ({
    devices: [{ id: "d1", name: "Lamp", state, online, operable: true, actions: [] }]
});

describe("places device state", () => {
    it("names an offline device in the reader's language", () => {
        expect(toggle.read!.pick(device(false), "en-US")).toEqual({
            tone: "bad",
            detail: "Offline"
        });
        expect(toggle.read!.pick(device(false), "es-ES")).toEqual({
            tone: "bad",
            detail: "Sin conexión"
        });
    });

    it("shows an online device as on or off with no words", () => {
        expect(toggle.read!.pick(device(true), "es-ES")).toEqual({ tone: "ok", on: true });
        expect(toggle.read!.pick(device(true, "off"), "en-US")).toEqual({
            tone: "idle",
            on: false
        });
    });
});
