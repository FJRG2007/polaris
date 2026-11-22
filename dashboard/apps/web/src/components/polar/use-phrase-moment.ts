"use client";

/**
 * The moment Polar's greeting and prompts are built for (`lib/polar/greeting.ts`):
 * the reader's local time and a seed, both taken once per page load so the
 * words hold still while the page is open.
 *
 * The server renders none (it knows neither the reader's clock nor their time
 * zone), so the first paint carries the plain greeting and the swap happens
 * after hydration instead of as a mismatch. A navigation inside the app has no
 * hydration and gets the page load's moment at once.
 */

import { useSyncExternalStore } from "react";
import type { PhraseContext } from "@/lib/polar/greeting";

let moment: PhraseContext | null = null;

function clientMoment(): PhraseContext {
    moment ??= { now: new Date(), seed: Math.floor(Math.random() * 1_000_000) };
    return moment;
}

const subscribe = () => () => {};

/** This page load's moment, or null while the server's render is on screen. */
export function usePhraseMoment(): PhraseContext | null {
    return useSyncExternalStore(subscribe, clientMoment, () => null);
}
