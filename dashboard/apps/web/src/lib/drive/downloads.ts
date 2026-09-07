"use client";

/**
 * Starting a download, and saying so until it starts.
 *
 * A download is a navigation rather than a fetch: the browser takes the URL,
 * asks for it, and saves what comes back, and the page that started it is told
 * nothing at all. That is fine when the answer is immediate and wrong when it is
 * not - a file on a share behind a fresh connection, or a folder the server has
 * to build into an archive first, is many seconds of a button that looks like it
 * did nothing. People press it again. Then again, and now the server is building
 * the same archive four times.
 *
 * So the request carries a ticket and the response sets a cookie naming it (see
 * `download-ticket`). The cookie can only exist once the server has answered,
 * which is the moment the browser starts saving - so a page watching for it
 * knows when to stop saying "preparing" without ever seeing a byte. After that
 * the download belongs to the browser, which has an indicator of its own.
 *
 * A module store rather than a hook, because the presses are spread across a
 * context menu, a toolbar, a viewer and an editor, and the indicator is drawn in
 * one place. Threading a callback through all of them to arrive at one number is
 * the version of this that gets forgotten at one call site.
 */

import { useSyncExternalStore } from "react";
import {
    downloadStarted,
    forgetDownloadTicket,
    newDownloadTicket
} from "@/lib/drive/download-ticket";

/** How often the cookie is looked for. Often enough that a file which was ready
 *  anyway never reads as a wait. */
const POLL_MS = 250;

/** When a download that has not begun is given up on. Something has failed
 *  somewhere the page cannot see, and a button that never comes back is worse
 *  than one that stops. */
const GIVE_UP_MS = 120_000;

let pending = 0;
const listeners = new Set<() => void>();

function publish(): void {
    for (const listener of listeners) listener();
}

/** How many downloads are still waiting to begin. */
export function useDownloadsPending(): number {
    return useSyncExternalStore(
        (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        () => pending,
        // Nothing is ever pending on the server, and the two answers have to
        // match or hydration complains about a button that spins in one of them.
        () => 0
    );
}

/**
 * Ask for a file, and count it as in flight until the server answers.
 *
 * `filename` is what to call it where the caller knows better than the server -
 * a single file's own name. An archive is named by the endpoint building it.
 */
export function startDownload(url: string, filename?: string): void {
    const ticket = newDownloadTicket();
    const anchor = document.createElement("a");
    anchor.href = `${url}${url.includes("?") ? "&" : "?"}dl=${ticket}`;
    if (filename) anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();

    pending += 1;
    publish();
    const began = Date.now();
    const timer = setInterval(() => {
        const started = downloadStarted(ticket);
        if (!started && Date.now() - began < GIVE_UP_MS) return;
        if (started) forgetDownloadTicket(ticket);
        clearInterval(timer);
        pending = Math.max(0, pending - 1);
        publish();
    }, POLL_MS);
}
