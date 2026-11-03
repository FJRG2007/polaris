/**
 * Whether an address typed in the servers window is a Polaris already on the
 * list under another name - `polaris.local` next to `polaris.example.com`.
 *
 * Settled by the instance's signature (`findSameInstance` in
 * `@polaris/core/instance-fallback`), never by the name or a matching page.
 *
 * Asked even when the address's certificate is one this computer does not
 * trust, since that is exactly the case of a Polaris on its local name: the
 * reader should hear "this is the one you already have", not a certificate
 * problem with an address they do not need. Those two requests go through a
 * session of their own, held in memory, that accepts the certificate of that
 * one host and only while it is being asked. Nothing of the person's goes there:
 * no cookie (the session has none, and the requests omit them), no API key, only
 * the public describe and challenge routes - and the answer is used for the
 * comparison and nothing else. The window itself still refuses that certificate.
 */

import { session, type Session } from "electron";
import { knownInstance } from "./polaris-api";
import type { SavedServer } from "@/shared/servers";
import { findSameInstance, type KnownInstance } from "../../../dashboard/packages/core/src/instance-fallback";

/** How long an answer is reused, so typing the address again asks nothing. */
const CACHE_MS = 30_000;
const TIMEOUT_MS = 5_000;

/** The hosts whose certificate the comparison session accepts right now, with how many askers each. */
const comparing = new Map<string, number>();
let comparison: Session | null = null;

function comparisonSession(): Session {
    if (comparison) return comparison;
    // No "persist:" prefix: in memory, gone with the app, shared with nothing.
    const created = session.fromPartition("polaris-same-instance");
    // 0 accepts, -3 leaves the decision to Chromium as usual.
    created.setCertificateVerifyProc((request, callback) => callback(comparing.has(request.hostname) ? 0 : -3));
    comparison = created;
    return created;
}

/** Run `ask` with the certificate of `host` accepted by the comparison session. */
async function acceptingCertificateOf<T>(host: string, ask: (on: Session) => Promise<T>): Promise<T> {
    const on = comparisonSession();
    comparing.set(host, (comparing.get(host) ?? 0) + 1);
    try {
        return await ask(on);
    } finally {
        const left = (comparing.get(host) ?? 1) - 1;
        if (left > 0) comparing.set(host, left);
        else comparing.delete(host);
    }
}

const memory = new Map<string, { readonly same: string | null; readonly until: number; }>();

/**
 * The listed server `origin` proves it is, or null. `untrusted` says the address
 * answered with a certificate this computer does not trust.
 */
export async function sameInstanceAs(origin: string, saved: readonly SavedServer[], untrusted: boolean): Promise<string | null> {
    const held = memory.get(origin);
    if (held && held.until > Date.now()) return held.same;
    const others = saved.filter((server) => server.origin !== origin);
    const records = await Promise.all(others.map((server) => knownInstance(server.origin)));
    const known: KnownInstance[] = others.flatMap((server, index) => {
        const record = records[index];
        return record ? [{ origin: server.origin, record }] : [];
    });
    const compare = (on: Session) =>
        findSameInstance([origin], known, (url, init) => on.fetch(url, { ...init, credentials: "omit" }), TIMEOUT_MS);
    const same = untrusted ? await acceptingCertificateOf(new URL(origin).hostname, compare) : await compare(session.defaultSession);
    if (memory.size >= 50) memory.delete(memory.keys().next().value!);
    memory.set(origin, { same: same?.origin ?? null, until: Date.now() + CACHE_MS });
    return same?.origin ?? null;
}
