"use server";

/**
 * The soundboard: what a call's picker offers, playing a sound, starring one,
 * and a space's own sounds and switches.
 *
 * Two kinds of caller, kept apart the way the call screen's actions are: the
 * picker and a play are proved by a seat in the call (`resolveSeat`), and the
 * settings page by the session and the space. Every answer is `{ error }` in the
 * reader's language rather than a throw, because every caller has somewhere to
 * put the sentence.
 */

import * as rules from "@/lib/chat/soundboard";
import { requirePermission } from "@/lib/session";
import { guardChat } from "@/lib/chat/chat-guard";
import { getTranslations } from "@/lib/i18n/request";
import { resolveSeat } from "@/lib/chat/meeting-seat";
import * as soundboard from "@/lib/chat/soundboard-service";

async function actor(): Promise<{ id: string }> {
    const user = await requirePermission("chat.use");
    return { id: user.id };
}

/** What the picker in this call offers this seat. */
export async function callSoundboardAction(
    meetingId: unknown
): Promise<{ board?: soundboard.CallSoundboard; error?: string }> {
    const t = await getTranslations("chat");
    const id = rules.soundPlaySchema.shape.meetingId.safeParse(meetingId);
    if (!id.success) return { error: t("errors.notInCall") };
    const seat = await resolveSeat(id.data);
    if (!seat) return { error: t("errors.notInCall") };
    const result = await guardChat(() => soundboard.callSoundboard(seat));
    return result.error ? { error: result.error } : { board: result.value };
}

/** Play one sound into the call. */
export async function playSoundAction(input: unknown): Promise<{ error?: string }> {
    const t = await getTranslations("chat");
    const parsed = rules.soundPlaySchema.safeParse(input);
    if (!parsed.success) return { error: t("errors.soundGone") };
    const seat = await resolveSeat(parsed.data.meetingId);
    if (!seat) return { error: t("errors.notInCall") };
    const result = await guardChat(() => soundboard.playSound(seat, parsed.data.sound));
    return result.error ? { error: result.error } : {};
}

export async function favoriteSoundAction(input: unknown): Promise<{ error?: string }> {
    const me = await actor();
    const parsed = rules.soundFavoriteSchema.safeParse(input);
    if (!parsed.success) return { error: (await getTranslations("chat"))("errors.soundGone") };
    const result = await guardChat(() =>
        soundboard.setFavorite(me, parsed.data.sound, parsed.data.favorite)
    );
    return result.error ? { error: result.error } : {};
}

/** The space's soundboard page. */
export async function spaceSoundboardAction(
    spaceId: unknown
): Promise<{ board?: soundboard.SpaceSoundboard; error?: string }> {
    const me = await actor();
    const id = rules.spaceSoundboardSchema.shape.spaceId.safeParse(spaceId);
    if (!id.success) return { error: (await getTranslations("chat"))("errors.notInSpace") };
    const result = await guardChat(() => soundboard.spaceSoundboard(me, id.data));
    return result.error ? { error: result.error } : { board: result.value };
}

export async function setSpaceSoundboardAction(input: unknown): Promise<{ error?: string }> {
    const me = await actor();
    const parsed = rules.spaceSoundboardSchema.safeParse(input);
    if (!parsed.success) return { error: (await getTranslations("chat"))("errors.notDone") };
    const result = await guardChat(() => soundboard.setSpaceSoundboard(me, parsed.data));
    return result.error ? { error: result.error } : {};
}

export async function setChannelSoundboardAction(input: unknown): Promise<{ error?: string }> {
    const me = await actor();
    const parsed = rules.channelSoundboardSchema.safeParse(input);
    if (!parsed.success) return { error: (await getTranslations("chat"))("errors.notDone") };
    const result = await guardChat(() => soundboard.setChannelSoundboard(me, parsed.data));
    return result.error ? { error: result.error } : {};
}

export async function setSoundDenialAction(input: unknown): Promise<{ error?: string }> {
    const me = await actor();
    const parsed = rules.soundDenialChangeSchema.safeParse(input);
    if (!parsed.success) return { error: (await getTranslations("chat"))("errors.notDone") };
    const result = await guardChat(() => soundboard.setSoundDenial(me, parsed.data));
    return result.error ? { error: result.error } : {};
}

/** Why a name was refused, in the reader's language. */
async function nameRefusal(problem: string | undefined): Promise<string> {
    const t = await getTranslations("chat");
    return problem === "long" ? t("errors.soundNameLong") : t("errors.soundNameShort");
}

/**
 * Add one, from a form carrying the space, the name, the emoji, the volume and
 * the file the uploader's browser made.
 */
export async function uploadSoundAction(
    form: FormData
): Promise<{ sound?: soundboard.SoundView; error?: string }> {
    const me = await actor();
    const t = await getTranslations("chat");
    const fields = rules.soundUploadFieldsSchema.safeParse({
        spaceId: form.get("spaceId"),
        name: form.get("name"),
        emoji: form.get("emoji") ?? "",
        volume: Number(form.get("volume"))
    });
    if (!fields.success) {
        const issue = fields.error.issues[0];
        if (issue?.path[0] === "name") return { error: await nameRefusal(issue.message) };
        if (issue?.path[0] === "emoji") return { error: t("errors.soundEmoji") };
        if (issue?.path[0] === "volume") return { error: t("errors.notDone") };
        return { error: t("errors.notInSpace") };
    }
    const file = form.get("file");
    if (!(file instanceof Blob)) return { error: t("errors.soundFileEmpty") };
    // The ceiling before the bytes are read, so a hand-made request cannot make
    // the server hold more than one sound's worth.
    if (file.size > rules.SOUND_MAX_BYTES) return { error: t("errors.soundFileSize") };
    const bytes = new Uint8Array(await file.arrayBuffer());
    const result = await guardChat(() => soundboard.uploadSound(me, { ...fields.data, bytes }));
    return result.error ? { error: result.error } : { sound: result.value };
}

export async function updateSoundAction(
    input: unknown
): Promise<{ sound?: soundboard.SoundView; error?: string }> {
    const me = await actor();
    const t = await getTranslations("chat");
    const parsed = rules.soundUpdateSchema.safeParse(input);
    if (!parsed.success) {
        const issue = parsed.error.issues[0];
        if (issue?.path[0] === "name") return { error: await nameRefusal(issue.message) };
        if (issue?.path[0] === "emoji") return { error: t("errors.soundEmoji") };
        return { error: t("errors.soundGone") };
    }
    const result = await guardChat(() => soundboard.updateSound(me, parsed.data));
    return result.error ? { error: result.error } : { sound: result.value };
}

export async function deleteSoundAction(input: unknown): Promise<{ error?: string }> {
    const me = await actor();
    const parsed = rules.soundDeleteSchema.safeParse(input);
    if (!parsed.success) return { error: (await getTranslations("chat"))("errors.soundGone") };
    const result = await guardChat(() => soundboard.deleteSound(me, parsed.data.soundId));
    return result.error ? { error: result.error } : {};
}
