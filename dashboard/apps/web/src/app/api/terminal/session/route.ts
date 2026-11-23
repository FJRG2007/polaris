/**
 * DELETE /api/terminal/session - Polaris Terminal signing itself out.
 *
 * The key it presents revokes itself, so signing out on one machine does not
 * need the dashboard. Only a key Polaris Terminal's own sign-in was handed can
 * do this: any other key is answered 409 and left alone, because a key made on
 * the API keys screen is very likely in use somewhere else too.
 */

import { endCliSignIn } from "@/lib/cli/sign-in";
import { recordAudit } from "@/lib/audit-service";
import { readerWords } from "@/lib/i18n/reader-words";
import { authenticateApiKey } from "@/lib/api-key-auth";
import { withKeyUsage } from "@/lib/api-usage/recorder";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const DELETE = withKeyUsage(async (request: Request): Promise<Response> => {
    const principal = await authenticateApiKey(request);
    // Already revoked, expired or never valid: there is nothing left to end, which
    // is what the terminal wanted.
    if (!principal)
        return Response.json(
            { error: (await readerWords("api"))("errors.cliSignInInvalid") },
            { status: 401 }
        );

    const ended = await endCliSignIn(principal, "terminal");
    if (!ended) {
        return Response.json(
            { error: (await readerWords("api"))("errors.terminalNotASignIn") },
            { status: 409 }
        );
    }
    await recordAudit({
        actorId: principal.userId,
        action: "account.terminal.signedOut",
        targetType: "apiKey",
        targetId: principal.keyId
    });
    return new Response(null, { status: 204 });
});
