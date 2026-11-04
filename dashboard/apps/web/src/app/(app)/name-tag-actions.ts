"use server";

/**
 * Name tags from any screen: the card a tag opens, and the wearer's own choice.
 * The card is decided again here rather than trusted from the screen that drew
 * the tag, so a tag that stopped drawing opens nothing.
 */

import { revalidatePath } from "next/cache";
import { backgroundUser, requireUser } from "@/lib/session";
import {
    NameTagError,
    myNameTags,
    nameTagCard,
    setNameTagChoice,
    type MyNameTags,
    type NameTagCard
} from "@/lib/name-tags/name-tag-service";

export async function nameTagCardAction(subjectId: unknown): Promise<NameTagCard | null> {
    if (typeof subjectId !== "string" || !/^[0-9a-f-]{36}$/i.test(subjectId)) return null;
    const viewer = await backgroundUser();
    return nameTagCard(viewer ? { id: viewer.id, isAdmin: viewer.isAdmin } : null, subjectId);
}

export async function loadMyNameTagsAction(): Promise<MyNameTags> {
    const user = await requireUser();
    return myNameTags(user.id);
}

export async function chooseNameTagAction(input: unknown): Promise<{ error?: string }> {
    const user = await requireUser();
    try {
        await setNameTagChoice(user.id, input);
    } catch (caught) {
        if (caught instanceof NameTagError) return { error: caught.code };
        throw caught;
    }
    revalidatePath("/u", "layout");
    return {};
}
