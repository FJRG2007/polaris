"use client";

/**
 * An installed app's server action, kept on this device when Polaris could not
 * be reached and made when it answers - the same offline write queue every
 * screen shares (`app-writes`), one kind for every app bundle (`app.action`).
 *
 * An app's browser half calls its actions through the dashboard, and each stub
 * the bundler writes carries which action it is (`polaris.app-action-ref`), so
 * the call can be stored as data - app, module, action, arguments - and sent to
 * `/api/app-bundles/action` from any page, whether or not the app's own module
 * is loaded there. Offered to apps as `hostUi.offline` (host API 1.2).
 *
 * The app decides what each call is for (`target`, what the screen asks about)
 * and how the screen draws it while it waits (`meta`, its own JSON). An answer
 * of `{ ok: false, error }` - the shape the apps' actions answer a refusal in -
 * marks the entry not sent with the app's own words.
 */

import { useEffect, useState } from "react";
import { fromWire, toWire } from "@/lib/app-bundles/wire";
import { newClientKey, type QueueSendResult } from "./outbox";
import { appWrites, offlineStore, registerWriteKind, type AppWrite } from "./app-writes";
import { noteRequestFailure, noteResponseStatus } from "@/lib/reachability";
import { canKeepForLater, undelivered } from "@/lib/offline/try-now";

export const APP_ACTION = "app.action";

/** What the bundler hangs on each action stub. */
const REF = Symbol.for("polaris.app-action-ref");

export interface AppActionRef {
    readonly app: string;
    readonly module: string;
    readonly name: string;
}

interface AppActionPayload extends AppActionRef {
    /** The arguments, as they travel (`wire`). */
    readonly args: unknown;
    readonly label: string;
    readonly meta: unknown;
}

/** What an app is told of one of its kept calls. */
export interface KeptAction {
    readonly key: string;
    /** The app's own target, as it was given. */
    readonly target: string;
    readonly name: string;
    readonly label: string;
    readonly meta: unknown;
    readonly args: readonly unknown[];
    readonly state: "pending" | "failed";
    /** Why the server refused it, in its words. */
    readonly reason?: string;
    readonly createdAt: string;
}

export interface KeepOptions {
    /** What the call writes to, in the app's terms - an event id. */
    readonly target: string;
    /** A short line the screen shows for it while it waits. */
    readonly label: string;
    /** The app's own JSON, handed back with the entry: how to draw it meanwhile. */
    readonly meta?: unknown;
    /** A later call of the same action to the same target replaces a waiting
     *  one (a whole saved event), rather than following it (a drag). */
    readonly replace?: boolean;
}

/** Which action a function is, when it is an app bundle's action stub. */
export function actionRefOf(action: unknown): AppActionRef | null {
    if (typeof action !== "function") return null;
    const ref = (action as unknown as Record<symbol, unknown>)[REF];
    if (!ref || typeof ref !== "object") return null;
    const { app, module, name } = ref as Record<string, unknown>;
    return typeof app === "string" && typeof module === "string" && typeof name === "string"
        ? { app, module, name }
        : null;
}

const scoped = (app: string, target: string): string => `${app}:${target}`;

/** Statuses that say the request did not get to Polaris, or Polaris could not
 *  take it now: tried again, counted only while Polaris answers. */
const NOT_NOW = new Set([408, 429, 500, 502, 503, 504]);

/** Make one kept call. Exported for the tests. */
export async function deliverAppAction(entry: Pick<AppWrite, "payload">): Promise<QueueSendResult> {
    const payload = entry.payload as AppActionPayload;
    let response: Response;
    try {
        response = await fetch("/api/app-bundles/action", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ app: payload.app, module: payload.module, name: payload.name, args: payload.args })
        });
    } catch (caught) {
        noteRequestFailure(caught);
        return "unreachable";
    }
    noteResponseStatus(response.status);
    if (NOT_NOW.has(response.status)) return "unreachable";
    const answer = (await response.json().catch(() => null)) as { value?: unknown; error?: unknown } | null;
    if (!response.ok) return { refused: typeof answer?.error === "string" ? answer.error : "" };
    let value: unknown;
    try {
        value = fromWire(answer?.value);
    } catch {
        value = null;
    }
    if (value && typeof value === "object" && (value as { ok?: unknown }).ok === false) {
        const error = (value as { error?: unknown }).error;
        return { refused: typeof error === "string" ? error : "" };
    }
    return { sent: "" };
}

// Each call is its own step; a replacing save says so itself (`keepAppAction`).
registerWriteKind(APP_ACTION, deliverAppAction, { additive: true });

async function keptFor(app: string, target?: string): Promise<AppWrite[]> {
    return (await appWrites.readAll())
        .filter(
            (entry) =>
                entry.kind === APP_ACTION &&
                (entry.payload as AppActionPayload).app === app &&
                (target === undefined || entry.target === scoped(app, target))
        )
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/**
 * Keep a call for when Polaris answers. False when the function is not an app
 * action stub (a bundle built before they carried one) or this device keeps
 * nothing: the caller fails as it always did.
 */
export async function keepAppAction(action: unknown, args: readonly unknown[], options: KeepOptions): Promise<boolean> {
    const ref = actionRefOf(action);
    if (!ref) return false;
    let wire: unknown;
    try {
        wire = toWire([...args]);
    } catch {
        return false;
    }
    const key = newClientKey();
    const payload: AppActionPayload = { ...ref, args: wire, label: options.label.slice(0, 200), meta: options.meta ?? null };
    const target = scoped(ref.app, options.target);
    const kept = await appWrites.enqueue({ key, kind: APP_ACTION, target, payload }).catch(() => false);
    if (!kept) return false;
    if (options.replace) {
        for (const other of await keptFor(ref.app, options.target)) {
            const same = other.payload as AppActionPayload;
            if (other.key === key || other.state !== "pending") continue;
            if (same.module === ref.module && same.name === ref.name) await offlineStore.forget("writes", other.key);
        }
    }
    return true;
}

/**
 * Make an app's action now, or keep it when Polaris cannot be reached. Answers
 * `{ value }` with what the action answered, or `{ kept: true }` when it waits
 * on this device; any other failure is thrown as it was. Something already
 * waiting for the same target goes first, so a call after it is kept behind it
 * rather than made out of order.
 */
export async function attemptAppAction<T>(
    action: (...args: never[]) => Promise<T>,
    args: readonly unknown[],
    options: KeepOptions
): Promise<{ value: T } | { kept: true }> {
    const ref = actionRefOf(action);
    if (ref && (await keptFor(ref.app, options.target).catch(() => [])).some((entry) => entry.state === "pending")) {
        if (await keepAppAction(action, args, options)) {
            appWrites.flush();
            return { kept: true };
        }
    }
    try {
        return { value: await (action as (...a: unknown[]) => Promise<T>)(...args) };
    } catch (caught) {
        // Not answered, or answered by a newer build that cannot run this
        // tab's action: kept, and sent by the route, which any build serves.
        if (!ref || !canKeepForLater(caught)) throw caught;
        undelivered(caught);
        if (await keepAppAction(action, args, options)) return { kept: true };
        throw caught;
    }
}

function viewOf(app: string, entry: AppWrite): KeptAction {
    const payload = entry.payload as AppActionPayload;
    let args: readonly unknown[] = [];
    try {
        const read = fromWire(payload.args);
        if (Array.isArray(read)) args = read;
    } catch {
        // Unreadable arguments are still shown, and can still be dropped.
    }
    return {
        key: entry.key,
        target: entry.target.slice(app.length + 1),
        name: payload.name,
        label: payload.label,
        meta: payload.meta,
        args,
        state: entry.state,
        reason: entry.reason,
        createdAt: entry.createdAt
    };
}

/** An app's kept calls, oldest first - one target's, or all of them. */
export async function keptAppActions(app: string, target?: string): Promise<KeptAction[]> {
    return (await keptFor(app, target)).map((entry) => viewOf(app, entry));
}

/** The same, kept current while the screen is open. */
export function useKeptAppActions(app: string, target?: string): readonly KeptAction[] {
    const [kept, setKept] = useState<readonly KeptAction[]>([]);
    useEffect(() => {
        let live = true;
        const reload = () =>
            void keptAppActions(app, target).then(
                (entries) => live && setKept(entries),
                () => undefined
            );
        reload();
        const unsubscribe = appWrites.subscribe((event) => {
            if (!event || event.entry.kind === APP_ACTION) reload();
        });
        return () => {
            live = false;
            unsubscribe();
        };
    }, [app, target]);
    return kept;
}

/** Put a kept call back in line - with other arguments when given (a save sent
 *  again over a newer version: "keep mine"). */
export async function retryAppAction(key: string, args?: readonly unknown[]): Promise<void> {
    const entry = (await appWrites.readAll()).find((one) => one.key === key && one.kind === APP_ACTION);
    if (!entry) return;
    const payload = entry.payload as AppActionPayload;
    await appWrites.retry(entry, args ? { payload: { ...payload, args: toWire([...args]) } } : undefined);
}

/** Forget a kept call; it is never made. Only an app's call: no other write
 *  kept on this device can be dropped through here. */
export async function discardAppAction(key: string): Promise<void> {
    const entry = (await appWrites.readAll()).find((one) => one.key === key);
    if (entry?.kind === APP_ACTION) await appWrites.discard(key);
}
