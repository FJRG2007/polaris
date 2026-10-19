"use server";

/**
 * Deploy hook actions, for the card in a service's settings. Each one
 * re-resolves the session and is scoped to that account's own hooks; making one
 * also checks, in the service layer, that the account may redeploy the service.
 */

import { z } from "zod";
import { requireUser } from "@/lib/session";
import { appBaseUrl } from "@/lib/domain-service";
import { getTranslations } from "@/lib/i18n/request";
import * as inbound from "@/lib/deploy/inbound-hooks";

const idSchema = z.string().uuid();

async function words(code: "invalid" | "rateLimited" | "limit" | "forbidden" | "notFound") {
    const t = await getTranslations("deployService");
    return t(`deployHooks.errors.${code}`, { max: inbound.MAX_INBOUND_HOOKS });
}

/**
 * This service's hooks of the account, the account's hooks on other services
 * (they share one cap, and may sit on a service it can no longer open), whether
 * it may add one here, and the address their URLs start with.
 */
export async function listDeployHooksAction(applicationId: unknown): Promise<{
    hooks?: inbound.InboundHookView[];
    others?: inbound.InboundHookView[];
    mayCreate?: boolean;
    max?: number;
    baseUrl?: string;
    error?: string;
}> {
    const user = await requireUser();
    const parsed = idSchema.safeParse(applicationId);
    if (!parsed.success) return { error: await words("invalid") };
    const [all, mayCreate, baseUrl] = await Promise.all([
        inbound.listInboundHooks(user.id),
        inbound.mayRedeploy(user.id, parsed.data),
        appBaseUrl().catch(() => "")
    ]);
    return {
        hooks: all.filter((hook) => hook.applicationId === parsed.data),
        others: all.filter((hook) => hook.applicationId !== parsed.data),
        mayCreate,
        max: inbound.MAX_INBOUND_HOOKS,
        baseUrl
    };
}

export async function createDeployHookAction(
    input: unknown
): Promise<{ hook?: inbound.InboundHookView; secret?: string; error?: string }> {
    const user = await requireUser();
    const parsed = inbound.inboundHookInputSchema.safeParse(input);
    if (!parsed.success) return { error: await words("invalid") };
    const result = await inbound.createInboundHook(user.id, parsed.data);
    if ("error" in result) return { error: await words(result.error) };
    return result;
}

export async function setDeployHookEnabledAction(
    id: unknown,
    enabled: unknown
): Promise<{ error?: string }> {
    const user = await requireUser();
    const parsedId = idSchema.safeParse(id);
    const parsedEnabled = z.boolean().safeParse(enabled);
    if (!parsedId.success || !parsedEnabled.success) return { error: await words("invalid") };
    if (!(await inbound.setInboundHookEnabled(user.id, parsedId.data, parsedEnabled.data))) {
        return { error: await words("notFound") };
    }
    return {};
}

export async function rotateDeployHookSecretAction(
    id: unknown
): Promise<{ secret?: string; error?: string }> {
    const user = await requireUser();
    const parsed = idSchema.safeParse(id);
    if (!parsed.success) return { error: await words("notFound") };
    const result = await inbound.rotateInboundHookSecret(user.id, parsed.data);
    return "error" in result ? { error: await words(result.error) } : result;
}

export async function deleteDeployHookAction(id: unknown): Promise<{ error?: string }> {
    const user = await requireUser();
    const parsed = idSchema.safeParse(id);
    if (!parsed.success || !(await inbound.deleteInboundHook(user.id, parsed.data))) {
        return { error: await words("notFound") };
    }
    return {};
}
