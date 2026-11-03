/**
 * The settings a wall switch or a socket can carry beside on and off: what it
 * does when power comes back, its indicator light, a child lock, and a timer
 * that flips it after a while.
 *
 * Only what a device reports is offered. A switch that never says whether it
 * has a child lock does not get the toggle, so nothing here is a guess about a
 * model's features.
 *
 * How a device is reached is here too, because it is the other thing a switch
 * row says that a door does not: on this network, or through its maker's cloud.
 *
 * Pure and client-safe, like `device-kinds`, which re-exports it.
 */

import { z } from "zod";
import type { PlacesTranslator } from "./i18n";
import { englishPlaces as en } from "../../messages";

// --- how a device is reached --------------------------------------------------

/**
 * `local` answers on this network. `cloud` has a key and was not found here,
 * `cloud-key` was found but refused its key, and `cloud-only` has no local key
 * at all, so the maker's cloud is its only way in.
 */
export const DEVICE_REACHES = ["local", "cloud", "cloud-key", "cloud-only"] as const;
export type DeviceReach = (typeof DEVICE_REACHES)[number];

/** A stored word as a reach, or null for a row that never had one. */
export function deviceReach(value: unknown): DeviceReach | null {
    return typeof value === "string" && (DEVICE_REACHES as readonly string[]).includes(value)
        ? (value as DeviceReach)
        : null;
}

export function reachText(reach: DeviceReach, t: PlacesTranslator = en): string {
    return t(`devices.reach.${reach}`);
}

// --- settings -------------------------------------------------------------------

/** What it does when power comes back after a cut. */
export const POWER_ON_STATES = ["off", "on", "last"] as const;
export type PowerOnState = (typeof POWER_ON_STATES)[number];

/** Its indicator light: off or on for a backlight, or showing the state or
 *  where the switch is in the dark, for one with a status light. */
export const INDICATOR_MODES = ["off", "on", "status", "position"] as const;
export type IndicatorMode = (typeof INDICATOR_MODES)[number];

/** The longest a timer can run, as the makes that have one accept it. */
export const MAX_COUNTDOWN_SECONDS = 86_400;

/** The timers offered, in seconds. 0 is no timer. */
export const COUNTDOWN_CHOICES = [0, 60, 300, 900, 1800, 3600, 7200, 14_400, 28_800] as const;

/**
 * What a switch last reported, one document on its row. Every field reads on
 * its own: a row written before a field existed reads that field as null
 * rather than failing the whole document.
 */
export const switchSettingsSchema = z.object({
    powerOn: z.enum(POWER_ON_STATES).nullable().catch(null),
    indicator: z.enum(INDICATOR_MODES).nullable().catch(null),
    /** The indicator modes this one has; empty when it has no indicator. */
    indicators: z.array(z.enum(INDICATOR_MODES)).max(INDICATOR_MODES.length).catch([]),
    childLock: z.boolean().nullable().catch(null),
    /** Seconds left on its timer, 0 for none, null where it has no timer. */
    countdown: z.number().int().min(0).max(MAX_COUNTDOWN_SECONDS).nullable().catch(null)
});

export type SwitchSettings = z.infer<typeof switchSettingsSchema>;

/** Whether a document holds any setting worth a control. */
export function hasSwitchSettings(view: SwitchSettings | null | undefined): boolean {
    return (
        !!view &&
        (view.powerOn !== null ||
            view.indicators.length > 0 ||
            view.childLock !== null ||
            view.countdown !== null)
    );
}

/** A stored document as settings, or null when it holds none. Total: anything
 *  that is not an object reads as null, and every missing field as null. */
export function switchSettingsView(value: unknown): SwitchSettings | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const parsed = switchSettingsSchema.safeParse(value);
    if (!parsed.success) return null;
    const view = { ...parsed.data, indicators: [...new Set(parsed.data.indicators)] };
    // An indicator mode it does not list is not one it has.
    if (view.indicator !== null && !view.indicators.includes(view.indicator)) view.indicator = null;
    return hasSwitchSettings(view) ? view : null;
}

/** Whether a kind carries these settings at all. */
export function isSwitchSettingsKind(kind: string): boolean {
    return kind === "switch" || kind === "outlet";
}

// --- changing one -------------------------------------------------------------

export const switchCommandSchema = z.discriminatedUnion("setting", [
    z.object({
        action: z.literal("set-option"),
        setting: z.literal("power-on"),
        value: z.enum(POWER_ON_STATES)
    }),
    z.object({
        action: z.literal("set-option"),
        setting: z.literal("indicator"),
        value: z.enum(INDICATOR_MODES)
    }),
    z.object({
        action: z.literal("set-option"),
        setting: z.literal("child-lock"),
        on: z.boolean()
    }),
    z.object({
        action: z.literal("set-option"),
        setting: z.literal("countdown"),
        seconds: z.number().int().min(0).max(MAX_COUNTDOWN_SECONDS)
    })
]);
export type SwitchCommand = z.infer<typeof switchCommandSchema>;

/** Why a setting cannot go to this switch, or null when it can. */
export function switchCommandIssue(
    view: SwitchSettings | null,
    command: SwitchCommand
): string | null {
    const missing = "That device does not have that setting";
    if (!view) return missing;
    switch (command.setting) {
        case "power-on":
            return view.powerOn === null ? missing : null;
        case "indicator":
            return view.indicators.includes(command.value) ? null : missing;
        case "child-lock":
            return view.childLock === null ? missing : null;
        case "countdown":
            return view.countdown === null ? missing : null;
    }
}

/** Whether a setting is the whole unit's rather than one gang's: a wall switch
 *  has one child lock, one power-on rule and one indicator, and a timer per
 *  gang. */
export function isUnitSwitchSetting(command: SwitchCommand): boolean {
    return command.setting !== "countdown";
}

export function applySwitch(view: SwitchSettings, command: SwitchCommand): SwitchSettings {
    switch (command.setting) {
        case "power-on":
            return { ...view, powerOn: command.value };
        case "indicator":
            return { ...view, indicator: command.value };
        case "child-lock":
            return { ...view, childLock: command.on };
        case "countdown":
            return { ...view, countdown: command.seconds };
    }
}

// --- words ------------------------------------------------------------------------

export function powerOnText(state: PowerOnState, t: PlacesTranslator = en): string {
    return t(`devices.switchSettings.powerOn.${state}`);
}

export function indicatorText(mode: IndicatorMode, t: PlacesTranslator = en): string {
    return t(`devices.switchSettings.indicator.${mode}`);
}

/** A timer's length as a person reads it: "Off", "5 min", "2 h", "1 h 30 min". */
export function countdownText(seconds: number, t: PlacesTranslator = en): string {
    if (seconds <= 0) return t("devices.switchSettings.countdown.off");
    const minutes = Math.ceil(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    if (hours === 0) return t("devices.switchSettings.countdown.minutes", { minutes });
    if (rest === 0) return t("devices.switchSettings.countdown.hours", { hours });
    return t("devices.switchSettings.countdown.hoursMinutes", { hours, minutes: rest });
}
