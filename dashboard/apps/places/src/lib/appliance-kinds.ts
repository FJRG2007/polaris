/**
 * Kitchen appliances - an airfryer, a multicooker, an espresso machine: what
 * they are doing, as far as they report it.
 *
 * Its own kind because none of the others fits. Such an appliance is not
 * switched like a socket and not aimed at a figure like an air conditioner: it
 * runs a programme somebody started standing in front of it, with a temperature
 * and a time, and the useful thing to see from elsewhere is where it has got to.
 * The one thing it may be told from here is to stop (`device-kinds`); nothing
 * that starts it heating is offered, since nobody would be there to watch it.
 *
 * The words for what it is doing are the Philips HomeID integration's
 * (renaudallard/homeassistant_philips_homeid, `local_models.py`
 * `AIRFRYER_STATUS_*` and its translations), which are the appliance's own.
 *
 * Pure and client-safe, like `device-kinds`, which re-exports it.
 */

import { z } from "zod";
import type { PlacesTranslator } from "./i18n";
import { englishPlaces as en } from "../../messages";

export const APPLIANCE_TYPES = ["airfryer", "multicooker", "espresso"] as const;
export type ApplianceType = (typeof APPLIANCE_TYPES)[number];

/** What an appliance says it is doing. */
export const APPLIANCE_STATUSES = [
    "standby",
    "idle",
    "mainmenu",
    "setting",
    "parasetting",
    "precook",
    "cooking",
    "pause",
    "maintain",
    "finish",
    "user_action",
    "powersave",
    "pairing"
] as const;
export type ApplianceStatus = (typeof APPLIANCE_STATUSES)[number];

/** The statuses in which it is heating, or about to: the ones worth noticing. */
const BUSY: ReadonlySet<ApplianceStatus> = new Set(["precook", "cooking", "maintain"]);

const seconds = z
    .number()
    .int()
    .min(0)
    .max(7 * 24 * 60 * 60);
const degrees = z.number().finite().min(-50).max(400);

/**
 * What an appliance last reported. Stored on the device row as one document,
 * refreshed by every sync; a field it did not report is null rather than a
 * guess.
 */
export const applianceSchema = z.object({
    type: z.enum(APPLIANCE_TYPES),
    status: z.enum(APPLIANCE_STATUSES).nullable(),
    /** The recipe or programme by name, where the appliance names it. */
    program: z.string().max(120).nullable(),
    /** The temperature it is set to, and the one it has reached. */
    target: degrees.nullable(),
    current: degrees.nullable(),
    unit: z.enum(["C", "F"]),
    /** Seconds left, and the whole time it was set for. */
    remaining: seconds.nullable(),
    total: seconds.nullable(),
    /** Whether it can be stopped from here at all. */
    stoppable: z.boolean()
});

export type ApplianceView = z.infer<typeof applianceSchema>;

/** A stored document back, or null for anything that is not one. */
export function applianceView(value: unknown): ApplianceView | null {
    const parsed = applianceSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
}

/** A status the appliance sent, as one of these, or null for a word nobody has
 *  documented. */
export function applianceStatus(value: unknown): ApplianceStatus | null {
    return typeof value === "string" && (APPLIANCE_STATUSES as readonly string[]).includes(value)
        ? (value as ApplianceStatus)
        : null;
}

/** Whether it is heating or about to. */
export function applianceBusy(view: ApplianceView | null | undefined): boolean {
    return view?.status ? BUSY.has(view.status) : false;
}

export function applianceStatusText(status: ApplianceStatus, t: PlacesTranslator = en): string {
    return t(`devices.appliance.statuses.${status}`);
}

export function applianceTypeText(type: ApplianceType, t: PlacesTranslator = en): string {
    return t(`devices.appliance.types.${type}`);
}

/** A number of seconds as hours and minutes, the way a cooking timer reads. */
export function applianceTime(total: number): string {
    const minutes = Math.ceil(total / 60);
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return hours > 0 ? `${hours}:${String(rest).padStart(2, "0")} h` : `${rest} min`;
}

/** The one line a row shows: what it is doing, and how long is left. */
export function applianceLine(view: ApplianceView, t: PlacesTranslator = en): string {
    const parts: string[] = [];
    if (view.status) parts.push(applianceStatusText(view.status, t));
    if (view.remaining !== null && view.remaining > 0 && applianceBusy(view))
        parts.push(t("devices.appliance.left", { time: applianceTime(view.remaining) }));
    return parts.join(" - ");
}
