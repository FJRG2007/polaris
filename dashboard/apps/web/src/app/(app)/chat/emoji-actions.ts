"use server";

/**
 * A space's own emoji: the list, and adding, renaming and removing one.
 *
 * The same two gates as every other chat action - `chat.use` for the app, the
 * service for the space - and the same answer shape: `{ error }` in the reader's
 * language rather than a throw, because every caller is a form or a row with
 * somewhere to put the sentence.
 */

import * as core from "@polaris/core";
import * as emoji from "@/lib/chat/custom-emoji";
import { requirePermission } from "@/lib/session";
import { guardChat } from "@/lib/chat/chat-guard";
import { getTranslations } from "@/lib/i18n/request";
import type { SpaceEmojiList, SpaceEmojiView } from "@/lib/chat/custom-emoji";

async function actor(): Promise<{ id: string }> {
    const user = await requirePermission("chat.use");
    return { id: user.id };
}

/** Why a name was refused, in the reader's language. */
async function nameRefusal(problem: string | undefined): Promise<string> {
    const t = await getTranslations("chat");
    if (problem === "short") return t("errors.emojiNameShort");
    if (problem === "long") return t("errors.emojiNameLong");
    if (problem === "edges") return t("errors.emojiNameEdges");
    return t("errors.emojiNameCharacters");
}

/** Everything a space has, and whether the reader may change it. */
export async function spaceEmojiAction(
    spaceId: unknown
): Promise<{ list?: SpaceEmojiList; error?: string }> {
    const me = await actor();
    const id = core.customEmojiUploadSchema.shape.spaceId.safeParse(spaceId);
    if (!id.success) return { error: (await getTranslations("chat"))("errors.notInSpace") };
    const result = await guardChat(() => emoji.listSpaceEmoji(me, id.data));
    return result.error ? { error: result.error } : { list: result.value };
}

/**
 * Add one, from a form carrying the space, the name and the file.
 *
 * One file a call, so a screen uploading several says which of them failed and
 * why, beside each one, rather than one error for the batch.
 */
export async function uploadSpaceEmojiAction(
    form: FormData
): Promise<{ emoji?: SpaceEmojiView; error?: string }> {
    const me = await actor();
    const t = await getTranslations("chat");
    const fields = core.customEmojiUploadSchema.safeParse({
        spaceId: form.get("spaceId"),
        name: form.get("name")
    });
    if (!fields.success) {
        const issue = fields.error.issues[0];
        if (issue?.path[0] === "name") return { error: await nameRefusal(issue.message) };
        return { error: t("errors.notInSpace") };
    }
    const file = form.get("file");
    if (!(file instanceof Blob)) return { error: t("errors.emojiFileEmpty") };
    // The ceiling before the bytes are read, so a hand-made request cannot make
    // the server hold more than one emoji's worth.
    if (file.size > core.CUSTOM_EMOJI_MAX_BYTES) return { error: t("errors.emojiFileSize") };
    const bytes = new Uint8Array(await file.arrayBuffer());
    const result = await guardChat(() =>
        emoji.uploadSpaceEmoji(me, fields.data.spaceId, { name: fields.data.name, bytes })
    );
    return result.error ? { error: result.error } : { emoji: result.value };
}

export async function renameSpaceEmojiAction(
    input: unknown
): Promise<{ emoji?: SpaceEmojiView; error?: string }> {
    const me = await actor();
    const parsed = core.customEmojiRenameSchema.safeParse(input);
    if (!parsed.success) {
        const issue = parsed.error.issues[0];
        if (issue?.path[0] === "name") return { error: await nameRefusal(issue.message) };
        return { error: (await getTranslations("chat"))("errors.emojiGone") };
    }
    const result = await guardChat(() => emoji.renameSpaceEmoji(me, parsed.data));
    return result.error ? { error: result.error } : { emoji: result.value };
}

export async function deleteSpaceEmojiAction(input: unknown): Promise<{ error?: string }> {
    const me = await actor();
    const parsed = core.customEmojiDeleteSchema.safeParse(input);
    if (!parsed.success) return { error: (await getTranslations("chat"))("errors.emojiGone") };
    const result = await guardChat(() => emoji.deleteSpaceEmoji(me, parsed.data.emojiId));
    return result.error ? { error: result.error } : {};
}
