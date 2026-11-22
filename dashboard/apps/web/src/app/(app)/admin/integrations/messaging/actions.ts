"use server";

/**
 * Integrations > Messaging: connecting channels and choosing which one carries
 * verification codes. Administrators only - channels are a deployment
 * integration, and a code sender reaches every account.
 */

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/session";
import { PLATFORMS } from "@polaris/messaging";
import { recordAudit } from "@/lib/audit-service";
import { getTranslations } from "@/lib/i18n/request";
import { setCodeSender } from "@/lib/messaging/code-senders";
import {
    connectMessagingChannel,
    deleteMessagingChannel,
    messagingChannelState,
    reconnectMessagingChannel,
    telegramBotToken,
    updateMessagingChannel,
    type MessagingChannelLiveState,
    type MessagingChannelView
} from "@/lib/messaging/channel-admin";
import {
    applyCustomProfile,
    applyPolarisBranding,
    BOT_DESCRIPTION_MAX,
    BOT_NAME_MAX,
    BOT_SHORT_DESCRIPTION_MAX,
    readBotProfile,
    TelegramCallError,
    type BotProfile,
    type BotProfileField,
    type FieldResult,
    type TelegramFailure
} from "@/lib/messaging/telegram-bot-profile";

const PATH = "/admin/integrations/messaging";

const PROVIDERS = [
    "whatsapp-cloud",
    "whatsapp-twilio",
    "whatsapp-360dialog",
    "whatsapp-web",
    "discord-webhook",
    "slack-webhook"
] as const;

const settingsSchema = z
    .object({
        phoneNumberId: z.string().trim().max(64).regex(/^\d*$/).optional(),
        accountSid: z.string().trim().max(64).regex(/^(AC[0-9a-fA-F]{32})?$/).optional(),
        from: z.string().trim().max(32).regex(/^[+\d\s()-]*$/).optional(),
        contentSid: z.string().trim().max(64).regex(/^(HX[0-9a-fA-F]{32})?$/).optional(),
        codeTemplate: z.string().trim().max(512).regex(/^[a-z0-9_]*$/).optional(),
        codeTemplateLanguage: z.string().trim().max(16).regex(/^([a-z]{2,3}(_[A-Z]{2})?)?$/).optional()
    })
    .strict();

const connectSchema = z.object({
    platform: z.enum(PLATFORMS),
    provider: z.enum(PROVIDERS).optional(),
    name: z.string().trim().min(1).max(64),
    token: z.string().trim().min(1).max(8192).optional(),
    settings: settingsSchema.optional()
});

const updateSchema = z.object({
    channelId: z.string().uuid(),
    name: z.string().trim().min(1).max(64).optional(),
    token: z.string().trim().min(1).max(8192).optional(),
    settings: settingsSchema.optional()
});

const idSchema = z.string().uuid();

/** Drops empty values, so a cleared optional field reads as "not set". */
function compact(settings: z.infer<typeof settingsSchema> | undefined): Record<string, string> | undefined {
    if (!settings) return undefined;
    return Object.fromEntries(Object.entries(settings).filter(([, value]) => value !== undefined)) as Record<
        string,
        string
    >;
}

async function checkForm(): Promise<string> {
    return (await getTranslations("admin"))("messaging.errors.checkForm");
}

function reason(caught: unknown, fallback: string): string {
    return caught instanceof Error ? caught.message : fallback;
}

export async function connectMessagingChannelAction(
    input: unknown
): Promise<{ channel?: MessagingChannelView; error?: string }> {
    const admin = await requireAdmin();
    const parsed = connectSchema.safeParse(input);
    if (!parsed.success) return { error: await checkForm() };
    const { settings, ...rest } = parsed.data;
    if (rest.provider !== "whatsapp-web" && !rest.token) return { error: await checkForm() };
    try {
        const channel = await connectMessagingChannel(admin.id, { ...rest, config: compact(settings) });
        await recordAudit({
            actorId: admin.id,
            action: "messaging.channel.connected",
            targetType: "channel",
            targetId: channel.id,
            metadata: { platform: channel.platform, provider: channel.provider }
        });
        revalidatePath(PATH);
        return { channel };
    } catch (caught) {
        return { error: reason(caught, (await getTranslations("admin"))("messaging.errors.connectFailed")) };
    }
}

export async function updateMessagingChannelAction(input: unknown): Promise<{ status?: string; error?: string }> {
    const admin = await requireAdmin();
    const parsed = updateSchema.safeParse(input);
    if (!parsed.success) return { error: await checkForm() };
    const { channelId, settings, ...patch } = parsed.data;
    try {
        const result = await updateMessagingChannel(channelId, { ...patch, config: compact(settings) });
        await recordAudit({ actorId: admin.id, action: "messaging.channel.updated", targetType: "channel", targetId: channelId });
        revalidatePath(PATH);
        return result;
    } catch (caught) {
        return { error: reason(caught, (await getTranslations("admin"))("messaging.errors.connectFailed")) };
    }
}

export async function reconnectMessagingChannelAction(channelId: unknown): Promise<{ status?: string; error?: string }> {
    await requireAdmin();
    const parsed = idSchema.safeParse(channelId);
    if (!parsed.success) return { error: await checkForm() };
    try {
        const result = await reconnectMessagingChannel(parsed.data);
        revalidatePath(PATH);
        return result;
    } catch (caught) {
        return { error: reason(caught, (await getTranslations("admin"))("messaging.errors.connectFailed")) };
    }
}

export async function deleteMessagingChannelAction(channelId: unknown): Promise<{ error?: string }> {
    const admin = await requireAdmin();
    const parsed = idSchema.safeParse(channelId);
    if (!parsed.success) return { error: await checkForm() };
    try {
        await deleteMessagingChannel(parsed.data);
        await recordAudit({ actorId: admin.id, action: "messaging.channel.removed", targetType: "channel", targetId: parsed.data });
        revalidatePath(PATH);
        return {};
    } catch (caught) {
        return { error: reason(caught, (await getTranslations("admin"))("messaging.errors.removeFailed")) };
    }
}

/** Polled while a WhatsApp Web channel waits for its QR to be scanned. */
export async function messagingChannelStateAction(
    channelId: unknown
): Promise<MessagingChannelLiveState & { error?: string }> {
    await requireAdmin();
    const parsed = idSchema.safeParse(channelId);
    if (!parsed.success) return { status: "error" };
    try {
        return await messagingChannelState(parsed.data);
    } catch (caught) {
        return { status: "error", error: reason(caught, "") };
    }
}

const codeSenderSchema = z.object({
    platform: z.enum(["whatsapp", "telegram"]),
    channelId: z.string().uuid().nullable()
});

export async function setCodeSenderAction(input: unknown): Promise<{ error?: string }> {
    const admin = await requireAdmin();
    const parsed = codeSenderSchema.safeParse(input);
    if (!parsed.success) return { error: await checkForm() };
    const result = await setCodeSender(parsed.data.platform, parsed.data.channelId);
    if (result.error) return { error: (await getTranslations("admin"))("messaging.errors.unknownChannel") };
    await recordAudit({
        actorId: admin.id,
        action: parsed.data.channelId ? "messaging.code-sender.set" : "messaging.code-sender.cleared",
        targetType: "channel",
        targetId: parsed.data.channelId ?? undefined,
        metadata: { platform: parsed.data.platform }
    });
    revalidatePath(PATH);
    return {};
}

export interface BotProfileFieldOutcome {
    field: BotProfileField;
    ok: boolean;
    error?: string;
}

const botProfileSchema = z.discriminatedUnion("mode", [
    z.object({ channelId: z.string().uuid(), mode: z.literal("polaris") }),
    z.object({
        channelId: z.string().uuid(),
        mode: z.literal("custom"),
        name: z.string().trim().min(1).max(BOT_NAME_MAX).optional(),
        description: z.string().trim().max(BOT_DESCRIPTION_MAX).optional(),
        shortDescription: z.string().trim().max(BOT_SHORT_DESCRIPTION_MAX).optional()
    })
]);

type AdminWords = Awaited<ReturnType<typeof getTranslations<"admin">>>;

/** Telegram's refusal in words the admin can act on. */
function failureWords(t: AdminWords, failure: TelegramFailure): string {
    switch (failure.kind) {
        case "rateLimited":
            if (failure.retryAfter < 60) return t("messaging.botProfile.errors.waitSeconds", { count: failure.retryAfter });
            if (failure.retryAfter < 3600) {
                return t("messaging.botProfile.errors.waitMinutes", { count: Math.ceil(failure.retryAfter / 60) });
            }
            return t("messaging.botProfile.errors.waitHours", { count: Math.ceil(failure.retryAfter / 3600) });
        case "tokenRefused":
            return t("messaging.botProfile.errors.tokenRefused");
        case "unreachable":
            return t("messaging.botProfile.errors.unreachable");
        default:
            return failure.description
                ? t("messaging.botProfile.errors.refused", { reason: failure.description })
                : t("messaging.botProfile.errors.unreachable");
    }
}

/** The Telegram bot's own name, description and picture state, read live. */
export async function telegramBotProfileAction(channelId: unknown): Promise<{ profile?: BotProfile; error?: string }> {
    await requireAdmin();
    const parsed = idSchema.safeParse(channelId);
    if (!parsed.success) return { error: await checkForm() };
    const t = await getTranslations("admin");
    try {
        const token = await telegramBotToken(parsed.data);
        if (!token) return { error: t("messaging.botProfile.errors.noToken") };
        return { profile: await readBotProfile(token) };
    } catch (caught) {
        if (caught instanceof TelegramCallError) return { error: failureWords(t, caught.failure) };
        return { error: t("messaging.botProfile.errors.unreachable") };
    }
}

/** Brand the bot as Polaris, or write custom values; each field answers on its own. */
export async function applyTelegramBotProfileAction(
    input: unknown
): Promise<{ results?: BotProfileFieldOutcome[]; profile?: BotProfile; error?: string }> {
    const admin = await requireAdmin();
    const parsed = botProfileSchema.safeParse(input);
    if (!parsed.success) return { error: await checkForm() };
    const t = await getTranslations("admin");
    const { channelId, mode } = parsed.data;
    let token: string | null;
    try {
        token = await telegramBotToken(channelId);
    } catch {
        return { error: t("messaging.errors.unknownChannel") };
    }
    if (!token) return { error: t("messaging.botProfile.errors.noToken") };
    let outcome: FieldResult[];
    if (parsed.data.mode === "polaris") {
        outcome = await applyPolarisBranding(token);
    } else {
        const { name, description, shortDescription } = parsed.data;
        const values = { name, description, shortDescription };
        if (Object.values(values).every((value) => value === undefined)) return { error: await checkForm() };
        outcome = await applyCustomProfile(token, values);
    }
    await recordAudit({
        actorId: admin.id,
        action: "messaging.bot-profile.updated",
        targetType: "channel",
        targetId: channelId,
        metadata: {
            mode,
            updated: outcome.filter((result) => result.ok).map((result) => result.field),
            failed: outcome.filter((result) => !result.ok).map((result) => result.field)
        }
    });
    const results = outcome.map((result) =>
        result.ok ? { field: result.field, ok: true } : { field: result.field, ok: false, error: failureWords(t, result.failure) }
    );
    const profile = await readBotProfile(token).catch(() => undefined);
    return { results, ...(profile ? { profile } : {}) };
}
