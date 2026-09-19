/**
 * A face for the extension to draw: the connected account's own, or one of its
 * organizations'.
 *
 * Its own route rather than `/api/avatar/...` because the extension carries no
 * session cookie - it proves itself with the connection's token - and the
 * dashboard's picture routes answer a signed-in browser. What this serves is
 * narrower than theirs on purpose: the account's own face, and the mark of an
 * organization it belongs to. Nobody else's.
 *
 * No picture is a 204 rather than the blank pixel the dashboard uses, because
 * the extension draws initials itself and has nothing to lay a pixel over.
 */

import { z } from "zod";
import { scopeChoices } from "@/lib/workspace-scope";
import { resolveAvatar, resolveOrgAvatar } from "@/lib/avatar-service";
import { clientHost, clientIp, clientUserAgent } from "@/lib/request-context";
import { bearerToken, readExtensionToken } from "@/lib/extension/sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const orgSchema = z.string().uuid();

const none = () =>
    new Response(null, { status: 204, headers: { "Cache-Control": "private, no-store" } });

export async function GET(request: Request): Promise<Response> {
    const principal = await readExtensionToken(bearerToken(request), {
        ip: (await clientIp()) ?? null,
        userAgent: (await clientUserAgent()) ?? null,
        host: (await clientHost()) ?? null
    });
    if (!principal) return Response.json({ error: "connection-ended" }, { status: 401 });

    const asked = new URL(request.url).searchParams.get("org");
    let picture;
    if (asked === null) {
        picture = (await resolveAvatar(principal.userId)).picture;
    } else {
        const orgId = orgSchema.safeParse(asked);
        if (!orgId.success)
            return Response.json({ error: "Unknown organization." }, { status: 400 });
        // Only an organization this account is part of. Anything else is answered
        // exactly as one with no picture, so this cannot be used to test ids.
        const mine = await scopeChoices(principal.userId);
        if (!mine.some((org) => org.id === orgId.data)) return none();
        picture = await resolveOrgAvatar(orgId.data);
    }
    if (!picture) return none();

    const bytes = await picture.load();
    if (!bytes) return none();
    return new Response(bytes as BodyInit, {
        headers: {
            "Content-Type": picture.mime,
            "Content-Length": String(bytes.length),
            "Cache-Control": "private, no-store",
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "default-src 'none'; sandbox"
        }
    });
}
