/**
 * Sends over the API, including the one endpoint here that a stranger reaches.
 *
 * `access` is open by design: whoever holds the link has no account, and the
 * link plus the key in its fragment is the credential. What it returns is
 * deliberately less than the owner sees - no counts, no limits, and the maker's
 * address only when they chose to show it.
 */

import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import * as sends from "@/lib/vault/sends";
import { vaultError } from "@/lib/vault/auth";
import { rateLimit } from "@/lib/rate-limit-service";
import { clientIp, hashForLog } from "@/lib/request-context";
import { readJsonBody, requirePrincipal, type VaultContext } from "@/lib/vault/api/router";

/** Guesses allowed against a Send's password from one address, and the window. */
const ACCESS_LIMIT = 20;
const ACCESS_WINDOW_MS = 15 * 60 * 1000;

export async function listSends(context: VaultContext): Promise<Response> {
    const principal = requirePrincipal(context);
    return Response.json({
        object: "list",
        continuationToken: null,
        data: await sends.listSends(principal.userId)
    });
}

export async function getSend(context: VaultContext): Promise<Response> {
    const send = await sends.getSend(requirePrincipal(context).userId, context.params.id ?? "");
    if (!send) return vaultError("Not found", 404);
    return Response.json(send);
}

export async function createSend(context: VaultContext): Promise<Response> {
    const principal = requirePrincipal(context);
    const parsed = core.sendSchema.safeParse(await readJsonBody(context.request));
    if (!parsed.success) {
        return vaultError(parsed.error.issues[0]?.message ?? "Invalid send", 400);
    }
    return Response.json(await sends.createSend(principal.userId, parsed.data));
}

export async function updateSend(context: VaultContext): Promise<Response> {
    const principal = requirePrincipal(context);
    const parsed = core.sendSchema.safeParse(await readJsonBody(context.request));
    if (!parsed.success) {
        return vaultError(parsed.error.issues[0]?.message ?? "Invalid send", 400);
    }
    const send = await sends.updateSend(principal.userId, context.params.id ?? "", parsed.data);
    if (!send) return vaultError("Not found", 404);
    return Response.json(send);
}

export async function removeSendPassword(context: VaultContext): Promise<Response> {
    const principal = requirePrincipal(context);
    const send = await sends.removeSendPassword(principal.userId, context.params.id ?? "");
    if (!send) return vaultError("Not found", 404);
    return Response.json(send);
}

export async function deleteSend(context: VaultContext): Promise<Response> {
    const principal = requirePrincipal(context);
    if (!(await sends.deleteSend(principal.userId, context.params.id ?? ""))) {
        return vaultError("Not found", 404);
    }
    return new Response(null, { status: 200 });
}

/**
 * Open a Send from its public link.
 *
 * Password guesses are capped per address, because this is the one endpoint in
 * the vault a stranger can hammer. A Send that has run out, expired or been
 * turned off answers 404 rather than explaining which: to somebody holding a
 * dead link the difference does not help, and to somebody probing links it does.
 */
export async function accessSend(context: VaultContext): Promise<Response> {
    const limitKey = `vault-send-access:${hashForLog(await clientIp()) ?? "unknown"}`;
    if (!(await rateLimit(limitKey, ACCESS_LIMIT, ACCESS_WINDOW_MS)).ok) {
        return vaultError("Too many attempts. Try again in a few minutes.", 429);
    }

    const body = (await readJsonBody(context.request)) as { password?: unknown } | null;
    const password = typeof body?.password === "string" ? body.password : undefined;
    const result = await sends.accessSend(context.params.id ?? "", password);
    if (!result.ok) {
        if (result.reason === "password") {
            // 401 is what tells a client to ask for the password rather than to
            // report the link as broken.
            return vaultError("Invalid password", 401);
        }
        return vaultError("Not found", 404);
    }

    const creator = result.send.hideEmail
        ? null
        : ((
              await prisma.vaultSend.findUnique({
                  where: { id: result.send.id },
                  select: { vault: { select: { user: { select: { email: true } } } } }
              })
          )?.vault.user.email ?? null);

    return Response.json(sends.toSendAccessResponse(result.send, result.document, creator));
}
