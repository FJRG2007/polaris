/**
 * Proving to Polaris that this extension runs on the same computer as Polaris
 * Desktop, so Account > Sessions shows the browser, its extension and the
 * desktop app as one device instead of two.
 *
 * The extension asks its server for a short-lived nonce bound to its own
 * connection, and hands it to Polaris Desktop through the browser's native
 * messaging host (`NATIVE_HOST_NAME`, registered by the desktop app). The
 * desktop presents it over its own signed-in session, and the server binds this
 * connection to the desktop's device key. Nothing about the machine passes
 * through here.
 *
 * Quiet by design: no desktop app, an old server without the endpoint, a
 * browser that does not let the extension reach the host - every one of them
 * just leaves the rows ungrouped. Nothing is ever shown for it.
 */

import { z } from "zod";
import { CHROMIUM_EXTENSION_ID_PATTERN, NATIVE_HOST_NAME, PAIRING_NONCE_PATTERN, type NativePairRequest } from "@polaris/core";

/** How long a call may take before it is given up on. */
const TIMEOUT_MS = 20_000;

/** How long to wait before trying again after an attempt that did not pair. */
export const PAIRING_RETRY_MS = 6 * 60 * 60 * 1000;

/** How an attempt ended. Only `paired` stops the asking for good. */
export type PairingOutcome = "paired" | "sent" | "unsupported" | "signed-out" | "no-desktop" | "refused" | "failed";

const offerSchema = z.union([
    z.object({ paired: z.literal(true) }),
    z.object({ paired: z.literal(false), nonce: z.string().regex(PAIRING_NONCE_PATTERN), expiresAt: z.string() })
]);

const replySchema = z.union([
    z.object({ ok: z.literal(true) }),
    z.object({ ok: z.literal(false), reason: z.string().max(40) })
]);

/** What an attempt needs from the browser, injected so it can be tested. */
export interface PairingDeps {
    readonly fetch: typeof fetch;
    /** `runtime.sendNativeMessage`, or null where the browser has none. */
    readonly sendNative: ((host: string, message: NativePairRequest) => Promise<unknown>) | null;
    /** `runtime.id`, sent only when it is a Chromium id. */
    readonly runtimeId: string | null;
}

/** One attempt to pair this connection with the desktop app on this computer. */
export async function pairWithDesktop(origin: string, token: string, deps: PairingDeps): Promise<PairingOutcome> {
    const runtimeId = deps.runtimeId && CHROMIUM_EXTENSION_ID_PATTERN.test(deps.runtimeId) ? deps.runtimeId : null;
    let reply: Response;
    try {
        reply = await deps.fetch(`${origin}/api/extension/device-pairing`, {
            method: "POST",
            headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
            body: JSON.stringify({ runtimeId }),
            credentials: "omit",
            signal: AbortSignal.timeout(TIMEOUT_MS)
        });
    } catch {
        return "failed";
    }
    // A server from before pairing answers with its not-found page.
    if (reply.status === 404 || reply.status === 405) return "unsupported";
    if (reply.status === 401) return "signed-out";
    if (!reply.ok) return "failed";
    const offer = offerSchema.safeParse(await reply.json().catch(() => null));
    if (!offer.success) return "unsupported";
    if (offer.data.paired) return "paired";
    if (!deps.sendNative) return "no-desktop";

    let answer: unknown;
    try {
        answer = await deps.sendNative(NATIVE_HOST_NAME, { type: "pair", server: origin, nonce: offer.data.nonce });
    } catch {
        // Not registered, not allowed for this extension, or the host failed to
        // start: there is no desktop app here to pair with, as far as we can tell.
        return "no-desktop";
    }
    const read = replySchema.safeParse(answer);
    if (!read.success) return "failed";
    return read.data.ok ? "sent" : "refused";
}

/** What is remembered between attempts, per connection. */
export interface PairingMemory {
    /** Which connection it is about: the server and the account connected. */
    readonly connection: string;
    readonly paired: boolean;
    readonly triedAt: number;
}

/** Whether to try now. A paired connection never asks again; a desktop that
 *  just took the nonce is asked about once more soon, to learn it paired. */
export function pairingDue(memory: PairingMemory | null, connection: string, now: number): boolean {
    if (!memory || memory.connection !== connection) return true;
    if (memory.paired) return false;
    return now - memory.triedAt >= PAIRING_RETRY_MS;
}

/** What to remember after an attempt. `sent` is remembered as not yet paired
 *  with an old timestamp, so the next check confirms it. */
export function rememberPairing(connection: string, outcome: PairingOutcome, now: number): PairingMemory {
    return {
        connection,
        paired: outcome === "paired",
        triedAt: outcome === "sent" ? now - PAIRING_RETRY_MS : now
    };
}
