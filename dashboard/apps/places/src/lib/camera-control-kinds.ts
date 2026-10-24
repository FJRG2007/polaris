/**
 * A Tapo camera's own controls, the parts a screen, an action and a test can
 * all read without reaching a camera: what a camera said it can do, what it is
 * set to now, and the one shape a command may take.
 *
 * Every control here is offered only when the camera answered for it - see
 * `integrations/tapo-camera-controls.ts` for how that is read.
 *
 * Client-safe: imports nothing that touches the server.
 */

import { z } from "zod";

/** Night vision as a person picks it. `auto`/`on`/`off` is the older switch
 *  (infrared by light level, always, never); `infrared`/`color`/`smart` is the
 *  newer one on cameras with a white light. */
export const NIGHT_MODES = ["auto", "on", "off", "infrared", "color", "smart"] as const;
export type NightMode = (typeof NIGHT_MODES)[number];

export const SENSITIVITIES = ["low", "medium", "high"] as const;
export type Sensitivity = (typeof SENSITIVITIES)[number];

/** How a camera sounds its siren: the newer switch that stays on until it is
 *  switched off (`status`), or the older manual alarm (`manual`). */
export type SirenStyle = "status" | "manual";

export interface CameraPreset {
    readonly id: string;
    readonly name: string;
}

/** What the camera answered for, and what each is set to now. A field that is
 *  absent is a control this camera did not answer for, and is not drawn. */
export interface TapoControls {
    readonly ptz: boolean;
    readonly presets: readonly CameraPreset[] | null;
    readonly siren: SirenStyle | null;
    /** On a `status` siren, whether it is sounding now. */
    readonly sirenOn?: boolean;
    readonly privacy: boolean | null;
    readonly led: boolean | null;
    readonly flip: boolean | null;
    readonly night: { readonly mode: NightMode; readonly modes: readonly NightMode[] } | null;
    readonly motion: { readonly enabled: boolean; readonly sensitivity: Sensitivity } | null;
    readonly reboot: boolean;
}

const presetId = z
    .string()
    .trim()
    .regex(/^[0-9]{1,6}$/);

/** One command for a camera. Movement and presets go through the pad's own
 *  actions; everything else is one of these. */
export const tapoCommandSchema = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("siren"), on: z.boolean() }),
    z.object({ kind: z.literal("led"), on: z.boolean() }),
    z.object({ kind: z.literal("flip"), on: z.boolean() }),
    z.object({ kind: z.literal("night"), mode: z.enum(NIGHT_MODES) }),
    z.object({
        kind: z.literal("motion"),
        enabled: z.boolean(),
        sensitivity: z.enum(SENSITIVITIES)
    }),
    z.object({ kind: z.literal("reboot") }),
    z.object({ kind: z.literal("preset"), id: presetId })
]);

export type TapoCommand = z.infer<typeof tapoCommandSchema>;

/** Whether the camera answered for what a command changes. Pure, so the
 *  action and the screen refuse the same things. */
export function commandOffered(controls: TapoControls, command: TapoCommand): boolean {
    switch (command.kind) {
        case "siren":
            return controls.siren !== null;
        case "led":
            return controls.led !== null;
        case "flip":
            return controls.flip !== null;
        case "night":
            return controls.night?.modes.includes(command.mode) ?? false;
        case "motion":
            return controls.motion !== null;
        case "reboot":
            return controls.reboot;
        case "preset":
            return controls.presets?.some((preset) => preset.id === command.id) ?? false;
    }
}

/** The controls as they are once a command was taken. Pure: the server
 *  stores it, and the screen shows it before the camera has answered. */
export function afterCommand(controls: TapoControls, command: TapoCommand): TapoControls {
    switch (command.kind) {
        case "siren":
            return controls.siren === "status" ? { ...controls, sirenOn: command.on } : controls;
        case "led":
            return { ...controls, led: command.on };
        case "flip":
            return { ...controls, flip: command.on };
        case "night":
            return controls.night
                ? { ...controls, night: { ...controls.night, mode: command.mode } }
                : controls;
        case "motion":
            return {
                ...controls,
                motion: { enabled: command.enabled, sensitivity: command.sensitivity }
            };
        default:
            return controls;
    }
}
