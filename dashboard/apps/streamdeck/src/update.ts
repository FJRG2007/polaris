/**
 * Whether a newer plugin is out than the one running.
 *
 * A plugin installed from a file never updates itself, so it compares its own
 * version with the newest release its Polaris knows of and says so on its
 * settings screen. The running version is the manifest's four-part one
 * (`0.1.4.0`); a release is `x.y.z`. Anything that does not read as numbers is
 * no update, rather than a notice that cannot be acted on. Pure.
 */

import { joinPath } from "./address";
import type { DeckReleases } from "./polaris";

const NUMERIC = /^\d+(?:\.\d+){1,3}$/;

function parts(version: string): number[] | null {
    const trimmed = version.trim();
    if (!NUMERIC.test(trimmed)) return null;
    const numbers = trimmed.split(".").map(Number);
    while (numbers.length < 4) numbers.push(0);
    return numbers;
}

/** True when `latest` is a later version than `current`. */
export function isNewer(latest: string | null | undefined, current: string): boolean {
    const next = latest ? parts(latest) : null;
    const now = parts(current);
    if (!next || !now) return false;
    for (let i = 0; i < 4; i++) if (next[i] !== now[i]) return next[i]! > now[i]!;
    return false;
}

/** A newer plugin than this one, and the Downloads page offering it; null when
 *  this is the newest or nothing is known. */
export function updateFor(
    latest: DeckReleases | null,
    running: string,
    address: string | null
): { version: string; url: string } | null {
    if (!latest?.streamdeck || !address || !isNewer(latest.streamdeck, running)) return null;
    const url = joinPath(address, latest.downloadsPath);
    return url ? { version: latest.streamdeck, url } : null;
}
