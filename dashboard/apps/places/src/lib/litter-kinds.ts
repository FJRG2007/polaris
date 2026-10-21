/**
 * Self-cleaning litter boxes - a PETKIT Pura Max and its kin: what the box is
 * doing, how full it is, who used it, and the few settings its app exposes.
 *
 * Its own kind because none of the others fits. A litter box is not switched
 * like a socket: it runs a cycle (clean, dump, deodorize) on its own or when
 * told, and the useful things to see from elsewhere are whether its bin is full,
 * whether it is running low on litter, and whether it has stopped on a fault.
 *
 * The cycle numbers are `pypetkitapi`'s `LBCommand` (Jezza34000/py-petkit-api,
 * `command.py`), which is also what a box reports as its `workState.workMode`.
 *
 * Pure and client-safe, like `device-kinds`, which re-exports it.
 */

import { z } from "zod";
import type { PlacesTranslator } from "./i18n";
import { englishPlaces as en } from "../../messages";

/** What a box says it is doing. `idle` is waiting for a cat. */
export const LITTER_STATUSES = [
    "idle",
    "cleaning",
    "dumping",
    "deodorizing",
    "resetting",
    "leveling",
    "calibrating",
    "maintenance",
    "working"
] as const;
export type LitterStatus = (typeof LITTER_STATUSES)[number];

/** `workMode` -> status, per `LBCommand`. */
const WORK_MODES: Readonly<Record<number, LitterStatus>> = {
    0: "cleaning",
    1: "dumping",
    2: "deodorizing",
    3: "resetting",
    4: "leveling",
    5: "calibrating",
    9: "maintenance"
};

export function litterStatusOf(workMode: number | null | undefined, running: boolean): LitterStatus {
    if (!running) return "idle";
    return (workMode !== null && workMode !== undefined && WORK_MODES[workMode]) || "working";
}

/**
 * The settings Places offers, by its own words. Each is one of the box's
 * `settings` keys, switched 1/0 through `updateSettings`, as the Home
 * Assistant integration's switches do (`switch.py`). A box that does not
 * report a key does not get the toggle.
 */
export const LITTER_OPTIONS = [
    "auto-clean",
    "avoid-repeat",
    "periodic-clean",
    "kitten",
    "deep-clean",
    "deep-deodorize",
    "auto-deodorize",
    "display",
    "child-lock"
] as const;
export type LitterOption = (typeof LITTER_OPTIONS)[number];

export const LITTER_OPTION_KEYS: Readonly<Record<LitterOption, string>> = {
    "auto-clean": "autoWork",
    "avoid-repeat": "avoidRepeat",
    "periodic-clean": "fixedTimeClear",
    kitten: "kitten",
    "deep-clean": "deepClean",
    "deep-deodorize": "deepRefresh",
    "auto-deodorize": "autoRefresh",
    display: "lightMode",
    "child-lock": "manualLock"
};

const percent = z.number().int().min(0).max(100);

export const litterUseSchema = z.object({
    at: z.string().datetime(),
    pet: z.string().max(80).nullable(),
    /** The cat's weight as the box weighed it, in grams. */
    grams: z.number().int().min(0).max(30_000).nullable(),
    seconds: z.number().int().min(0).max(24 * 60 * 60).nullable()
});
export type LitterUse = z.infer<typeof litterUseSchema>;

export const MAX_LITTER_USES = 10;

/**
 * What a box last reported. Stored on the device row as one document,
 * refreshed by every sync; a field it did not report is null rather than a
 * guess.
 */
export const litterSchema = z.object({
    /** The make's type code for it (`t4` for a Pura Max), as its account says. */
    type: z.string().max(16),
    status: z.enum(LITTER_STATUSES),
    /** The cycle it is in, as the box numbers it, for pause and resume. */
    workMode: z.number().int().min(0).max(99).nullable(),
    litterPercent: percent.nullable(),
    litterLow: z.boolean().nullable(),
    binFull: z.boolean().nullable(),
    deodorizerDays: z.number().int().min(0).max(3650).nullable(),
    usesToday: z.number().int().min(0).max(1000).nullable(),
    lastUseAt: z.string().datetime().nullable(),
    uses: z.array(litterUseSchema).max(MAX_LITTER_USES),
    /** What the box says is wrong, in its own words, or null. */
    fault: z.string().max(300).nullable(),
    options: z.record(z.enum(LITTER_OPTIONS), z.boolean()),
    /** Whether its counter can be reset from here (`deodorantReset`). */
    deodorizerResettable: z.boolean()
});

export type LitterView = z.infer<typeof litterSchema>;

export function litterView(value: unknown): LitterView | null {
    const parsed = litterSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
}

export function litterBusy(view: LitterView | null | undefined): boolean {
    return !!view && view.status !== "idle";
}

export const litterCommandSchema = z.object({
    action: z.literal("set-option"),
    option: z.enum(LITTER_OPTIONS),
    on: z.boolean()
});
export type LitterCommand = z.infer<typeof litterCommandSchema>;

export function litterCommandIssue(view: LitterView | null, command: LitterCommand): string | null {
    if (!view || view.options[command.option] === undefined)
        return "That device does not have that setting";
    return null;
}

export function applyLitter(view: LitterView, command: LitterCommand): LitterView {
    return { ...view, options: { ...view.options, [command.option]: command.on } };
}

/** What a box can need somebody for. */
export const LITTER_ATTENTION = ["bin-full", "litter-low", "fault"] as const;
export type LitterAttention = (typeof LITTER_ATTENTION)[number];

function needs(view: LitterView | null): Set<LitterAttention> {
    const out = new Set<LitterAttention>();
    if (!view) return out;
    if (view.binFull) out.add("bin-full");
    if (view.litterLow) out.add("litter-low");
    if (view.fault) out.add("fault");
    return out;
}

/**
 * What has started needing somebody since the last reading: said once when it
 * begins, not every minute while the bin stays full. A first reading (nothing
 * before it) is not news - the box was like that before Polaris saw it.
 */
export function litterAttention(
    before: LitterView | null,
    after: LitterView | null
): LitterAttention[] {
    if (!before || !after) return [];
    const was = needs(before);
    const fault = after.fault && after.fault !== before.fault;
    return [...needs(after)].filter((which) => (which === "fault" ? fault : !was.has(which)));
}

export function litterStatusText(status: LitterStatus, t: PlacesTranslator = en): string {
    return t(`devices.litter.statuses.${status}`);
}

export function litterOptionText(option: LitterOption, t: PlacesTranslator = en): string {
    return t(`devices.litter.options.${option}`);
}

/** The one line a row shows: what it is doing, and what it needs. */
export function litterLine(view: LitterView, t: PlacesTranslator = en): string {
    const parts: string[] = [litterStatusText(view.status, t)];
    if (view.fault) parts.push(t("devices.litter.fault"));
    else if (view.binFull) parts.push(t("devices.litter.binFull"));
    else if (view.litterLow) parts.push(t("devices.litter.litterLow"));
    else if (view.litterPercent !== null)
        parts.push(t("devices.litter.litterLevel", { percent: view.litterPercent }));
    return parts.join(" - ");
}
