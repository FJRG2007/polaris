/**
 * One bucket of the breached-password corpus, for the browser extension.
 *
 * The extension watches somebody invent a password on a sign-up form and says so
 * when it is already public, which is the one moment where saying it costs
 * nothing. It cannot ask the corpus directly: its manifest declares no host
 * permission at all - the only origin it may reach is the Polaris somebody
 * pointed it at - and adding a second host to a password manager for this would
 * be spending far more than the answer is worth. So it asks here, exactly as it
 * asks here about its own updates.
 *
 * **What arrives is five hexadecimal characters and nothing else.** That is the
 * whole of the k-anonymity model: the prefix names one bucket in a million, the
 * answer is every hash in it, and which of them was being asked about is decided
 * in the extension. This route cannot learn a password from what it is given, and
 * neither can the corpus - and the schema below is what keeps it that way, since
 * a path that accepted a longer string would be a path somebody could send a
 * whole hash to.
 *
 * Unauthenticated, like the update check beside it, and for the same reason: the
 * extension holds no Polaris session - its token is for the vault surface - and a
 * warning that only reached people with an unlocked vault would miss the moment
 * it exists for. What it exposes is a public dataset, keyed by a value that
 * identifies nobody.
 *
 * A corpus that cannot be reached answers 503 rather than an empty range, because
 * an empty range reads as "no breach" and would turn somebody else's outage into
 * a password quietly approved.
 */

import { z } from "zod";
import { pwnedRange } from "@/lib/pwned-passwords";

export const runtime = "nodejs";

/** The only shape a prefix has. Five characters of uppercase hexadecimal, which
 *  is what the corpus is indexed by and all it is ever sent. */
const prefixSchema = z
    .string()
    .regex(/^[0-9a-fA-F]{5}$/)
    .transform((value) => value.toUpperCase());

/** A day. The corpus is republished a few times a year, and a browser that asks
 *  twice about the same bucket should not wake this route twice. */
const CACHE_SECONDS = 86_400;

export async function GET(
    _request: Request,
    { params }: { params: Promise<{ prefix: string }> }
): Promise<Response> {
    const prefix = prefixSchema.safeParse((await params).prefix);
    if (!prefix.success) return new Response("That is not a hash prefix.", { status: 400 });

    const range = await pwnedRange(prefix.data);
    if (range === null) {
        return new Response("The corpus could not be reached.", { status: 503 });
    }

    return new Response(range, {
        headers: {
            "content-type": "text/plain; charset=utf-8",
            "cache-control": `public, max-age=${CACHE_SECONDS}`
        }
    });
}
