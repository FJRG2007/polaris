"use server";

/**
 * Changing and disconnecting an app a person connected over OAuth.
 *
 * Disconnecting ends every token it holds at once; the app has to come back
 * through the consent screen to be connected again. Changing its permissions
 * takes effect on its next call, and can only reach what the app asked for,
 * what Polaris offers over MCP and what this person holds right now - the
 * boxes the screen drew are not what is trusted.
 */

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import { scopesAvailableTo } from "@polaris/auth";
import { recordAudit } from "@/lib/audit-service";
import { mcpScopes } from "@/lib/mcp/oauth/scopes";
import { getTranslations } from "@/lib/i18n/request";
import { newDeviceRefusal } from "@/lib/device-grace";
import { PERMISSIONS, expandPermissions } from "@polaris/core";
import { localized } from "@/app/(app)/account/security/action-messages";
import { changeGrantScopes, findConnectedApp, revokeConnectedApp } from "@/lib/mcp/oauth/grants";

const PAGE = "/account/assistants";

const idSchema = z.string().uuid();

export async function disconnectAppAction(id: unknown): Promise<{ error?: string }> {
    const user = await requireUser();
    const t = await getTranslations("mcp");
    const parsed = idSchema.safeParse(id);
    // Disconnecting is never refused for a new device or a view: taking access
    // away is the one change that is always safe to allow.
    if (!parsed.success || user.viewingAs) return { error: t("connectedApps.failed") };
    const done = await revokeConnectedApp(user.id, parsed.data);
    if (!done) return { error: t("connectedApps.failed") };
    await recordAudit({
        actorId: user.id,
        action: "account.oauth.disconnected",
        targetType: "oauthGrant",
        targetId: parsed.data
    });
    revalidatePath(PAGE);
    return {};
}

const changeSchema = z.object({
    id: z.string().uuid(),
    scopes: z.array(z.enum(PERMISSIONS)).max(PERMISSIONS.length)
});

/** Change what a connected app may do. Answers with the set it now holds. */
export async function changeAppScopesAction(
    input: unknown
): Promise<{ scopes?: string[]; error?: string }> {
    const user = await requireUser();
    const t = await getTranslations("mcp");
    const parsed = changeSchema.safeParse(input);
    if (!parsed.success || user.viewingAs) return { error: t("connectedApps.changeFailed") };

    const app = await findConnectedApp(user.id, parsed.data.id);
    if (!app) return { error: t("connectedApps.changeFailed") };

    const held = new Set(await scopesAvailableTo(user.id, user.isAdmin));
    const offered = new Set<string>(mcpScopes());
    const requestable = new Set(app.requestable);
    const scopes = expandPermissions(parsed.data.scopes).filter(
        (scope) => requestable.has(scope) && offered.has(scope) && held.has(scope)
    );
    if (scopes.length === 0) return { error: t("connectedApps.pickOne") };

    // Taking access away is always allowed, as disconnecting is; giving more
    // is a grant like any other and waits out a new device.
    const before = new Set(app.scopes);
    const added = scopes.filter((scope) => !before.has(scope));
    if (added.length > 0) {
        const blocked = await newDeviceRefusal(user);
        if (blocked) return localized({ error: blocked });
    }

    const changed = await changeGrantScopes(user.id, app.id, scopes);
    if (!changed) return { error: t("connectedApps.changeFailed") };
    const now = new Set<string>(scopes);
    await recordAudit({
        actorId: user.id,
        action: "account.oauth.updated",
        targetType: "oauthGrant",
        targetId: app.id,
        metadata: {
            app: app.name,
            added,
            removed: changed.before.filter((scope) => !now.has(scope))
        }
    });
    revalidatePath(PAGE);
    return { scopes };
}
