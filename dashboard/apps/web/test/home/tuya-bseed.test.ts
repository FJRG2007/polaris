/**
 * BSEED wall switches (Tuya inside, sold for the Smart Life app), as the device
 * list answers them: a 2-gang switch with a socket on the same plate (neutral
 * required) and a 1-gang switch without neutral. Their status sets are the
 * standard Tuya switch (`kg`) points: `switch_<n>` per gang, `countdown_<n>`,
 * `relay_status` (power-on behaviour), `light_mode` (indicator) and
 * `child_lock`. Some 2-gang plates expose the socket as a third relay
 * (`switch_3`), others leave it always live and report only the two gangs -
 * both are covered.
 */

import { describe, expect, it } from "vitest";
import {
    tuyaCommandFor,
    tuyaSnapshots,
    type TuyaDeviceShape
} from "@polaris-app/places/src/lib/drivers/tuya-vocabulary";

const twoGangWithSocket = (socketRelay: boolean): TuyaDeviceShape => ({
    id: "bf3a1c0d2e4f5a6b7c8d9e",
    name: "Cocina",
    category: "kg",
    product_name: "Interruptor 2 gang con enchufe",
    online: true,
    status: [
        { code: "switch_1", value: true },
        { code: "switch_2", value: false },
        ...(socketRelay ? [{ code: "switch_3", value: true }] : []),
        { code: "countdown_1", value: 0 },
        { code: "countdown_2", value: 0 },
        { code: "relay_status", value: "last" },
        { code: "light_mode", value: "relay" },
        { code: "child_lock", value: false }
    ]
});

const oneGangNoNeutral: TuyaDeviceShape = {
    id: "bf9e8d7c6b5a4f3e2d1c0b",
    name: "Pasillo",
    category: "kg",
    product_name: "Interruptor 1 gang sin neutro",
    online: true,
    status: [
        { code: "switch_1", value: false },
        { code: "countdown_1", value: 0 },
        { code: "relay_status", value: "power_off" },
        { code: "light_mode", value: "none" }
    ]
};

describe("BSEED switches", () => {
    it("draws each gang of the 2-gang plate as its own switch", () => {
        const rows = tuyaSnapshots([twoGangWithSocket(false)]);
        expect(rows.map((row) => [row.externalId, row.name, row.kind, row.state])).toEqual([
            ["bf3a1c0d2e4f5a6b7c8d9e#switch_1", "Cocina 1", "switch", "on"],
            ["bf3a1c0d2e4f5a6b7c8d9e#switch_2", "Cocina 2", "switch", "off"]
        ]);
    });

    it("adds the socket where the plate switches it", () => {
        const rows = tuyaSnapshots([twoGangWithSocket(true)]);
        expect(rows.map((row) => row.externalId.split("#")[1])).toEqual([
            "switch_1",
            "switch_2",
            "switch_3"
        ]);
        expect(rows[2]!.state).toBe("on");
    });

    it("draws the 1-gang switch as one row under its own name", () => {
        const rows = tuyaSnapshots([oneGangNoNeutral]);
        expect(rows.map((row) => [row.externalId, row.name, row.state])).toEqual([
            ["bf9e8d7c6b5a4f3e2d1c0b#switch_1", "Pasillo", "off"]
        ]);
    });

    it("switches the gang that was pressed and no other", () => {
        expect(tuyaCommandFor("bf3a1c0d2e4f5a6b7c8d9e#switch_2", "turn-on")).toEqual({
            deviceId: "bf3a1c0d2e4f5a6b7c8d9e",
            commands: [{ code: "switch_2", value: true }]
        });
        expect(tuyaCommandFor("bf9e8d7c6b5a4f3e2d1c0b#switch_1", "turn-off").commands).toEqual([
            { code: "switch_1", value: false }
        ]);
    });

    it("says a plate that is not answering is not answering", () => {
        const rows = tuyaSnapshots([{ ...oneGangNoNeutral, online: false }]);
        expect([rows[0]!.online, rows[0]!.state]).toEqual([false, "unknown"]);
    });
});
