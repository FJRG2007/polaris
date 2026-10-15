/**
 * How an incident moves. Pure.
 *
 * An open incident may go to any open state (an operator who said "identified"
 * too early goes back to "investigating") or to resolved. A resolved incident
 * stays resolved unless an update reopens it as investigating.
 */

export const INCIDENT_STATES = ["investigating", "identified", "monitoring", "resolved"] as const;
export type IncidentState = (typeof INCIDENT_STATES)[number];

export const INCIDENT_IMPACTS = ["minor", "major", "critical"] as const;
export type IncidentImpact = (typeof INCIDENT_IMPACTS)[number];

export interface IncidentStatus {
    readonly state: IncidentState;
    readonly resolvedAt: Date | null;
}

export type Transition =
    | { readonly ok: true; readonly state: IncidentState; readonly resolvedAt: Date | null }
    | { readonly ok: false; readonly reason: "resolvedReopen" };

export function canTransition(from: IncidentState, to: IncidentState): boolean {
    if (from === "resolved") return to === "investigating" || to === "resolved";
    return true;
}

/** The incident after an update in state `to`, posted at `at`. */
export function transition(current: IncidentStatus, to: IncidentState, at: Date): Transition {
    if (!canTransition(current.state, to)) return { ok: false, reason: "resolvedReopen" };
    if (to === "resolved") {
        return { ok: true, state: to, resolvedAt: current.resolvedAt ?? at };
    }
    return { ok: true, state: to, resolvedAt: null };
}

export function isOpen(state: IncidentState): boolean {
    return state !== "resolved";
}

/** Whether a maintenance window is in progress at `now`. */
export function maintenanceActive(window: { startsAt: Date; endsAt: Date }, now: Date): boolean {
    return window.startsAt.getTime() <= now.getTime() && now.getTime() < window.endsAt.getTime();
}
