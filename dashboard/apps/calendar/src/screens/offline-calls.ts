/**
 * Calendar changes made while Polaris could not be reached: a new event, a
 * save, a drag or resize, a delete. Kept on this device by the dashboard
 * (`hostUi.offline`, host API 1.2) and made, in order, when Polaris answers.
 *
 * Until then the grid is drawn as it will be (`withKeptCalls`), from what each
 * kept call says it does (`KeptMeta`), and the calls wait in a strip above the
 * grid with a clock, or with why one was not made and what to do about it. On a
 * dashboard without the service the calls fail as they always did.
 */

import * as time from "./time";
import { unwrap } from "./cached-read";
import * as model from "./editor-model";
import { hostUi } from "@polaris/app-host/client";
import type { OccurrenceView, RangeView } from "../lib/wire";

export const CALENDAR_APP = "calendar";

export type KeptScope = "this" | "following" | "all";

/** What a kept call does, as the grid draws it meanwhile. */
export type KeptMeta =
    | {
          readonly op: "save";
          /** How the event will look; null when it cannot be drawn ahead (a
           *  change to a repeating event). */
          readonly occurrence: OccurrenceView | null;
          /** Null for a new event. */
          readonly objectId: string | null;
          readonly summary: string;
      }
    | {
          readonly op: "shift";
          readonly objectId: string;
          readonly recurrenceKey: string;
          readonly scope: KeptScope;
          readonly start: string;
          readonly startDeltaMs: number;
          readonly endDeltaMs: number;
          readonly summary: string;
      }
    | {
          readonly op: "delete";
          readonly objectId: string;
          readonly recurrenceKey: string;
          readonly scope: KeptScope;
          readonly start: string;
          readonly summary: string;
      };

/** One kept call, as the dashboard hands it back. */
export interface KeptCall {
    readonly key: string;
    readonly target: string;
    readonly name: string;
    readonly meta: unknown;
    readonly args: readonly unknown[];
    readonly state: "pending" | "failed";
    readonly reason?: string;
    readonly createdAt: string;
}

interface OfflineHost {
    attempt<T>(
        action: (...args: never[]) => Promise<T>,
        args: readonly unknown[],
        options: { target: string; label: string; meta?: unknown; replace?: boolean }
    ): Promise<{ value: T } | { kept: true }>;
    useKept(app: string, target?: string): readonly KeptCall[];
    retry(key: string, args?: readonly unknown[]): Promise<void>;
    discard(key: string): Promise<void>;
}

/** The dashboard's offline service, or null on one older than host API 1.2. */
function offlineHost(): OfflineHost | null {
    try {
        const offline = (hostUi as unknown as { offline: OfflineHost }).offline;
        return typeof offline.attempt === "function" ? offline : null;
    } catch {
        return null;
    }
}

/** Kept on this device, to be made when Polaris answers. */
export const KEPT = "kept" as const;

/**
 * Make a change now, or keep it when Polaris cannot be reached. Answers what
 * the action answered, or `KEPT`; any other failure throws as `unwrap` does.
 */
export async function sendOrKeep<T extends { ok: boolean }>(
    action: (input: never) => Promise<T>,
    input: unknown,
    keep: { target: string; meta: KeptMeta; replace?: boolean },
    fallback: string
): Promise<Extract<T, { ok: true }> | typeof KEPT> {
    const offline = offlineHost();
    if (!offline) return unwrap(() => (action as (input: unknown) => Promise<T>)(input), fallback);
    let kept = false;
    const answer = await unwrap(async () => {
        const result = await offline.attempt(action, [input], {
            target: keep.target,
            label: keep.meta.summary,
            meta: keep.meta,
            replace: keep.replace
        });
        if ("kept" in result) {
            kept = true;
            return { ok: true } as T;
        }
        return result.value;
    }, fallback);
    return kept ? KEPT : answer;
}

const NONE: readonly KeptCall[] = [];
const noKept = (): readonly KeptCall[] => NONE;

/** The calendar's kept calls, oldest first, kept current. */
export function useKeptCalls(): readonly KeptCall[] {
    // The same function on every draw: the host does not change under a page.
    const use = offlineHost()?.useKept ?? noKept;
    return use(CALENDAR_APP);
}

export function retryKept(call: KeptCall, args?: readonly unknown[]): void {
    void offlineHost()?.retry(call.key, args);
}

export function dropKept(call: KeptCall): void {
    void offlineHost()?.discard(call.key);
}

/** A new event's UID, chosen here so sending it twice makes one event. */
export function newEventUid(): string {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function isMeta(value: unknown): value is KeptMeta {
    if (!value || typeof value !== "object") return false;
    const op = (value as { op?: unknown }).op;
    return op === "save" || op === "shift" || op === "delete";
}

/** Whether a kept change of a repeating event reaches this occurrence. */
function reaches(
    occurrence: OccurrenceView,
    meta: { objectId: string; recurrenceKey: string; scope: KeptScope; start: string }
): boolean {
    if (occurrence.objectId !== meta.objectId) return false;
    if (meta.scope === "this") return occurrence.recurrenceKey === meta.recurrenceKey;
    if (meta.scope === "following") return occurrence.start >= meta.start;
    return true;
}

function shifted(occurrence: OccurrenceView, startDeltaMs: number, endDeltaMs: number): OccurrenceView {
    const days = (ms: number) => Math.round(ms / 86_400_000);
    return {
        ...occurrence,
        start: new Date(new Date(occurrence.start).getTime() + startDeltaMs).toISOString(),
        end: new Date(new Date(occurrence.end).getTime() + endDeltaMs).toISOString(),
        startDate: occurrence.startDate ? time.addDays(occurrence.startDate, days(startDeltaMs)) : null,
        endDate: occurrence.endDate ? time.addDays(occurrence.endDate, days(endDeltaMs)) : null
    };
}

/**
 * A window as it will be once the waiting changes are made, in the order they
 * were made. A change that was not made is drawn as the server has it. Pure,
 * for the tests.
 */
export function withKeptCalls(range: RangeView, kept: readonly KeptCall[]): RangeView {
    if (!kept.some((call) => call.state === "pending" && isMeta(call.meta))) return range;
    let occurrences = [...range.occurrences];
    let tasks = range.tasks;
    for (const call of kept) {
        if (call.state !== "pending" || !isMeta(call.meta)) continue;
        const meta = call.meta;
        if (meta.op === "delete") {
            occurrences = occurrences.filter((entry) => !reaches(entry, meta));
            tasks = tasks.filter((task) => !(task.source === "calendar" && task.id === meta.objectId));
        } else if (meta.op === "shift") {
            occurrences = occurrences.map((entry) =>
                reaches(entry, meta) ? shifted(entry, meta.startDeltaMs, meta.endDeltaMs) : entry
            );
        } else if (meta.occurrence) {
            const drawn = meta.occurrence;
            occurrences = occurrences.filter(
                (entry) => entry.objectId !== (meta.objectId ?? drawn.objectId)
            );
            if (drawn.start < range.to && drawn.end > range.from) occurrences.push(drawn);
        }
    }
    return occurrences === range.occurrences && tasks === range.tasks
        ? range
        : { ...range, occurrences, tasks };
}

/** A kept save sent again over what changed meanwhile: the same, with no
 *  version to compare. Null when it had none to begin with. */
export function overwriteArgs(call: KeptCall): readonly unknown[] | null {
    const input = call.args[0];
    if (call.name !== "saveEventAction" || !input || typeof input !== "object") return null;
    const version = (input as { version?: unknown }).version;
    return version ? [{ ...input, version: null }] : null;
}

/**
 * How an event saved from a form will be drawn, before Polaris has it. Null for
 * a repeating one: its occurrences are the server's to work out.
 */
export function keptOccurrence(
    objectId: string,
    form: model.EditorForm,
    zone: string,
    base: OccurrenceView | null = null
): OccurrenceView | null {
    if (form.repeat.frequency !== "NONE") return null;
    const startDate = form.allDay ? form.startDate : null;
    // A form's all-day end is the last day it covers; a drawn one ends after it.
    const endDate = form.allDay ? time.addDays(form.endDate, 1) : null;
    const start =
        startDate !== null
            ? time.dayStart(startDate, zone)
            : model.formInstant(form.startDate, form.startTime, form.startZone, zone);
    const end =
        endDate !== null
            ? time.dayStart(endDate, zone)
            : model.formInstant(form.endDate, form.endTime, form.endZone, zone);
    if (!start || !end || end < start) return null;
    return {
        objectId,
        calendarId: form.calendarId,
        uid: base?.uid ?? "",
        recurrenceKey: base?.recurrenceKey ?? start.toISOString(),
        start: start.toISOString(),
        end: end.toISOString(),
        allDay: form.allDay,
        startDate,
        endDate,
        summary: form.summary,
        location: form.location,
        color: form.color,
        status: form.status,
        transparent: form.transparency === "TRANSPARENT",
        recurring: false,
        overridden: false,
        kind: form.kind,
        attendeeCount: form.attendees.length,
        myPartstat: base?.myPartstat ?? null,
        hasAlarms: form.alarms.length > 0,
        busyOnly: false,
        // Nothing can be done to it until Polaris has it: it has no id there yet.
        editable: false,
        conference: form.conference,
        categories: form.categories
    };
}
