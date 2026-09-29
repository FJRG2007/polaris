/**
 * The gate in front of every public snippet endpoint.
 *
 * A snippet link carries no session - the token, plus any password, is the
 * credential - so the page, the raw endpoint, the download and the reveal of a
 * one-time secret all have to run the same checks in the same order. Keeping
 * them here is what stops a gap opening between them: the page asks for a
 * password and the raw endpoint forgets to is exactly the bug this shape
 * prevents.
 *
 * Order matters and mirrors the share gate: exists, still usable, address rules,
 * fraud check, who it was shared with, then the password.
 */

import { cookies } from "next/headers";
import { loadEnv } from "@polaris/config";
import { getSession } from "@/lib/session";
import { dymoIpAllowed } from "@/lib/dymo-service";
import { linkAddressDenial } from "@/lib/link-guards";
import { linkDenialMessage } from "@/lib/link-denial";
import { clientIp, clientUserAgent, hashForLog } from "@/lib/request-context";
import {
    logSnippetAccess,
    resolveSnippetByToken,
    snippetUnlockCookie,
    snippetUsability,
    verifySnippetUnlock,
    type SnippetRecord
} from "@/lib/snippet-service";

/** A snippet that cleared every gate, with the request context for its log. */
export type SnippetGate =
    | {
          ok: true;
          snippet: NonNullable<SnippetRecord>;
          ip: string | undefined;
          ipHash: string | undefined;
          userAgentHash: string | undefined;
          /** The signed-in viewer, when there is one. */
          userId: string | null;
      }
    | { ok: false; status: number; reason: string };

/** Why a gate refused, in words the visitor can act on and in their language. */
export async function snippetDenialMessage(reason: string): Promise<string> {
    return linkDenialMessage(reason);
}

/**
 * Resolve a snippet by token and run every gate. On a refusal the attempt is
 * logged (best-effort) under the given action label; success is not logged here,
 * because each caller records what it actually did.
 */
export async function gateSnippetRequest(token: string, action: string): Promise<SnippetGate> {
    const snippet = await resolveSnippetByToken(token);
    if (!snippet) return { ok: false, status: 404, reason: "not_found" };

    const ip = await clientIp();
    const ipHash = hashForLog(ip);
    const userAgentHash = hashForLog(await clientUserAgent());
    const deny = (status: number, reason: string): SnippetGate => {
        void logSnippetAccess({ snippetId: snippet.id, action, reason, ip, ipHash, userAgentHash });
        return { ok: false, status, reason };
    };

    // A private snippet has no link to honour at all: whatever token was
    // presented, it is not something to serve.
    if (snippet.visibility === "private") return deny(410, "revoked");

    const usable = snippetUsability(snippet);
    if (!usable.ok) return deny(410, usable.reason);

    const address = await linkAddressDenial(snippet, ip);
    if (address) return deny(403, address);

    // Fraud check. A no-op unless the integration is on, and it fails open.
    if (!(await dymoIpAllowed(ip)).allowed) return deny(403, "ip_flagged");

    const session = await getSession();
    const userId = session?.user?.id ?? null;
    if (snippet.visibility === "invite") {
        if (!userId) return deny(401, "sign_in_required");
        // The owner always reaches their own, whether or not they invited
        // themselves - being turned away from your own snippet reads as a bug.
        const invited =
            snippet.ownerId === userId ||
            snippet.invites.some((invite) => invite.userId === userId);
        if (!invited) return deny(403, "not_invited");
    }

    if (snippet.passwordHash) {
        const cookieValue = (await cookies()).get(snippetUnlockCookie(snippet.id))?.value;
        if (
            !verifySnippetUnlock(
                snippet.id,
                cookieValue,
                snippet.passwordHash,
                loadEnv().POLARIS_AUTH_SECRET
            )
        ) {
            return deny(401, "password_required");
        }
    }

    return { ok: true, snippet, ip, ipHash, userAgentHash, userId };
}
