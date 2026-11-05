"use server";

/**
 * Badges on the account (/account/badges): read what this person has, and save
 * how they arranged it. Both act on the signed-in account only.
 */

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import { getTranslations } from "@/lib/i18n/request";
import { listsFor, namePeople, type PrivacyListView } from "@/lib/privacy-service";
import {
    BadgeError,
    badgesFor,
    saveArrangement,
    type BadgesForViewer
} from "@/lib/badges/badge-service";

export interface MyBadges extends BadgesForViewer {
    lists: PrivacyListView[];
    people: { id: string; name: string }[];
}

export async function loadMyBadgesAction(): Promise<MyBadges> {
    const user = await requireUser();
    const [badges, lists] = await Promise.all([
        badgesFor(user.id, { id: user.id, isAdmin: user.isAdmin }),
        listsFor(user.id)
    ]);
    const people = await namePeople((badges.arrangement ?? []).flatMap((row) => row.people));
    return { ...badges, lists, people };
}

export async function saveBadgeArrangementAction(input: unknown): Promise<{ error?: string }> {
    const user = await requireUser();
    try {
        await saveArrangement(user.id, input);
    } catch (caught) {
        if (caught instanceof BadgeError)
            return { error: (await getTranslations("badges"))("settings.failed") };
        throw caught;
    }
    revalidatePath("/u", "layout");
    return {};
}
