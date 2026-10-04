/**
 * DELETE /api/cli/session - end the sign-in this request presents (`plr logout`).
 *
 * The key revokes itself, so logging out on one machine does not need the
 * dashboard. Only a key `plr login` was handed can do this: a key from the API
 * keys screen passed in through `POLARIS_TOKEN` is answered 409 and left alone,
 * because it is very likely in use somewhere else too.
 */

import { endCliSignIn } from "@/lib/cli/sign-in";
import { recordAudit } from "@/lib/audit-service";
import { readerWords } from "@/lib/i18n/reader-words";
import { authenticateApiKey } from "@/lib/api-key-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(request: Request): Promise<Response> {
    const principal = await authenticateApiKey(request);
    // Already revoked, expired or never valid: there is nothing left to end, which
    // is what the CLI wanted.
    if (!principal)
        return Response.json(
            { error: (await readerWords("api"))("errors.cliSignInInvalid") },
            { status: 401 }
        );

    const ended = await endCliSignIn(principal);
    if (!ended) {
        return Response.json(
            { error: (await readerWords("api"))("errors.cliNotASignIn") },
            { status: 409 }
        );
    }
    await recordAudit({
        actorId: principal.userId,
        action: "account.cli.signedOut",
        targetType: "apiKey",
        targetId: principal.keyId
    });
    return new Response(null, { status: 204 });
}
