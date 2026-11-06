"use server";

/**
 * Chat lock and hidden chats - see `lib/chat/chat-lock`.
 *
 * The same two gates as every other Chat action: `chat.use`, then the service's
 * own check that the conversation is the caller's. Input arrives from a browser,
 * so every one is parsed before it reaches the service.
 */

import { z } from "zod";
import { revalidatePath } from "next/cache";
import * as lock from "@/lib/chat/chat-lock";
import { guardChat } from "@/lib/chat/chat-guard";
import { requirePermission } from "@/lib/session";
import { stepUpGranted } from "@/lib/step-up-grant";
import { getTranslations } from "@/lib/i18n/request";

const CHAT_PATH = "/chat";

async function actor(): Promise<{ id: string; name: string; sessionId: string }> {
    const user = await requirePermission("chat.use");
    return { id: user.id, name: user.name, sessionId: user.sessionId };
}

/** A refusal for input that did not parse, in the reader's language: a code
 *  that cannot be one is a wrong code, anything else a request that did not go. */
async function invalid(
    key: "errors.lockWrongCode" | "errors.lockResetUnconfirmed" | "lock.failed" = "lock.failed"
): Promise<{ error: string }> {
    const t = await getTranslations("chat");
    return { error: t(key) };
}

const hideLockedSchema = z.object({ hide: z.boolean() });
const lockChannelSchema = lock.channelFlagSchema.extend({ code: lock.lockCodeSchema.optional() });
const openLockedSchema = z.object({ code: lock.lockCodeSchema });

export async function lockStateAction(): Promise<lock.ChatLockState> {
    const me = await actor();
    return lock.lockState(me.id);
}

/** Set the code, or change it with the current one. */
export async function setLockCodeAction(input: unknown): Promise<{ error?: string }> {
    const me = await actor();
    const parsed = lock.setLockCodeSchema.safeParse(input);
    if (!parsed.success) return invalid("errors.lockWrongCode");
    const result = await guardChat(() =>
        lock.setLockCode(me, parsed.data.code, parsed.data.current)
    );
    return result.error ? { error: result.error } : {};
}

/** Forgot the code: once this session has just confirmed it is the account's
 *  owner, the code goes and every chat it locked opens. */
export async function resetLockCodeAction(): Promise<{ error?: string }> {
    const me = await actor();
    if (!(await stepUpGranted(me.id, me.sessionId, "chat-lock-reset")))
        return invalid("errors.lockResetUnconfirmed");
    const result = await guardChat(() => lock.resetLockCode(me));
    if (!result.error) revalidatePath(CHAT_PATH);
    return result.error ? { error: result.error } : {};
}

export async function setHideLockedAction(input: unknown): Promise<{ error?: string }> {
    const me = await actor();
    const parsed = hideLockedSchema.safeParse(input);
    if (!parsed.success) return invalid();
    const result = await guardChat(() => lock.setHideLocked(me, parsed.data.hide));
    if (!result.error) revalidatePath(CHAT_PATH);
    return result.error ? { error: result.error } : {};
}

/** Lock a conversation, or take the lock off it with the code. */
export async function setChannelLockedAction(input: unknown): Promise<{ error?: string }> {
    const me = await actor();
    const parsed = lockChannelSchema.safeParse(input);
    if (!parsed.success) return invalid();
    const { channelId, on, code } = parsed.data;
    const result = await guardChat(() => lock.setChannelLocked(me, channelId, on, code));
    if (!result.error) revalidatePath(CHAT_PATH);
    return result.error ? { error: result.error } : {};
}

/** Hide a conversation from the list, or bring it back. No code. */
export async function setChannelHiddenAction(input: unknown): Promise<{ error?: string }> {
    const me = await actor();
    const parsed = lock.channelFlagSchema.safeParse(input);
    if (!parsed.success) return invalid();
    const { channelId, on } = parsed.data;
    const result = await guardChat(() => lock.setChannelHidden(me, channelId, on));
    if (!result.error) revalidatePath(CHAT_PATH);
    return result.error ? { error: result.error } : {};
}

/** Open one locked conversation: its unlock proof for this tab. */
export async function unlockChannelAction(
    input: unknown
): Promise<{ proof?: string; error?: string }> {
    const me = await actor();
    const parsed = lock.unlockSchema.safeParse(input);
    if (!parsed.success) return invalid("errors.lockWrongCode");
    const result = await guardChat(() =>
        lock.unlockChannel(me, parsed.data.channelId, parsed.data.code)
    );
    return result.error ? { error: result.error } : { proof: result.value };
}

/** Open "Locked chats": a proof for every locked conversation. */
export async function openLockedChatsAction(
    input: unknown
): Promise<{ proofs?: Record<string, string>; error?: string }> {
    const me = await actor();
    const parsed = openLockedSchema.safeParse(input);
    if (!parsed.success) return invalid("errors.lockWrongCode");
    const result = await guardChat(() => lock.unlockAll(me, parsed.data.code));
    return result.error ? { error: result.error } : { proofs: result.value };
}
