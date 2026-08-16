"use server";

/**
 * The signed-in user's own display choices. Validated against the same schema the
 * formatters read, so a hand-crafted payload cannot store a unit nothing knows
 * how to render.
 */

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import { setPresenceChoice } from "@/lib/presence-service";
import { userDisplayPreferencesSchema } from "@polaris/core";
import { saveUserDisplayPreferences } from "@/lib/display-prefs-service";
import { isPresenceDuration, PRESENCE_CHOICES, type PresenceChoice } from "@polaris/core";

export async function saveDisplayPreferencesAction(input: unknown): Promise<{ error?: string }> {
    const user = await requireUser();
    const parsed = userDisplayPreferencesSchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Unsupported choice." };
    await saveUserDisplayPreferences(user.id, parsed.data);
    // Formatting is resolved in the app layout, so every screen re-renders.
    revalidatePath("/", "layout");
    return {};
}

/**
 * What everybody else sees you as, and until when.
 *
 * Four answers and no more: here, do not disturb, away, and not here at all.
 * `auto` is the one almost everybody keeps - it says "work it out from whether I
 * am at the screen" - and the other three are somebody deciding, which is why
 * they outrank what the sessions say.
 *
 * The window is optional and only one of the offered lengths: it arrives from a
 * browser, so a request naming five minutes or five years is refused rather than
 * stored. Absent means "until I change it", which is what a status was before
 * there was a window at all.
 */
export async function setPresenceAction(
    choice: unknown,
    minutes?: unknown
): Promise<{ error?: string }> {
    const user = await requireUser();
    const wanted = (PRESENCE_CHOICES as readonly string[]).includes(String(choice))
        ? (String(choice) as PresenceChoice)
        : null;
    if (!wanted) return { error: "That is not a status" };
    if (minutes !== undefined && minutes !== null && !isPresenceDuration(minutes)) {
        return { error: "That is not one of the lengths offered" };
    }

    await setPresenceChoice(user.id, wanted, isPresenceDuration(minutes) ? minutes : null);
    return {};
}
