"use client";

/**
 * How many of this screen's downloads have not started yet.
 *
 * The asking is `saveFile`'s, and so is the bar that every download in Polaris now
 * gets - see `components/transfers`. What is left here is the number Drive's own
 * toolbar spins on, which is a different question from the list in the corner:
 * "is anything I asked for still coming", answered for one screen.
 *
 * Why anything has to be said at all: a download is a navigation, not a fetch, so
 * the page that started it is told nothing. That is fine when the answer is
 * immediate and wrong when it is not - a file on a share behind a fresh connection,
 * or a folder the server has to build into an archive first, is many seconds of a
 * button that looks like it did nothing. People press it again. Then again, and now
 * the server is building the same archive four times.
 *
 * A module store rather than a hook, because the presses are spread across a
 * context menu, a toolbar, a viewer and an editor, and the indicator is drawn in
 * one place. Threading a callback through all of them to arrive at one number is
 * the version of this that gets forgotten at one call site.
 */

import { saveFile } from "@/components/transfers/move-file";
import { useSyncExternalStore } from "react";

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
    // The asking, the ticket and the bar belong to the shared surface now - see
    // `components/transfers`, which does this for every download in Polaris. What
    // stays here is the count this screen's toolbar spins on, because it answers a
    // different question: "is anything still being fetched for me", asked by one
    // screen rather than listed for the reader.
    pending += 1;
    publish();
    const settle = () => {
        pending = Math.max(0, pending - 1);
        publish();
    };
    // `as` only where the caller knows the name better than the server does: a
    // single file's own. An archive is named by the endpoint building it, and
    // forcing a name here is how one ends up saved as "file".
    saveFile(url, filename ?? "the folder", {
        ...(filename ? { as: filename } : {}),
        onStarted: settle,
        onGaveUp: settle
    });
}
