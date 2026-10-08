"use server";

/**
 * Saving the keyboard shortcuts an account moved.
 *
 * Sent whole - every action this account changed - rather than one change, so
 * a repeated or reordered save lands on the same answer. Checked against the
 * same rules the settings screen checks as somebody presses keys: an action
 * that exists and may be moved, keys the browser lets a page have, and no key
 * doing two things at once.
 */

import * as core from "@polaris/core";
import { requireUser } from "@/lib/session";
import { getTranslations } from "@/lib/i18n/request";
import { saveShortcutOverrides } from "@/lib/shortcuts-service";

export async function saveShortcutsAction(
    input: unknown
): Promise<{ overrides?: core.ShortcutOverrides; error?: string }> {
    const user = await requireUser();
    const t = await getTranslations("shortcuts");
    const parsed = core.shortcutOverridesSchema.safeParse(input);
    // The schema's words are English and name internals; the reader gets the
    // sentence in their language, and the screen puts their keys back.
    if (!parsed.success) return { error: t("errors.notSaved") };
    try {
        return { overrides: await saveShortcutOverrides(user.id, parsed.data) };
    } catch (caught) {
        console.error("[shortcuts] save failed", caught);
        return { error: t("errors.notSaved") };
    }
}
