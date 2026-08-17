"use client";

/**
 * Whose photo this reader may open, asked once for everybody on screen.
 *
 * The same problem presence has and the same shape of answer: a face knows an id
 * and a name, thirty of them are drawn at a time, and thirty requests is not an
 * option. Ids are collected for a tick and the answer comes back for all of them.
 *
 * No provider and no interval, which is the difference from presence. No
 * provider, because faces are drawn on screens that sit outside any of them - a
 * public link, a sign-in page - and a face there should quietly not be openable
 * rather than throw. No interval, because a privacy setting is not presence: it
 * changes when somebody decides it does, and a page that has been open for an
 * hour showing one press too many is not the failure a stale green dot is.
 *
 * Unknown reads as "no". A face becomes openable a moment after it is drawn,
 * which nobody sees; the other way round would be a press that opens something
 * the person looking was not allowed to open.
 */

import { useEffect, useSyncExternalStore } from "react";

/** How long ids are collected before the request goes. One tick of a screen
 *  mounting, so a list of thirty faces is one request rather than thirty. */
const GATHER_MS = 60;

/** What has been answered: id to whether this reader may open that photo. */
const known = new Map<string, boolean>();
/** Ids asked about but not yet answered, so nothing is asked for twice. */
const asked = new Set<string>();
/** Ids gathered since the last request went out. */
const waiting = new Set<string>();
const listeners = new Set<() => void>();

let timer: ReturnType<typeof setTimeout> | null = null;

function announce(): void {
    for (const listener of listeners) listener();
}

async function ask(ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    try {
        const response = await fetch("/api/avatar/access", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ ids })
        });
        if (!response.ok) {
            // Signed out, or a screen with no session behind it. Forgotten rather
            // than remembered as a no, so a later screen with a session asks again.
            for (const id of ids) asked.delete(id);
            return;
        }
        const body = (await response.json()) as { allowed?: string[] };
        const allowed = new Set(body.allowed ?? []);
        for (const id of ids) known.set(id, allowed.has(id));
        announce();
    } catch {
        // Offline, or a request that went away with the page. Asked again next
        // time a face wants the answer.
        for (const id of ids) asked.delete(id);
    }
}

function want(id: string): void {
    if (asked.has(id)) return;
    asked.add(id);
    waiting.add(id);
    if (timer) return;
    timer = setTimeout(() => {
        timer = null;
        const going = [...waiting];
        waiting.clear();
        void ask(going);
    }, GATHER_MS);
}

function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

/** Whether this reader may open one person's photo full size. False until the
 *  answer arrives, and false for somebody with no account behind their face. */
export function usePhotoOpenable(id: string | null | undefined): boolean {
    useEffect(() => {
        if (id) want(id);
    }, [id]);

    return useSyncExternalStore(
        subscribe,
        () => (id ? (known.get(id) ?? false) : false),
        () => false
    );
}
