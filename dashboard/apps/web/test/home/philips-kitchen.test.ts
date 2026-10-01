/**
 * Philips kitchen appliances over the Versuni cloud: what an airfryer's status
 * port says, in Places' words, and what stopping one sends.
 *
 * The shapes and the stop sequences are renaudallard/homeassistant_philips_homeid's
 * (`mqtt_api.py` key spellings, `test_fusion_stop.py` sequences); nothing here
 * reaches Philips.
 */

import { describe, expect, it } from "vitest";
import { placesCatalogs } from "@polaris-app/places/messages";
import * as kinds from "@polaris-app/places/src/lib/device-kinds";
import * as kitchen from "@polaris-app/places/src/lib/drivers/philips-kitchen";
import { kitchenSnapshot } from "@polaris-app/places/src/lib/drivers/philips-cloud";

/** A SPECTRE airfryer's `Status` port mid-cook. */
const SPECTRE_STATUS = {
    status: "cooking",
    temp: 180,
    cur_temp: 172,
    time: 900,
    cur_time: 712,
    preset: 3,
    temp_unit: false,
    drawer_open: false,
    recipeName: "Chicken wings"
};

/** A VENUS 2 airfryer's `venusaf_s` port, in its own spellings. */
const VENUS_STATUS = {
    status: "pause",
    temp: 200,
    curr_temp: 190,
    total_time: 1200,
    disp_time: 300,
    method: 2,
    temp_unit: true
};

describe("what a kitchen appliance is", () => {
    it("is told apart by its model, as the HomeID integration does", () => {
        expect(kitchen.kitchenType("HD9285/90")).toBe("airfryer");
        expect(kitchen.kitchenType("Venus2")).toBe("airfryer");
        expect(kitchen.kitchenType("NX0960/90")).toBe("multicooker");
        expect(kitchen.kitchenType("EP2520/10")).toBe("espresso");
        expect(kitchen.kitchenType("Flash_Entry_P EP2520")).toBe("espresso");
        expect(kitchen.kitchenType("AC0651/10")).toBeNull();
        expect(kitchen.kitchenType(null)).toBeNull();
    });

    it("reports on the port its architecture uses", () => {
        expect(kitchen.kitchenPorts("HD9285/90")).toEqual({ status: "Status", control: "Control" });
        expect(kitchen.kitchenPorts("HD9875/90")).toEqual({ status: "Status", control: "Control" });
        expect(kitchen.kitchenPorts("HD9880/90")).toEqual({
            status: "venusaf_s",
            control: "venusaf_c"
        });
    });
});

describe("what it reports", () => {
    it("reads a SPECTRE mid-cook: status, recipe, temperatures and time", () => {
        expect(kitchen.kitchenAppliance(SPECTRE_STATUS, "HD9285/90")).toEqual({
            type: "airfryer",
            status: "cooking",
            program: "Chicken wings",
            target: 180,
            current: 172,
            unit: "C",
            remaining: 712,
            total: 900,
            stoppable: true
        });
        expect(kitchen.kitchenPower(SPECTRE_STATUS, null)).toBe("on");
    });

    it("reads a Venus in its own spellings and its own unit", () => {
        expect(kitchen.kitchenAppliance(VENUS_STATUS, "HD9880/90")).toMatchObject({
            status: "pause",
            target: 200,
            current: 190,
            unit: "F",
            remaining: 300,
            total: 1200,
            stoppable: true
        });
    });

    it("leaves out a status nobody documented, and a number that is not one", () => {
        const view = kitchen.kitchenAppliance(
            { status: "warp_speed", temp: 9999, cur_time: "soon" },
            "HD9285/90"
        );
        expect(view).toMatchObject({ status: null, target: null, remaining: null });
    });

    it("watches a multicooker and an espresso machine without offering to stop them", () => {
        expect(kitchen.kitchenAppliance({ status: "cooking" }, "NX0960/90")?.stoppable).toBe(false);
        expect(kitchen.kitchenAppliance({}, "EP8757/90")).toMatchObject({
            type: "espresso",
            status: null,
            stoppable: false
        });
        // An espresso machine's power comes from the shadow.
        expect(kitchen.kitchenPower({}, true)).toBe("on");
        expect(kitchen.kitchenPower({}, null)).toBe("unknown");
    });

    it("draws as an appliance row, never with a purifier's controls", () => {
        const snapshot = kitchenSnapshot(
            { id: "a1", thing: "da-a1", name: "Kitchen", model: "HD9285/90" },
            { properties: { status: "standby" }, powerOn: null, model: null },
            true
        );
        expect(snapshot).toMatchObject({
            kind: "appliance",
            state: "off",
            appliance: { status: "standby", stoppable: true }
        });
        expect(snapshot.air).toBeUndefined();
        expect(kinds.actionsFor("appliance")).toEqual(["stop"]);
    });
});

describe("stopping it", () => {
    it("sends a SPECTRE to standby", () => {
        expect(kitchen.kitchenStop("HD9285/90", { status: "cooking" })).toEqual([
            { status: "standby" }
        ]);
    });

    it("stops a Venus through pause to the main menu", () => {
        expect(kitchen.kitchenStop("HD9875/90", { status: "cooking" })).toEqual([
            { status: "pause" },
            { status: "mainmenu" }
        ]);
    });

    it("sends a Venus in standby nothing, since the main menu would wake it", () => {
        expect(kitchen.kitchenStop("HD9880/90", { status: "standby" })).toEqual([]);
    });

    it("offers nothing that is not a verified airfryer", () => {
        expect(kitchen.kitchenStop("HD9999/10", { status: "cooking" })).toBeNull();
        expect(kitchen.kitchenStop("NX0960/90", { status: "cooking" })).toBeNull();
        expect(kitchen.kitchenStop("EP8757/90", {})).toBeNull();
    });
});

describe("its words", () => {
    const es = placesCatalogs.translator("es-ES", "places");

    it("has a word for every status, in both languages", () => {
        for (const status of kinds.APPLIANCE_STATUSES) {
            expect(kinds.applianceStatusText(status)).not.toContain("devices.");
            expect(kinds.applianceStatusText(status, es)).not.toContain("devices.");
        }
    });

    it("says where a cook has got to on one line", () => {
        const view = kitchen.kitchenAppliance(SPECTRE_STATUS, "HD9285/90")!;
        expect(kinds.applianceLine(view)).toBe("Cooking - 12 min left");
        expect(kinds.applianceLine(view, es)).toBe("Cocinando - quedan 12 min");
        expect(kinds.applianceTime(3 * 3600 + 5 * 60)).toBe("3:05 h");
    });
});
