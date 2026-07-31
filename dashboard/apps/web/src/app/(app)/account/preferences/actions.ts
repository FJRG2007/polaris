"use server";

/**
 * The signed-in user's own display choices. Validated against the same schema the
 * formatters read, so a hand-crafted payload cannot store a unit nothing knows
 * how to render.
 */

import { revalidatePath } from "next/cache";
import { userDisplayPreferencesSchema } from "@polaris/core";
import { saveUserDisplayPreferences } from "@/lib/display-prefs-service";
import { requireUser } from "@/lib/session";

export async function saveDisplayPreferencesAction(input: unknown): Promise<{ error?: string }> {
    const user = await requireUser();
    const parsed = userDisplayPreferencesSchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Unsupported choice." };
    await saveUserDisplayPreferences(user.id, parsed.data);
    // Formatting is resolved in the app layout, so every screen re-renders.
    revalidatePath("/", "layout");
    return {};
}
