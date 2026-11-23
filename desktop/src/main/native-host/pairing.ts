/**
 * Presenting the extension's nonce to the server, over this app's own
 * signed-in session, so the server can bind the extension's connection to
 * this computer's device key (`apps/web/src/lib/device-sessions/device-pairing.ts`).
 *
 * Only a nonce for the server this app is showing is presented, and only from
 * an extension the host manifests allow: the browser already enforces that,
 * and this checks it again so a message from anything else on the computer
 * that reached the socket presents nothing.
 *
 * The network call is injected, so the decisions can be tested.
 */

import type { PairMessage } from "./protocol";
import { FIREFOX_EXTENSION_ID, type NativePairReply } from "../../../../dashboard/packages/core/src/device-pairing";

export interface PairingDeps {
    /** The origins this app is showing: its server and, while failed over, the local address in use. */
    readonly servers: () => readonly string[];
    /** The Chromium extension ids the host manifests currently allow. */
    readonly allowedIds: () => ReadonlySet<string>;
    /** POST the nonce to `/api/device-pairing/claim` on `origin`; the HTTP status, or null when unreachable. */
    readonly claim: (origin: string, nonce: string) => Promise<number | null>;
}

export async function presentNonce(message: PairMessage, deps: PairingDeps): Promise<NativePairReply> {
    const caller = message.caller;
    const allowed = caller.browser === "firefox" ? caller.id === FIREFOX_EXTENSION_ID : deps.allowedIds().has(caller.id);
    if (!allowed) return { ok: false, reason: "refused" };
    if (!deps.servers().includes(message.server)) return { ok: false, reason: "other-server" };

    const status = await deps.claim(message.server, message.nonce);
    if (status === null) return { ok: false, reason: "unreachable" };
    if (status >= 200 && status < 300) return { ok: true };
    if (status === 401) return { ok: false, reason: "signed-out" };
    if (status === 400) return { ok: false, reason: "bad-request" };
    return { ok: false, reason: "refused" };
}
