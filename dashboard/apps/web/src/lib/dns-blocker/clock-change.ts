/**
 * Whether the ad blocker's DNS server should be given its configuration again
 * because the operator's clock moved.
 *
 * Schedules are written for the engine in UTC with the zone's offset at the
 * moment they are rendered, so a daylight-saving change leaves the engine an
 * hour off. That one cause is Polaris's to repair on its own: the engine runs
 * exactly what these same settings rendered to under another offset of their
 * own zone, so applying them again changes nothing anybody chose.
 *
 * Every other difference is left to the screen's Apply now: settings saved while
 * the server could not take them (applying them again on a timer would redeploy
 * a failing server every pass), or a configuration a newer Polaris renders
 * differently (a restart nobody asked for). A difference that is not only the
 * clock is, by construction, never matched here, so a change the operator is in
 * the middle of is never overwritten.
 *
 * Pure, so the decision is asserted in a test across a real boundary.
 */

import { encodeBlockyConfig } from "./render";
import type { DnsSettings } from "./settings";
import { zoneOffsetMinutes } from "./schedules";

const DAY = 24 * 60 * 60 * 1000;
/** How far back the zone's other offsets are looked for: one whole year holds
 *  every offset a zone with daylight saving takes. */
const LOOKBACK_DAYS = 366;

export type ClockChangeDecision =
    | { readonly apply: true; readonly encoded: string }
    | {
          readonly apply: false;
          readonly reason: "noEngine" | "engineDown" | "current" | "notClock" | "unrendered";
      };

export interface ClockChangeInput {
    /** The engine as Polaris knows it, or null when the blocker is off. */
    readonly engine: { readonly running: boolean } | null;
    /** What the engine was last given, or null when nothing was stored. */
    readonly stored: string | null;
    readonly settings: DnsSettings;
    readonly now: Date;
}

/** One instant for each offset `zone` took in the year before `now`, other than
 *  the one it has at `now`. */
function otherOffsetInstants(zone: string, now: Date): Date[] {
    const current = zoneOffsetMinutes(zone, now);
    const seen = new Map<number, Date>();
    for (let day = 1; day <= LOOKBACK_DAYS; day++) {
        const at = new Date(now.getTime() - day * DAY);
        const offset = zoneOffsetMinutes(zone, at);
        if (offset !== current && !seen.has(offset)) seen.set(offset, at);
    }
    return [...seen.values()];
}

/** Apply again, or why not. */
export function clockChangeDecision(input: ClockChangeInput): ClockChangeDecision {
    if (!input.engine) return { apply: false, reason: "noEngine" };
    if (!input.engine.running) return { apply: false, reason: "engineDown" };
    let encoded: string;
    try {
        encoded = encodeBlockyConfig(input.settings, input.now);
    } catch {
        return { apply: false, reason: "unrendered" };
    }
    if (input.stored === encoded) return { apply: false, reason: "current" };
    if (input.stored === null || input.settings.schedules.length === 0)
        return { apply: false, reason: "notClock" };
    const clockOnly = otherOffsetInstants(input.settings.timeZone, input.now).some(
        (at) => encodeBlockyConfig(input.settings, at) === input.stored
    );
    return clockOnly ? { apply: true, encoded } : { apply: false, reason: "notClock" };
}
