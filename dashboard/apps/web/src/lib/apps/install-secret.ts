/**
 * Reading back a secret an install minted for itself.
 *
 * Several marketplace apps are given a credential at install time that only
 * Polaris and the app ever use - the camera relay's API password, the vision
 * worker's key. The install mints it as a `generated` environment variable, so
 * the app already has it; this is the other half, for the code that has to
 * present it or check it.
 *
 * Read from the app's own environment rather than stored a second time. A second
 * copy is a second thing to keep in step, and the one that drifts is always the
 * copy nobody is looking at.
 *
 * Server-only.
 */

import { listEnvVars, revealEnvVar } from "@/lib/env-var-service";

/** Long enough that a page full of tiles does not decrypt the same value twenty
 *  times, short enough that a redeployed app is picked up promptly. */
const TTL_MS = 30_000;

const cache = new Map<string, { value: string; at: number }>();

/** One generated variable of an installed app, decrypted, or null when the app
 *  has no such variable. */
export async function installEnvSecret(
    applicationId: string,
    ownerId: string,
    key: string
): Promise<string | null> {
    const cacheKey = `${applicationId}:${key}`;
    const hit = cache.get(cacheKey);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
    const vars = await listEnvVars("application", applicationId, ownerId).catch(() => []);
    const row = vars.find((item) => item.key === key);
    if (!row) return null;
    const value = row.isSecret ? await revealEnvVar(row.id, ownerId).catch(() => null) : row.value;
    if (!value) return null;
    cache.set(cacheKey, { value, at: Date.now() });
    return value;
}

/** A plain, non-secret variable of an installed app, or the given fallback. */
export async function installEnvValue(
    applicationId: string,
    ownerId: string,
    key: string,
    fallback: string
): Promise<string> {
    const vars = await listEnvVars("application", applicationId, ownerId).catch(() => []);
    return vars.find((item) => item.key === key)?.value ?? fallback;
}
