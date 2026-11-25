"use client";

/**
 * The browser half of the production safety net (BUG-0037, lib/i18n/fallback).
 *
 * A screen that translates with a namespace nobody handed it, or a key its
 * catalog does not hold, draws nothing for it rather than the key; the misses
 * are gathered for one tick and sent to the server in one request, which logs
 * them and answers with the namespaces in the reader's language over the
 * source's. Every translator then draws again with them. Each namespace is
 * asked for once and each key reported once per page load.
 */

import * as polls from "../shared-polls";
import type { Catalog, Locale } from "@polaris/core";

const rescued = new Map<string, Catalog>();
const asked = new Set<string>();
const reported = new Set<string>();
const listeners = new Set<() => void>();
let version = 0;
let pending: { locale: Locale; names: Set<string>; keys: Set<string> } | null = null;

export function subscribeRescue(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

/** Changes whenever a rescued namespace arrives. */
export function rescueVersion(): number {
    return version;
}

export function rescuedCatalog(locale: Locale, namespace: string): Catalog | undefined {
    return rescued.get(`${locale}:${namespace}`);
}

/** A key a screen could not draw. Called while rendering, so it only queues. */
export function reportMissing(locale: Locale, namespace: string, key: string): void {
    const qualified = `${namespace}.${key}`;
    const wanted = `${locale}:${namespace}`;
    const ask = !asked.has(wanted);
    if (reported.has(qualified) && !ask) return;
    if (reported.size >= 500 && !ask) return;
    reported.add(qualified);
    if (!pending || pending.locale !== locale) {
        pending = { locale, names: new Set(), keys: new Set() };
        setTimeout(flush, 0);
    }
    if (ask && pending.names.size < 4) {
        asked.add(wanted);
        pending.names.add(namespace);
    }
    if (pending.keys.size < 40) pending.keys.add(qualified);
}

function flush(): void {
    const batch = pending;
    pending = null;
    if (!batch) return;
    void polls
        .rescueMessages([...batch.names], [...batch.keys])
        .then((answer) => {
            if (!answer) return;
            let added = false;
            for (const [name, catalog] of Object.entries(answer.messages)) {
                rescued.set(`${answer.locale}:${name}`, catalog);
                added = true;
            }
            if (!added) return;
            version += 1;
            for (const listener of listeners) listener();
        })
        .catch(() => undefined);
}
