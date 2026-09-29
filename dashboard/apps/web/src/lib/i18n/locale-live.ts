/**
 * Telling an account's open tabs that its language changed.
 *
 * The same in-process bus the access changes ride (see `access-live`), and
 * delivered on the same stream: a tab that hears its own account's new language
 * redraws in it, so changing it in one tab changes every tab without a reload.
 * What travels is whose language and which one - both the reader's own.
 */

import type { Locale } from "@polaris/core";

export interface LocaleChange {
    readonly userId: string;
    readonly locale: Locale;
}

type Listener = (change: LocaleChange) => void;

/** On globalThis rather than in a module binding: the server action that writes
 *  a change and the stream that delivers it may be different copies of this
 *  module (different bundle layers, or a dev server re-evaluating it). */
const REGISTRY = Symbol.for("polaris.locale.live");

function listeners(): Set<Listener> {
    const holder = globalThis as { [REGISTRY]?: Set<Listener> };
    return (holder[REGISTRY] ??= new Set());
}

/** Announce a change. Never throws: a dead listener is one dead connection, and
 *  it must not fail the save that raised it. */
export function publishLocaleChange(change: LocaleChange): void {
    for (const listener of listeners()) {
        try {
            listener(change);
        } catch (caught) {
            console.error(caught);
        }
    }
}

/** Listen until the returned function is called. */
export function subscribeLocale(listener: Listener): () => void {
    const held = listeners();
    held.add(listener);
    return () => {
        held.delete(listener);
    };
}
