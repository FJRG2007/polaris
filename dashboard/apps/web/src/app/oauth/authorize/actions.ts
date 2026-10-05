"use server";

/**
 * Answering the consent screen.
 *
 * The form sends back the query the screen was drawn for and the boxes that
 * were ticked. Neither is trusted: the request is checked again from scratch
 * (the copy in the page is the browser's to edit), and the scopes are cut to
 * what the app asked for, what Polaris offers over MCP and what this person
 * holds right now. A server action carries Next's own Origin check, so another
 * site cannot post this form on somebody's behalf.
 */

import { z } from "zod";
import { requireUser } from "@/lib/session";
import { approve } from "@/lib/mcp/oauth/grants";
import { scopesAvailableTo } from "@polaris/auth";
import { recordAudit } from "@/lib/audit-service";
import { mcpScopes } from "@/lib/mcp/oauth/scopes";
import { getTranslations } from "@/lib/i18n/request";
import { newDeviceRefusal } from "@/lib/device-grace";
import { currentOrigin } from "@/lib/mcp/oauth/origin";
import { PERMISSIONS, expandPermissions } from "@polaris/core";
import { localized } from "@/app/(app)/account/security/action-messages";
import { answerUrl, checkAuthorizationRequest, readParams } from "@/lib/mcp/oauth/authorize";

const answerSchema = z.object({
    query: z.string().max(16 * 1024),
    allow: z.boolean(),
    scopes: z.array(z.enum(PERMISSIONS)).max(PERMISSIONS.length)
});

export async function answerAuthorizationAction(
    input: unknown
): Promise<{ redirectTo?: string; error?: string }> {
    const user = await requireUser();
    const t = await getTranslations("mcp");
    const parsed = answerSchema.safeParse(input);
    if (!parsed.success) return { error: t("consent.errors.failed") };
    if (user.viewingAs) return { error: t("consent.errors.viewingAs") };

    const origin = await currentOrigin();
    const supported = mcpScopes();
    const check = await checkAuthorizationRequest(
        readParams(new URLSearchParams(parsed.data.query)),
        origin,
        supported
    );
    if (check.kind === "unsafe") return { error: t(`consent.errors.${check.reason}`) };
    if (check.kind === "redirect") return { redirectTo: check.url };
    const { request } = check;

    if (!parsed.data.allow) {
        return {
            redirectTo: answerUrl(request.redirectUri, origin, {
                error: "access_denied",
                error_description: "The person declined to connect this app",
                state: request.state
            })
        };
    }

    const blocked = await newDeviceRefusal(user);
    if (blocked) return localized({ error: blocked });

    const held = new Set(await scopesAvailableTo(user.id, user.isAdmin));
    const offered = new Set(supported);
    const asked = new Set(request.scopes);
    // What a ticked scope implies comes with it (managing tasks without reading
    // them is not a grant anybody means), and then everything is cut to what is
    // offered and held.
    const scopes = expandPermissions(parsed.data.scopes.filter((scope) => asked.has(scope))).filter(
        (scope) => offered.has(scope) && held.has(scope)
    );
    if (scopes.length === 0) return { error: t("consent.pickOne") };

    const { code, grantId } = await approve({
        userId: user.id,
        client: request.client,
        redirectUri: request.redirectUri,
        codeChallenge: request.codeChallenge,
        resource: request.resource,
        scopes,
        requested: request.scopes
    });
    await recordAudit({
        actorId: user.id,
        action: "account.oauth.connected",
        targetType: "oauthGrant",
        targetId: grantId,
        metadata: { app: request.client.name, returnsTo: new URL(request.redirectUri).host, scopes }
    });
    return { redirectTo: answerUrl(request.redirectUri, origin, { code, state: request.state }) };
}
