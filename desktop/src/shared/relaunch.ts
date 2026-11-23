/**
 * Carrying a call across a restart the app made itself.
 *
 * Restarting into an update, or because somebody pressed a restart the app
 * offered, starts a new process, and the page's own note of the call it was on
 * (kept in the tab's session storage, which a reload keeps) goes with the old
 * one. So the page also tells the main process which call it is on while it is
 * on one, and the main process writes those calls down just before a restart
 * it makes, with why. The next run hands each Polaris page its own call once.
 *
 * Only a restart the app made carries a call: somebody quitting the app writes
 * nothing, so opening it again never opens a microphone by itself.
 *
 * Pure, so the rules are tested without Electron, and on the tree-shaken zod
 * because the page's preload reads it.
 */

import * as z from "zod/mini";

/** How long after the restart a call is still walked back into: the page's own window. */
export const RELAUNCH_WINDOW_MS = 90_000;

/** The page's note of its call, opaque here: the page wrote it and the page reads it. */
export const CALL_NOTE_MAX = 8192;

/** At most this many windows' calls are written down; one is the usual. */
const CALLS_MAX = 8;

const reasonSchema = z.enum(["update", "relaunch"]);

const noteSchema = z.string().check(z.minLength(1), z.maxLength(CALL_NOTE_MAX));

/** What is written down just before the restart. */
export const relaunchMarkSchema = z.strictObject({
    reason: reasonSchema,
    at: z.number().check(z.gte(0)),
    calls: z.array(z.strictObject({ origin: z.string().check(z.maxLength(2048)), note: noteSchema })).check(z.maxLength(CALLS_MAX))
});

export type RelaunchMark = z.infer<typeof relaunchMarkSchema>;

/** What a page is told: why this run began, and the call it was on, once. */
export const relaunchSchema = z.nullable(z.strictObject({ reason: reasonSchema, at: z.number(), call: z.nullable(noteSchema) }));

export type Relaunch = z.infer<typeof relaunchSchema>;

/** A stored mark as one, or none. */
export function readRelaunchMark(raw: unknown): RelaunchMark | null {
    const parsed = relaunchMarkSchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
}

/** What the page was handed, as one: anything else is no restart. */
export function readRelaunch(raw: unknown): Relaunch {
    const parsed = relaunchSchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
}

/** Whether a note is one the main process keeps: a string the page wrote, or
 *  null for "no call now". */
export function readCallNote(raw: unknown): string | null | undefined {
    if (raw === null) return null;
    const parsed = noteSchema.safeParse(raw);
    return parsed.success ? parsed.data : undefined;
}

/** The mark if it is recent enough to act on; a clock that went backwards is
 *  not trusted either way. */
export function freshMark(mark: RelaunchMark | null, now: number): RelaunchMark | null {
    if (!mark || now < mark.at || now - mark.at > RELAUNCH_WINDOW_MS) return null;
    return mark;
}

/**
 * A page of `origin` asking why this run began: the answer, and the mark left
 * for the next page. Its call is handed once - the second page to ask, or the
 * same page reloaded, is told the reason without it.
 */
export function relaunchFor(
    mark: RelaunchMark | null,
    origin: string,
    now: number
): { readonly answer: Relaunch; readonly rest: RelaunchMark | null; } {
    const fresh = freshMark(mark, now);
    if (!fresh) return { answer: null, rest: null };
    const index = fresh.calls.findIndex((held) => held.origin === origin);
    const call = index === -1 ? null : fresh.calls[index]!.note;
    const calls = index === -1 ? fresh.calls : fresh.calls.filter((_, at) => at !== index);
    return { answer: { reason: fresh.reason, at: fresh.at, call }, rest: { ...fresh, calls } };
}

/** The calls held now, as they are written down: the newest few. */
export function heldCalls(held: Iterable<{ readonly origin: string; readonly note: string; }>): RelaunchMark["calls"] {
    return [...held].slice(-CALLS_MAX).map(({ origin, note }) => ({ origin, note }));
}
