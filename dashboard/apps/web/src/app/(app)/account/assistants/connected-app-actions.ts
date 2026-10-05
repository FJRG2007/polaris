"use server";

/**
 * Changing and disconnecting an app a person connected over OAuth.
 *
 * Disconnecting ends every token it holds at once; the app has to come back
 * through the consent screen to be connected again. Changing its permissions
 * takes effect on its next call, and can only reach what Polaris offers over
 * MCP right now and what this person holds - the boxes the screen drew are not
 * what is trusted. A scope the app did not ask for may be added: it is the
 * person's to give, and the screen says which those are. Setting where it may
 * call from applies on its next call and next token refresh.
 */

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import { scopesAvailableTo } from "@polaris/auth";
import { recordAudit } from "@/lib/audit-service";
import { editableScopes, mcpScopes } from "@/lib/mcp/oauth/scopes";
import { getTranslations } from "@/lib/i18n/request";
import { newDeviceRefusal } from "@/lib/device-grace";
import { MCP_SCOPES, expandScopes, orderScopes, type McpScope } from "@/lib/mcp/scope-table";
import { localized } from "@/app/(app)/account/security/action-messages";
import { ipPolicySchema, type IpPolicy } from "@/lib/mcp/oauth/ip-policy";
import {
    changeGrantScopes,
    findConnectedApp,
    revokeConnectedApp,
    setGrantIpPolicy
} from "@/lib/mcp/oauth/grants";

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
    scopes: z.array(z.enum(MCP_SCOPES as [McpScope, ...McpScope[]])).max(MCP_SCOPES.length)
});

/** Change what a connected app may do. Answers with the set it now holds. */
export async function changeAppScopesAction(
    input: unknown
): Promise<{ scopes?: McpScope[]; error?: string }> {
    const user = await requireUser();
    const t = await getTranslations("mcp");
    const parsed = changeSchema.safeParse(input);
    if (!parsed.success || user.viewingAs) return { error: t("connectedApps.changeFailed") };

    const app = await findConnectedApp(user.id, parsed.data.id);
    if (!app) return { error: t("connectedApps.changeFailed") };

    // What the dialog could show: what is on offer now and the old scopes the
    // app still holds, cut to what this person holds. Only those are changed;
    // anything else the grant holds - the scopes of an app uninstalled since,
    // which would come back with it - is kept exactly as it was.
    const current = app.scopes;
    const editable = new Set(
        editableScopes(current, await mcpScopes(), await scopesAvailableTo(user.id, user.isAdmin))
    );
    const kept = current.filter((scope) => !editable.has(scope));
    const scopes = orderScopes([
        ...expandScopes(parsed.data.scopes).filter((scope) => editable.has(scope)),
        ...kept
    ]);
    if (scopes.length === kept.length) return { error: t("connectedApps.pickOne") };

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

const ipRuleSchema = z.object({ id: z.string().uuid(), policy: ipPolicySchema });

/** Set where a connected app may call from. Answers with the rule now held. */
export async function setAppIpPolicyAction(
    input: unknown
): Promise<{ policy?: IpPolicy; error?: string }> {
    const user = await requireUser();
    const t = await getTranslations("mcp");
    const parsed = ipRuleSchema.safeParse(input);
    if (!parsed.success || user.viewingAs) return { error: t("connectedApps.ip.failed") };

    const app = await findConnectedApp(user.id, parsed.data.id);
    if (!app) return { error: t("connectedApps.ip.failed") };
    const { policy } = parsed.data;
    const stored: IpPolicy =
        policy.mode === "list" ? policy : { mode: policy.mode, allow: [], deny: [] };
    if (stored.mode === "origin" && !app.approvedIp)
        return { error: t("connectedApps.ip.noOrigin") };

    // Narrowing where an app may call from is always allowed; anything that
    // could widen it is a change to a credential and waits out a new device.
    if (stored.mode === "none" || stored.mode === "list") {
        const blocked = await newDeviceRefusal(user);
        if (blocked) return localized({ error: blocked });
    }

    if (!(await setGrantIpPolicy(user.id, app.id, stored))) {
        return { error: t("connectedApps.ip.failed") };
    }
    await recordAudit({
        actorId: user.id,
        action: "account.oauth.ip-rule-changed",
        targetType: "oauthGrant",
        targetId: app.id,
        metadata: { app: app.name, before: app.ipPolicy, after: stored }
    });
    revalidatePath(PAGE);
    return { policy: stored };
}
