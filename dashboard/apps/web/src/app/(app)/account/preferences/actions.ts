"use server";

/**
 * The signed-in user's own display choices. Validated against the same schema the
 * formatters read, so a hand-crafted payload cannot store a unit nothing knows
 * how to render.
 */

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import * as core from "@polaris/core";
import { setPresenceChoice, setStatus } from "@/lib/presence-service";
import { userDisplayPreferencesSchema } from "@polaris/core";
import { recordDeviceTimeZone, saveUserDisplayPreferences } from "@/lib/display-prefs-service";
import { PRESENCE_CHOICES, type PresenceChoice } from "@polaris/core";

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
 * The zone this browser says it is in.
 *
 * Not a preference and not a question anybody is asked: "automatic" is what
 * almost every account keeps, and it means the device's clock - which the
 * dashboard knows and the server does not. Written down here so that the half of
 * this account that is worked out on the server - whether a status schedule is
 * open right now, a date rendered into a page - is read on the same clock as the
 * half that is worked out in front of them.
 *
 * Sent only when it disagrees with what is already stored, so this is one write
 * the first time an account signs in and nothing at all afterwards.
 */
export async function reportTimeZoneAction(zone: unknown): Promise<{ changed: boolean }> {
    const user = await requireUser();
    const parsed = core.timeZoneField.safeParse(zone);
    if (!parsed.success) return { changed: false };
    const changed = await recordDeviceTimeZone(user.id, parsed.data);
    // Everything the zone decides is resolved in the layout, so the screen that
    // is up - a schedule saying whether it is running - re-reads with it.
    if (changed) revalidatePath("/", "layout");
    return { changed };
}

/**
 * What everybody else sees you as, and until when.
 *
 * Four answers and no more: here, do not disturb, away, and not here at all.
 * `auto` is the one almost everybody keeps - it says "work it out from whether I
 * am at the screen" - and the other three are somebody deciding, which is why
 * they outrank what the sessions say.
 *
 * The window is optional and either one of the offered lengths or a moment
 * inside the next year: it arrives from a browser, so a request naming five
 * minutes or five centuries is refused rather than stored. Neither means "until
 * I change it", which is what a status was before there was a window at all.
 */
export async function setPresenceAction(
    choice: unknown,
    window?: unknown
): Promise<{ error?: string }> {
    const user = await requireUser();
    const wanted = (PRESENCE_CHOICES as readonly string[]).includes(String(choice))
        ? (String(choice) as PresenceChoice)
        : null;
    if (!wanted) return { error: "That is not a status" };
    const parsed = core.presenceWindowSchema.safeParse(window ?? {});
    if (!parsed.success) {
        return { error: parsed.error.issues[0]?.message ?? "That is not a window" };
    }

    await setPresenceChoice(user.id, wanted, parsed.data);
    return {};
}

/**
 * Say what you are up to, and when it should clear itself.
 *
 * An empty line is how one is taken off, so it is not an error - the dialog's
 * Clear button and a field somebody emptied are the same request. The window is
 * only ever one of the offered ones: it arrives from a browser, and a request
 * naming five years is refused rather than stored.
 */
export async function setStatusAction(input: unknown): Promise<{ error?: string }> {
    const user = await requireUser();
    const parsed = core.userStatusSchema.safeParse(input);
    if (!parsed.success) {
        return { error: parsed.error.issues[0]?.message ?? "That status could not be saved" };
    }

    await setStatus(user.id, parsed.data.text, parsed.data);
    return {};
}
