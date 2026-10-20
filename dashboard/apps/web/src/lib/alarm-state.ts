/**
 * The ok/alarm state machine every polled condition shares: Watch's alarms
 * and the Automations trigger "When a reading crosses a threshold".
 *
 * A breach counts toward a streak, and only a streak of `forPeriods`
 * consecutive breaching samples moves the state into alarm - the same idea as
 * Prometheus's `for:` (pending, then firing), Home Assistant's numeric_state
 * `for`, and Grafana's Pending period. The announcement is the transition, never
 * the sample: a condition that stays breached for an hour fires once.
 *
 * Pure, so the rule is asserted in one place and both callers keep it.
 */

export const COMPARATORS = ["gt", "gte", "lt", "lte"] as const;
export type Comparator = (typeof COMPARATORS)[number];

/** Whether `value` breaches `threshold`. Anything unknown reads as "above". */
export function compare(value: number, comparator: string, threshold: number): boolean {
    if (comparator === "lt") return value < threshold;
    if (comparator === "lte") return value <= threshold;
    if (comparator === "gte") return value >= threshold;
    return value > threshold;
}

/** The worse of two values for a comparator: the highest for "above", the lowest for "below". */
export function worse(comparator: string, a: number, b: number): number {
    return comparator === "lt" || comparator === "lte" ? Math.min(a, b) : Math.max(a, b);
}

export type AlarmState = "ok" | "alarm" | "insufficient";

export interface AlarmStep {
    readonly state: AlarmState;
    readonly streak: number;
    readonly transition: "triggered" | "resolved" | null;
}

/**
 * The state after one sample. `insufficient` (no data to judge on) keeps the
 * streak and marks the state; a breach adds to the streak and fires once it
 * reaches `forPeriods`; a clean sample clears the streak and resolves an alarm.
 */
export function stepAlarm(
    prior: { readonly state: string; readonly streak: number },
    sample: { readonly breach: boolean; readonly insufficient: boolean },
    forPeriods: number
): AlarmStep {
    if (sample.insufficient) return { state: "insufficient", streak: prior.streak, transition: null };
    if (sample.breach) {
        const streak = prior.streak + 1;
        if (streak >= forPeriods)
            return {
                state: "alarm",
                streak,
                transition: prior.state === "alarm" ? null : "triggered"
            };
        return { state: prior.state === "alarm" ? "alarm" : "ok", streak, transition: null };
    }
    return { state: "ok", streak: 0, transition: prior.state === "alarm" ? "resolved" : null };
}
