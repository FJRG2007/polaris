/**
 * Everybody starts an event on a stage or in an arena on the same footing:
 * whole, fed, and with none of the effects they brought - their experience
 * is already taken with their things (`stash`). They leave with what they had:
 * their health, hunger, experience and effects are kept with their things on
 * the way in and given back with them on the way out (`stash-service`).
 * Nothing here puts anything back; it only evens out what that gives back.
 *
 * - **Health and hunger**, for anybody whose things are kept with them: in the
 *   database with their health and hunger as they came in, or in the Polaris
 *   mod, which keeps both. Healed and fed only once the last look on the way
 *   in has kept what turned up on them - the mod writes a second key then,
 *   with their health as it is, and it is given back after the first.
 * - **Effects**, only where the mod keeps them: it writes every effect down
 *   and gives it back. The plain stash keeps none, so a potion somebody brewed
 *   is left on them there rather than lost. Cleared before they are moved in,
 *   so whatever the event gives them on the way - its Resistance, its slow
 *   fall - is theirs to keep inside.
 *
 * Pure: the lines, from what was kept.
 */

import * as stash from "./stash";

/** A full food bar. */
const FULL_FOOD = 20;

/** Whether `kept` gives back the health and hunger they came in with. */
export function keepsVitals(kept: stash.Stash | null): boolean {
    return kept !== null && (kept.mod.length > 0 || kept.vitals !== null);
}

/** Whether `kept` gives back the effects they came in with. */
export function keepsEffects(kept: stash.Stash | null): boolean {
    return kept !== null && kept.mod.length > 0;
}

/** Before they are moved in: their own effects off, where they come back. */
export function clearLines(name: string, kept: stash.Stash | null): string[] {
    return keepsEffects(kept) ? [`effect clear ${name}`] : [];
}

/** Once in, and what they carry kept for good: whole and fed, where that
 *  comes back to what they had. */
export function evenLines(name: string, kept: stash.Stash | null): string[] {
    return keepsVitals(kept) ? [stash.healLine(name), stash.feedLine(name, FULL_FOOD)] : [];
}
