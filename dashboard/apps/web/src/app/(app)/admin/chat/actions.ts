"use server";

/**
 * Saving the house rules for one kind of conversation.
 *
 * Validated against the same schema the reader parses with, so a value that
 * would be ignored on the way out is refused on the way in rather than stored
 * and silently replaced by a default.
 */

import * as core from "@polaris/core";
import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/session";
import { listHosts } from "@/lib/host-service";
import { setChatRules } from "@/lib/chat/rules";
import * as calls from "@/lib/chat/call-server";
import { recordAudit } from "@/lib/audit-service";

export async function setChatRulesAction(
    scope: unknown,
    rules: unknown
): Promise<{ error?: string }> {
    const admin = await requireAdmin();

    const chosen = core.CHAT_RULE_SCOPES.find((entry) => entry === scope);
    if (!chosen) return { error: "That is not a kind of conversation" };

    const parsed = core.chatRulesSchema.safeParse(rules);
    if (!parsed.success) {
        return { error: parsed.error.issues[0]?.message ?? "Those limits could not be saved" };
    }

    await setChatRules(chosen, parsed.data);
    await recordAudit({
        actorId: admin.id,
        action: "chat.rules.update",
        targetType: "setting",
        targetId: `chat.rules.${chosen}`,
        metadata: { ...parsed.data }
    });
    revalidatePath("/admin/chat");
    return {};
}

/** How calls are carried here, as the card draws it. */
export async function callServerSettingsAction(): Promise<{
    settings?: calls.CallServerSettings;
    error?: string;
}> {
    await requireAdmin();
    return { settings: await calls.callServerSettings() };
}

/** The machines a call server can be put on. */
export async function callServerMachinesAction(): Promise<{
    machines?: { id: string; label: string }[];
    error?: string;
}> {
    const admin = await requireAdmin();
    const hosts = await listHosts(admin.id);
    return {
        machines: [
            { id: "local", label: "This machine" },
            ...hosts.map((host) => ({ id: host.id, label: host.name }))
        ]
    };
}

/**
 * Put a call server up, on a machine somebody chose.
 *
 * Slow the first time - it is a deploy - and instant afterwards. Nothing about
 * an existing call changes when it lands: a call already running browser to
 * browser stays that way until it ends, and the next one goes through this.
 */
export async function installCallServerAction(serverId: unknown): Promise<{ error?: string }> {
    const admin = await requireAdmin();
    const server = typeof serverId === "string" ? serverId : "";
    if (!server) return { error: "Pick a machine to run it on" };

    try {
        await calls.installCallServer(admin.id, admin.id, server);
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "It could not be installed" };
    }
    await recordAudit({
        actorId: admin.id,
        action: "chat.calls.install",
        targetType: "setting",
        targetId: "chat.calls",
        metadata: { server }
    });
    revalidatePath("/admin/chat");
    return {};
}

/**
 * Point calls at a server somebody runs themselves, or unpoint them.
 *
 * Still here after the button above, and on purpose: a house that already runs
 * one should not have to install a second. An empty address clears the pairing,
 * which is how this is switched off - and the audit records that it changed
 * rather than what it changed to, because one of the three values is a signing
 * key.
 */
export async function setCallServerAction(
    url: unknown,
    apiKey: unknown,
    apiSecret: unknown
): Promise<{ error?: string }> {
    const admin = await requireAdmin();
    try {
        await calls.setCallServer(String(url ?? ""), String(apiKey ?? ""), String(apiSecret ?? ""));
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "That could not be saved" };
    }
    await recordAudit({
        actorId: admin.id,
        action: "chat.calls.configure",
        targetType: "setting",
        targetId: "chat.calls",
        metadata: { cleared: String(url ?? "").trim() === "" }
    });
    revalidatePath("/admin/chat");
    return {};
}
