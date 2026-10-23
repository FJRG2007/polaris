/**
 * Which address of this Polaris the worker talks to right now.
 *
 * The extension is pointed at one address, usually the public domain. When the
 * house loses its internet connection that domain stops answering while the same
 * Polaris is still on `polaris.local` or its LAN address. The worker then talks
 * to that address instead - but only once the address has proved, by signing a
 * fresh challenge with the key learned over the usual address, that it is the
 * same Polaris (`@polaris/core/instance-fallback`). An address that cannot prove
 * it never sees a token.
 *
 * Two more conditions, both the browser's:
 *
 * - **Permission.** An address the extension holds no host permission for is
 *   never used. On Chromium every page is already granted; on Firefox the popup
 *   asks, from a click (`localPermissions` names what to ask for).
 * - **Trust.** `polaris.local` and the LAN address carry Polaris's own
 *   certificate. The browser decides whether it trusts it and nothing here gets
 *   around that; when it does not, the popup says so and points at the screen
 *   that installs it.
 *
 * Every call that names the usual address only to identify the server (which
 * account belongs to it, whether a tab is Polaris's own) keeps using
 * `currentOrigin`. Calls that send something use `reachOrigin`.
 */

import { storage } from "#imports";
import {
    createFailover,
    learnInstance,
    readInstance,
    type Failover,
    type InstanceRecord
} from "@polaris/core/instance-fallback";
import { currentOrigin, holdsOrigin } from "@/lib/server";
import { alternatesOf, NO_REACH, plainOrigin, type ReachStatus } from "@/lib/local-address";

/** What the usual address said about the instance, kept so it survives a restart offline. */
interface LearnedInstance {
    readonly origin: string;
    readonly record: InstanceRecord;
    readonly learnedAt: number;
}

const INSTANCE = storage.defineItem<LearnedInstance | null>("local:server.instance", {
    fallback: null
});

/** How often what was learned is asked again, so a LAN address that moved is picked up. */
const RELEARN_MS = 24 * 60 * 60_000;
/** How long after a failed attempt to learn it is not tried again. */
const RETRY_LEARN_MS = 10 * 60_000;
/** How long a resolved address is used before it is resolved again. */
const RESOLVE_MS = 15_000;
/** How long the plain-HTTP question may take. */
const PLAIN_TIMEOUT_MS = 3_000;

async function learned(primary: string): Promise<InstanceRecord | null> {
    const held = await INSTANCE.getValue();
    if (!held || held.origin !== primary) return null;
    return readInstance(held.record);
}

let learning: { readonly origin: string; readonly at: number } | null = null;

/**
 * Ask the usual address who it is, when that has not been asked lately. Only
 * ever the usual address: an alternate is never the one that says which key to
 * trust.
 */
export async function learnOver(primary: string, force = false): Promise<void> {
    const held = await INSTANCE.getValue();
    const fresh = held?.origin === primary && Date.now() - held.learnedAt < RELEARN_MS;
    if (!force && fresh) return;
    if (!force && learning?.origin === primary && Date.now() - learning.at < RETRY_LEARN_MS) return;
    learning = { origin: primary, at: Date.now() };
    const record = await learnInstance(primary);
    if (record) await INSTANCE.setValue({ origin: primary, record, learnedAt: Date.now() });
}

/** Whether the host answers at all without TLS. Sends nothing of the extension's. */
async function answersWithoutTls(origin: string): Promise<boolean> {
    const plain = plainOrigin(origin);
    if (!plain || !(await holdsOrigin(plain))) return false;
    try {
        await fetch(`${plain}/api/instance`, {
            redirect: "manual",
            credentials: "omit",
            signal: AbortSignal.timeout(PLAIN_TIMEOUT_MS)
        });
        return true;
    } catch {
        return false;
    }
}

let held: { readonly key: string; readonly failover: Failover } | null = null;
let resolved: { readonly key: string; readonly origin: string; readonly at: number } | null = null;

/** The failover for this address and the alternates it may use, kept while those stay the same. */
async function failoverFor(primary: string): Promise<{ key: string; failover: Failover } | null> {
    const record = await learned(primary);
    if (!record) return null;
    const permitted: string[] = [];
    for (const origin of alternatesOf(record, primary)) {
        if (await holdsOrigin(origin).catch(() => false)) permitted.push(origin);
    }
    if (permitted.length === 0) return null;
    const key = [primary, record.id, record.publicKey, ...permitted].join(" ");
    if (held?.key !== key) {
        held = {
            key,
            failover: createFailover({
                primary,
                instance: { ...record, addresses: [primary, ...permitted] },
                answersWithoutTls
            })
        };
    }
    return held;
}

/**
 * The address to send a request to: the usual one, or a local address of the
 * same Polaris that proved it while the usual one is down. Null while the
 * extension has not been given one.
 */
export async function reachOrigin(): Promise<string | null> {
    const primary = await currentOrigin();
    if (!primary) return null;
    void learnOver(primary).catch(() => undefined);
    const picked = await failoverFor(primary);
    if (!picked) return primary;
    if (resolved?.key === picked.key && Date.now() - resolved.at < RESOLVE_MS) return resolved.origin;
    const origin = await picked.failover.resolve();
    resolved = { key: picked.key, origin, at: Date.now() };
    return origin;
}

/**
 * Where the worker stands, for the popup. Read from what the last requests
 * found; never asks the network, so the popup is not held up by an address that
 * is down.
 */
export async function reachStatus(): Promise<ReachStatus> {
    const primary = await currentOrigin();
    if (!primary) return NO_REACH;
    void learnOver(primary).catch(() => undefined);
    const record = await learned(primary);
    if (!record) return NO_REACH;
    const missing: string[] = [];
    for (const origin of alternatesOf(record, primary)) {
        if (!(await holdsOrigin(origin).catch(() => false))) missing.push(origin);
    }
    const now = held?.key.startsWith(`${primary} `) ? held.failover.status() : null;
    return {
        local: now?.local ?? false,
        untrusted: (now?.untrusted.length ?? 0) > 0 && !(now?.local ?? false),
        refused: (now?.refused ?? []).map((origin) => new URL(origin).host),
        missing
    };
}
