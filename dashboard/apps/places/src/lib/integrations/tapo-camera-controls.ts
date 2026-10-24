/**
 * The requests behind a Tapo camera's own controls, and how its answers are
 * read. Pure: no network, no session - `tapo-camera.ts` carries these.
 *
 * Every method name and body here is the one pytapo sends
 * (github.com/JurajNyiri/pytapo, `pytapo/__init__.py`), the library the Home
 * Assistant `tapo_control` integration is built on. Nothing is invented: a
 * control pytapo does not send is not offered.
 *
 * What a camera can do is read the way `tapo_control` reads it: every getter is
 * asked in one `multipleRequest`, and a control exists only when its getter
 * answered with its own section. A model that does not have a feature answers
 * that getter with an error, so nothing is offered blindly.
 */

import type {
    CameraPreset,
    NightMode,
    Sensitivity,
    TapoCommand,
    TapoControls
} from "../camera-control-kinds";

type Json = Record<string, unknown>;

/** One method inside a `multipleRequest`. */
export interface TapoMethod {
    readonly method: string;
    readonly params: Json;
}

function record(value: unknown): Json {
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {};
}

/** The getters asked to learn what a camera can do and what it is set to. */
export const PROBE: readonly TapoMethod[] = [
    { method: "getDeviceInfo", params: { device_info: { name: ["basic_info"] } } },
    { method: "getLensMaskConfig", params: { lens_mask: { name: ["lens_mask_info"] } } },
    { method: "getLedStatus", params: { led: { name: ["config"] } } },
    { method: "getPresetConfig", params: { preset: { name: ["preset"] } } },
    { method: "getSirenStatus", params: { msg_alarm: {} } },
    { method: "getLastAlarmInfo", params: { msg_alarm: { name: ["chn1_msg_alarm_info"] } } },
    { method: "getDetectionConfig", params: { motion_detection: { name: ["motion_det"] } } },
    { method: "getLdc", params: { image: { name: ["switch"] } } },
    { method: "getNightVisionModeConfig", params: { image: { name: ["switch"] } } },
    { method: "getLightFrequencyInfo", params: { image: { name: "common" } } }
];

/** Whether the camera's motor answers, sent on its own rather than inside a
 *  `multipleRequest` - pytapo's `getMotorCapability`. */
export const MOTOR_CAPABILITY: Json = { method: "get", motor: { name: ["capability"] } };

/** The newer night-vision values, by what a person picks. */
const NIGHT_VISION_MODES: Readonly<Record<string, NightMode>> = {
    inf_night_vision: "infrared",
    wtl_night_vision: "color",
    md_night_vision: "smart"
};

const NIGHT_VISION_VALUES: Readonly<Partial<Record<NightMode, string>>> = {
    infrared: "inf_night_vision",
    color: "wtl_night_vision",
    smart: "md_night_vision"
};

/** pytapo's `__getSensitivityNumber`: high 80, normal 50, low 20. */
const SENSITIVITY_NUMBERS: Readonly<Record<Sensitivity, string>> = {
    low: "20",
    medium: "50",
    high: "80"
};

/** A digital sensitivity read back as a word, by pytapo's own thresholds:
 *  20 or below is low, 50 or below is medium, above is high. */
export function sensitivityOf(digital: unknown): Sensitivity {
    const value = Number(digital);
    if (!Number.isFinite(value)) return "medium";
    if (value <= 20) return "low";
    if (value <= 50) return "medium";
    return "high";
}

/** The answers of a `multipleRequest`, by method, keeping only the ones that
 *  answered without an error. */
export function answered(responses: unknown): Map<string, Json> {
    const found = new Map<string, Json>();
    if (!Array.isArray(responses)) return found;
    for (const each of responses) {
        const response = record(each);
        if (typeof response.method !== "string" || response.error_code !== 0) continue;
        if (!found.has(response.method)) found.set(response.method, record(response.result));
    }
    return found;
}

/** pytapo's `processPresetsResponse`: two parallel lists, ids and names. */
export function presetsOf(result: Json | undefined): CameraPreset[] | null {
    if (!result) return null;
    const lists = record(record(result.preset).preset);
    const ids = lists.id;
    const names = lists.name;
    if (!Array.isArray(ids) || !Array.isArray(names)) return null;
    return ids
        .map((id, index) => ({ id: String(id), name: String(names[index] ?? id) }))
        .filter((preset) => /^[0-9]{1,6}$/.test(preset.id));
}

function onOff(value: unknown): boolean | null {
    if (value === "on") return true;
    if (value === "off") return false;
    return null;
}

/** What a camera can do, from its answers to `PROBE` and `MOTOR_CAPABILITY`. */
export function controlsOf(responses: unknown, motor: unknown): TapoControls {
    const got = answered(responses);
    const motorAnswer = record(motor);
    const ptz =
        motorAnswer.error_code === 0 &&
        Object.keys(record(record(motorAnswer.motor).capability)).length > 0;

    const switches = record(record(got.get("getLdc")?.image).switch);
    const flip =
        switches.flip_type === "center" ? true : switches.flip_type === "off" ? false : null;

    let night: TapoControls["night"] = null;
    const vision = record(record(got.get("getNightVisionModeConfig")?.image).switch);
    const visionMode = NIGHT_VISION_MODES[String(vision.night_vision_mode)];
    if (visionMode) night = { mode: visionMode, modes: ["infrared", "color", "smart"] };
    else {
        const common = record(record(got.get("getLightFrequencyInfo")?.image).common);
        const inf = common.inf_type;
        if (inf === "auto" || inf === "on" || inf === "off")
            night = { mode: inf, modes: ["auto", "on", "off"] };
    }

    let motion: TapoControls["motion"] = null;
    const detection = record(record(got.get("getDetectionConfig")?.motion_detection).motion_det);
    const motionOn = onOff(detection.enabled);
    if (motionOn !== null)
        motion = { enabled: motionOn, sensitivity: sensitivityOf(detection.digital_sensitivity) };

    const sirenStatus = record(got.get("getSirenStatus")?.msg_alarm);
    const statusOn = onOff(sirenStatus.status);
    const manual =
        got.has("getLastAlarmInfo") &&
        Object.keys(record(record(got.get("getLastAlarmInfo")?.msg_alarm).chn1_msg_alarm_info))
            .length > 0;

    const presets = ptz ? presetsOf(got.get("getPresetConfig")) : null;

    return {
        ptz,
        presets,
        siren: statusOn !== null ? "status" : manual ? "manual" : null,
        ...(statusOn !== null ? { sirenOn: statusOn } : {}),
        privacy: onOff(
            record(record(got.get("getLensMaskConfig")?.lens_mask).lens_mask_info).enabled
        ),
        led: onOff(record(record(got.get("getLedStatus")?.led).config).enabled),
        flip,
        night,
        motion,
        reboot: got.has("getDeviceInfo")
    };
}

/** A command as what is sent: a `multipleRequest` method, or - for the older
 *  manual alarm - a top-level body, as pytapo sends it with `performRequest`. */
export type TapoRequest =
    | { readonly kind: "method"; readonly method: TapoMethod }
    | { readonly kind: "raw"; readonly body: Json };

const method = (name: string, params: Json): TapoRequest => ({
    kind: "method",
    method: { method: name, params }
});

const onOffWord = (on: boolean) => (on ? "on" : "off");

/** What a command sends, for the camera that answered `controls`. */
export function requestFor(command: TapoCommand, controls: TapoControls): TapoRequest {
    switch (command.kind) {
        case "siren":
            if (controls.siren === "manual")
                return {
                    kind: "raw",
                    body: {
                        method: "do",
                        msg_alarm: { manual_msg_alarm: { action: command.on ? "start" : "stop" } }
                    }
                };
            return method("setSirenStatus", { msg_alarm: { status: onOffWord(command.on) } });
        case "led":
            return method("setLedStatus", { led: { config: { enabled: onOffWord(command.on) } } });
        case "flip":
            return method("setLdc", {
                image: { switch: { flip_type: command.on ? "center" : "off" } }
            });
        case "night": {
            const vision = NIGHT_VISION_VALUES[command.mode];
            if (vision)
                return method("setNightVisionModeConfig", {
                    image: { switch: { night_vision_mode: vision } }
                });
            return method("setDayNightModeConfig", {
                image: { common: { inf_type: command.mode } }
            });
        }
        case "motion":
            return method("setDetectionConfig", {
                motion_detection: {
                    motion_det: {
                        enabled: onOffWord(command.enabled),
                        digital_sensitivity: SENSITIVITY_NUMBERS[command.sensitivity],
                        sensitivity: command.sensitivity
                    }
                }
            });
        case "reboot":
            return method("rebootDevice", { system: { reboot: "null" } });
        case "preset":
            return method("motorMoveToPreset", { preset: { goto_preset: { id: command.id } } });
    }
}

/** How far one press of an arrow turns the camera, in the motor's own
 *  coordinates. pytapo's `moveMotor` is relative; this is a step, not a
 *  speed, because the Tapo API has no continuous move to stop. */
export const PTZ_STEP = 10;

/** One step of the motor - pytapo's `moveMotor(x, y)`. */
export function motorMove(direction: "up" | "down" | "left" | "right"): TapoMethod {
    const x = direction === "left" ? -PTZ_STEP : direction === "right" ? PTZ_STEP : 0;
    const y = direction === "down" ? -PTZ_STEP : direction === "up" ? PTZ_STEP : 0;
    return {
        method: "motorMove",
        params: { motor: { move: { x_coord: String(x), y_coord: String(y) } } }
    };
}
