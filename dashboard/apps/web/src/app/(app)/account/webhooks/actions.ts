"use server";

/**
 * Webhooks page actions. Each one re-resolves the session and scopes every query
 * to that account, and validates what the browser sent before it is used.
 */

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import { getTranslations } from "@/lib/i18n/request";
import { MAX_OUTBOUND_WEBHOOKS, outboundWebhookInputSchema } from "@polaris/core";
import * as hooks from "@/lib/notifications/outbound-hooks";
import * as inbound from "@/lib/deploy/inbound-hooks";

const idSchema = z.string().uuid();
const eventsSchema = outboundWebhookInputSchema.shape.events;

async function refusal(code: hooks.HookRefusal | "invalid" | "notSaved"): Promise<string> {
    const t = await getTranslations("accountNotifications");
    return code === "limit" ? t("webhooks.errors.limit", { max: MAX_OUTBOUND_WEBHOOKS }) : t(`webhooks.errors.${code}`);
}

export async function createOutboundHookAction(
    input: unknown
): Promise<{ hook?: hooks.OutboundHookView; secret?: string; error?: string }> {
    const user = await requireUser();
    const parsed = outboundWebhookInputSchema.safeParse(input);
    if (!parsed.success) return { error: await refusal("invalid") };
    const result = await hooks.createOutboundHook(user.id, parsed.data);
    if ("error" in result) return { error: await refusal(result.error) };
    revalidatePath("/account/webhooks");
    return result;
}

export async function setOutboundHookEventsAction(id: unknown, events: unknown): Promise<{ error?: string }> {
    const user = await requireUser();
    const parsedId = idSchema.safeParse(id);
    const parsedEvents = eventsSchema.safeParse(events);
    if (!parsedId.success || !parsedEvents.success) return { error: await refusal("invalid") };
    if (!(await hooks.setOutboundHookEvents(user.id, parsedId.data, parsedEvents.data))) {
        return { error: await refusal("notFound") };
    }
    revalidatePath("/account/webhooks");
    return {};
}

export async function setOutboundHookEnabledAction(id: unknown, enabled: unknown): Promise<{ error?: string }> {
    const user = await requireUser();
    const parsedId = idSchema.safeParse(id);
    const parsedEnabled = z.boolean().safeParse(enabled);
    if (!parsedId.success || !parsedEnabled.success) return { error: await refusal("notSaved") };
    if (!(await hooks.setOutboundHookEnabled(user.id, parsedId.data, parsedEnabled.data))) {
        return { error: await refusal("notFound") };
    }
    revalidatePath("/account/webhooks");
    return {};
}

export async function rotateOutboundHookSecretAction(id: unknown): Promise<{ secret?: string; error?: string }> {
    const user = await requireUser();
    const parsed = idSchema.safeParse(id);
    if (!parsed.success) return { error: await refusal("notFound") };
    const secret = await hooks.rotateOutboundHookSecret(user.id, parsed.data);
    return secret ? { secret } : { error: await refusal("notFound") };
}

export async function deleteOutboundHookAction(id: unknown): Promise<{ error?: string }> {
    const user = await requireUser();
    const parsed = idSchema.safeParse(id);
    if (!parsed.success || !(await hooks.deleteOutboundHook(user.id, parsed.data))) {
        return { error: await refusal("notFound") };
    }
    revalidatePath("/account/webhooks");
    return {};
}

export async function testOutboundHookAction(
    id: unknown
): Promise<{ status?: "sent" | "failed"; delivery?: hooks.OutboundDeliveryView; error?: string }> {
    const user = await requireUser();
    const parsed = idSchema.safeParse(id);
    if (!parsed.success) return { error: await refusal("notFound") };
    const t = await getTranslations("accountNotifications");
    const result = await hooks.testOutboundHook(user.id, parsed.data, {
        level: "info",
        title: t("webhooks.list.test"),
        body: null,
        url: null
    });
    if ("error" in result) return { error: await refusal(result.error) };
    return result;
}

export async function redeliverOutboundAction(
    deliveryId: unknown
): Promise<{ status?: "sent" | "failed"; delivery?: hooks.OutboundDeliveryView; error?: string }> {
    const user = await requireUser();
    const parsed = idSchema.safeParse(deliveryId);
    if (!parsed.success) return { error: await refusal("notFound") };
    const result = await hooks.redeliverOutbound(user.id, parsed.data);
    if ("error" in result) return { error: await refusal(result.error) };
    return result;
}

export async function listOutboundDeliveriesAction(
    webhookId: unknown,
    cursor: unknown
): Promise<{ page?: hooks.DeliveryPage; error?: string }> {
    const user = await requireUser();
    const parsedId = idSchema.safeParse(webhookId);
    const parsedCursor = idSchema.nullable().safeParse(cursor ?? null);
    if (!parsedId.success || !parsedCursor.success) return { error: await refusal("notFound") };
    return { page: await hooks.listOutboundDeliveries(user.id, parsedId.data, parsedCursor.data) };
}

const inboundErrors = { rateLimited: "rateLimited", limit: "limit", forbidden: "forbidden" } as const;

export async function createInboundHookAction(
    input: unknown
): Promise<{ hook?: inbound.InboundHookView; secret?: string; error?: string }> {
    const user = await requireUser();
    const t = await getTranslations("accountNotifications");
    const parsed = inbound.inboundHookInputSchema.safeParse(input);
    if (!parsed.success) return { error: t("webhooks.inbound.errors.invalid") };
    const result = await inbound.createInboundHook(user.id, parsed.data);
    if ("error" in result) {
        const code = inboundErrors[result.error];
        return { error: t(`webhooks.inbound.errors.${code}`, { max: inbound.MAX_INBOUND_HOOKS }) };
    }
    revalidatePath("/account/webhooks");
    return result;
}

export async function setInboundHookEnabledAction(id: unknown, enabled: unknown): Promise<{ error?: string }> {
    const user = await requireUser();
    const parsedId = idSchema.safeParse(id);
    const parsedEnabled = z.boolean().safeParse(enabled);
    if (!parsedId.success || !parsedEnabled.success) return { error: await refusal("notSaved") };
    if (!(await inbound.setInboundHookEnabled(user.id, parsedId.data, parsedEnabled.data))) {
        return { error: await refusal("notFound") };
    }
    revalidatePath("/account/webhooks");
    return {};
}

export async function deleteInboundHookAction(id: unknown): Promise<{ error?: string }> {
    const user = await requireUser();
    const parsed = idSchema.safeParse(id);
    if (!parsed.success || !(await inbound.deleteInboundHook(user.id, parsed.data))) {
        return { error: await refusal("notFound") };
    }
    revalidatePath("/account/webhooks");
    return {};
}
