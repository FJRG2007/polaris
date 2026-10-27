/**
 * The call stage drawn inside a conversation that has a call in it.
 *
 * A one-to-one or a group being called shows the call where the conversation
 * is: the faces, the caller's ringing, and the three ways to answer it. The
 * rules for what it shows are here, away from React, so they can be asserted
 * on their own.
 *
 * The card in the corner (`incoming-calls`) keeps ringing everywhere else. It
 * is only put away while this stage is on screen for the same call, because
 * two prompts for one call in one view is one too many - see `stageShown`.
 */

import { ringDecision, type CallFrameFacts } from "./ring-decision";

/** A call ringing at this reader in the conversation on screen. */
export interface StageRing {
    readonly meetingId: string;
    /** Who started it, for the face that pulses. Empty when the server had no name. */
    readonly callerId: string;
    readonly name: string;
    readonly at: number;
}

export interface StageFrame extends CallFrameFacts {
    readonly channelId: string;
    readonly meetingId: string;
    readonly name: string;
}

/**
 * The ring after a call frame, for the conversation `channelId`.
 *
 * The same decision the corner card makes, narrowed to one conversation: a
 * ring starts it, and the call being answered by this reader, ending, or
 * emptying puts it down. Frames for other conversations change nothing.
 */
export function ringAfter(
    current: StageRing | null,
    frame: StageFrame,
    viewerId: string,
    channelId: string,
    now: number
): StageRing | null {
    if (frame.channelId !== channelId) return current;
    switch (ringDecision(frame, viewerId)) {
        case "ring":
            return current?.meetingId === frame.meetingId
                ? current
                : { meetingId: frame.meetingId, callerId: frame.userId, name: frame.name, at: now };
        case "settle":
        case "drop":
            return current?.meetingId === frame.meetingId ? null : current;
        case "ignore":
            return current;
    }
}

/** Whether a ring has run out, by the same clock the corner card uses. */
export function ringExpired(ring: StageRing, now: number, ringForMs: number): boolean {
    return now - ring.at >= ringForMs;
}

export type StageMode = "ringing" | "live" | "none";

/**
 * What the conversation shows above its messages.
 *
 * - `ringing`: this reader is being called here and is not in the call.
 * - `live`: a call is running here with somebody in it, and this reader is not.
 * - `none`: no call, the reader is already in it, calls are not theirs to
 *   take, or the conversation is not a one-to-one or a group.
 */
export function stageMode(input: {
    readonly kind: string;
    readonly mayCall: boolean;
    readonly inCall: boolean;
    readonly ring: StageRing | null;
    readonly live: { readonly meetingId: string; readonly people: readonly unknown[] } | null;
}): StageMode {
    if (input.kind !== "dm" && input.kind !== "group") return "none";
    if (!input.mayCall || input.inCall) return "none";
    // A ring for a call that has since been replaced by another one is stale.
    if (input.ring && (!input.live || input.live.meetingId === input.ring.meetingId)) {
        return "ringing";
    }
    if (input.live && input.live.people.length > 0) return "live";
    return "none";
}

/** The calls whose stage is on screen in this tab. */
const shown = new Map<string, number>();
const listeners = new Set<() => void>();

function changed(): void {
    for (const listener of listeners) listener();
}

/**
 * Say the stage for `meetingId` is on screen. Returns the way to take it back,
 * which the stage calls when it goes.
 */
export function showStage(meetingId: string): () => void {
    shown.set(meetingId, (shown.get(meetingId) ?? 0) + 1);
    changed();
    return () => {
        const count = (shown.get(meetingId) ?? 1) - 1;
        if (count <= 0) shown.delete(meetingId);
        else shown.set(meetingId, count);
        changed();
    };
}

/** Whether the stage for `meetingId` is on screen in this tab. */
export function stageShown(meetingId: string): boolean {
    return shown.has(meetingId);
}

/** A key that changes whenever the set of shown stages does, for `useSyncExternalStore`. */
export function shownStages(): string {
    return [...shown.keys()].sort().join(",");
}

export function subscribeStages(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}
