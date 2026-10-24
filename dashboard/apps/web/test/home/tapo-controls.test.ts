/**
 * A Tapo camera's own controls, with no network and no camera.
 *
 * The request bodies in `fixtures/tapo-controls.json` are the ones pytapo sends
 * (github.com/JurajNyiri/pytapo, `pytapo/__init__.py`); the replies are fixture
 * data in the shape pytapo and Home Assistant's tapo_control read. A control is
 * offered only when its getter answered, so the gating is asserted both ways.
 */

import { describe, expect, it } from "vitest";
import fixture from "./fixtures/tapo-controls.json";
import {
    MOTOR_CAPABILITY,
    PROBE,
    controlsOf,
    motorMove,
    requestFor,
    sensitivityOf
} from "@polaris-app/places/src/lib/integrations/tapo-camera-controls";
import {
    afterCommand,
    commandOffered,
    tapoCommandSchema,
    type TapoControls
} from "@polaris-app/places/src/lib/camera-control-kinds";
import {
    withCamera,
    type TapoTransport
} from "@polaris-app/places/src/lib/integrations/tapo-camera";

const full = controlsOf(fixture.replies.full, fixture.replies.motor);
const bare = controlsOf(fixture.replies.bare, fixture.replies.noMotor);

function sent(command: unknown, controls: TapoControls = full) {
    const request = requestFor(tapoCommandSchema.parse(command), controls);
    return request.kind === "raw" ? request.body : request.method;
}

describe("the requests, as pytapo sends them", () => {
    it("builds every command's body", () => {
        const { requests } = fixture;
        expect(sent({ kind: "siren", on: true })).toEqual(requests.startManualAlarm);
        expect(sent({ kind: "siren", on: false })).toEqual(requests.stopManualAlarm);
        expect(sent({ kind: "siren", on: true }, { ...full, siren: "status" })).toEqual(
            requests.setSirenStatus
        );
        expect(sent({ kind: "led", on: false })).toEqual(requests.setLedStatus);
        expect(sent({ kind: "flip", on: true })).toEqual(requests.setFlip);
        expect(sent({ kind: "night", mode: "auto" })).toEqual(requests.setDayNightModeConfig);
        expect(sent({ kind: "night", mode: "color" })).toEqual(requests.setNightVisionModeConfig);
        expect(sent({ kind: "motion", enabled: true, sensitivity: "high" })).toEqual(
            requests.setMotionDetectionHigh
        );
        expect(sent({ kind: "reboot" })).toEqual(requests.rebootDevice);
        expect(sent({ kind: "preset", id: "2" })).toEqual(requests.motorMoveToPreset);
        expect(MOTOR_CAPABILITY).toEqual(requests.getMotorCapability);
    });

    it("steps the motor with pytapo's relative moveMotor", () => {
        expect(motorMove("left")).toEqual({
            method: "motorMove",
            params: { motor: { move: { x_coord: "-10", y_coord: "0" } } }
        });
        expect(motorMove("up").params).toEqual({
            motor: { move: { x_coord: "0", y_coord: "10" } }
        });
    });

    it("reads sensitivity with pytapo's thresholds", () => {
        expect(sensitivityOf("20")).toBe("low");
        expect(sensitivityOf("50")).toBe("medium");
        expect(sensitivityOf("80")).toBe("high");
    });

    it("refuses a command outside the schema", () => {
        expect(tapoCommandSchema.safeParse({ kind: "preset", id: "1; reboot" }).success).toBe(
            false
        );
        expect(tapoCommandSchema.safeParse({ kind: "night", mode: "laser" }).success).toBe(false);
        expect(tapoCommandSchema.safeParse({ kind: "shell" }).success).toBe(false);
    });
});

describe("what a camera is offered", () => {
    it("offers what answered, set to what it said", () => {
        expect(full).toEqual({
            ptz: true,
            presets: [
                { id: "1", name: "Fixture door" },
                { id: "2", name: "Fixture yard" }
            ],
            siren: "manual",
            privacy: false,
            led: true,
            flip: false,
            night: { mode: "auto", modes: ["auto", "on", "off"] },
            motion: { enabled: true, sensitivity: "medium" },
            reboot: true
        });
    });

    it("offers nothing a camera did not answer for", () => {
        expect(bare).toEqual({
            ptz: false,
            presets: null,
            siren: null,
            privacy: null,
            led: null,
            flip: null,
            night: null,
            motion: null,
            reboot: true
        });
        for (const command of [
            { kind: "siren", on: true },
            { kind: "led", on: true },
            { kind: "flip", on: true },
            { kind: "night", mode: "auto" },
            { kind: "motion", enabled: true, sensitivity: "low" },
            { kind: "preset", id: "1" }
        ])
            expect(commandOffered(bare, tapoCommandSchema.parse(command))).toBe(false);
    });

    it("offers only the night modes of the switch the camera has, and only its presets", () => {
        expect(commandOffered(full, { kind: "night", mode: "color" })).toBe(false);
        expect(commandOffered(full, { kind: "preset", id: "9" })).toBe(false);
        expect(commandOffered(full, { kind: "preset", id: "2" })).toBe(true);
    });

    it("prefers the newer night-vision switch and the status siren when they answer", () => {
        const replies = fixture.replies.full.map((reply) => {
            if (reply.method === "getNightVisionModeConfig")
                return {
                    ...reply,
                    error_code: 0,
                    result: { image: { switch: { night_vision_mode: "md_night_vision" } } }
                };
            if (reply.method === "getSirenStatus")
                return { ...reply, error_code: 0, result: { msg_alarm: { status: "off" } } };
            return reply;
        });
        const controls = controlsOf(replies, fixture.replies.motor);
        expect(controls.night).toEqual({ mode: "smart", modes: ["infrared", "color", "smart"] });
        expect(controls.siren).toBe("status");
        expect(afterCommand(controls, { kind: "siren", on: true }).sirenOn).toBe(true);
    });

    it("asks the getters with pytapo's params", () => {
        expect(PROBE.find((each) => each.method === "getLedStatus")?.params).toEqual({
            led: { name: ["config"] }
        });
        expect(PROBE.find((each) => each.method === "getPresetConfig")?.params).toEqual({
            preset: { name: ["preset"] }
        });
    });
});

describe("the link carries the requests", () => {
    it("signs in once and sends a probe and a top-level request on it", async () => {
        const bodies: { method?: string }[] = [];
        const send: TapoTransport = async ({ body }) => {
            const json = JSON.parse(String(body));
            bodies.push(json);
            if (json.method === "login" && json.params.encrypt_type)
                return { status: 200, json: { error_code: -40401 }, fingerprint: "pin" };
            if (json.method === "login")
                return {
                    status: 200,
                    json: { error_code: 0, result: { stok: "fixture-stok" } },
                    fingerprint: "pin"
                };
            if (json.method === "multipleRequest")
                return {
                    status: 200,
                    json: { error_code: 0, result: { responses: fixture.replies.full } },
                    fingerprint: "pin"
                };
            return { status: 200, json: fixture.replies.motor, fingerprint: "pin" };
        };
        const { value, pin } = await withCamera(
            { address: "192.0.2.10", username: "admin", password: "fixture", pin: null },
            async (link) =>
                controlsOf(await link.multiple(PROBE), await link.raw(MOTOR_CAPABILITY)),
            send
        );
        expect(pin).toBe("pin");
        expect(value).toEqual(full);
        expect(bodies.filter((each) => each.method === "login")).toHaveLength(2);
        expect(bodies.at(-1)).toEqual(fixture.requests.getMotorCapability);
    });
});
