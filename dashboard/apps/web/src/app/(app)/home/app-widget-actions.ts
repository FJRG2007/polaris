"use server";

/**
 * The Overview's cards from installed apps: what one can watch, what every card
 * on the screen shows, and pressing one of their controls.
 *
 * Every call is the reader's: the cards read are the ones in their own stored
 * layout, a press names a card by id and acts on what that stored card watches,
 * and what each app shows or lets them press is decided by the app's own checks
 * (see `lib/overview/app-widgets`).
 */

import { z } from "zod";
import { requireUser } from "@/lib/session";
import { getTranslations } from "@/lib/i18n/request";
import { overviewPreferencesSchema } from "@polaris/core";
import { getOverviewPreferences, saveOverviewPreferences } from "@/lib/overview/prefs-service";
import {
    actOnAppWidget,
    appWidgetInputSchema,
    appWidgetTargets,
    readAppWidgets,
    type AppWidgetReadout
} from "@/lib/overview/app-widgets";
import type { AppWidgetTarget } from "@/lib/app-extensions/types";

const slug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/);

/** What a kind of card can watch, for the picker. */
export async function appWidgetTargetsAction(
    app: string,
    kind: string
): Promise<{ targets?: AppWidgetTarget[]; error?: string }> {
    await requireUser();
    const parsed = z.object({ app: slug, kind: slug }).safeParse({ app, kind });
    if (!parsed.success) return { error: (await getTranslations("home"))("appCards.gone") };
    try {
        return { targets: await appWidgetTargets(parsed.data.app, parsed.data.kind) };
    } catch (caught) {
        console.error(caught);
        return { error: (await getTranslations("home"))("appCards.readFailed") };
    }
}

/** Every app card in this reader's layout, read from their stored layout. */
export async function readAppWidgetsAction(): Promise<{
    cards: Record<string, AppWidgetReadout>;
}> {
    const user = await requireUser();
    const preferences = await getOverviewPreferences(user.id);
    return { cards: await readAppWidgets(preferences.appWidgets) };
}

/**
 * Save which app cards are on this reader's Overview, in order. Only that part
 * of the layout: the Overview's own cards and links are left as they are. Not
 * filtered by what is installed - like every card, it is a preference kept for
 * when its app is back.
 */
export async function saveAppWidgetsAction(input: unknown): Promise<{ error?: string }> {
    const user = await requireUser();
    const parsed = overviewPreferencesSchema.shape.appWidgets.safeParse(input);
    if (!parsed.success) return { error: (await getTranslations("home"))("errors.layoutNotSaved") };
    const ids = new Set(parsed.data.map((card) => card.id));
    if (ids.size !== parsed.data.length) {
        return { error: (await getTranslations("home"))("errors.layoutNotSaved") };
    }
    const current = await getOverviewPreferences(user.id);
    await saveOverviewPreferences(user.id, { ...current, appWidgets: parsed.data });
    return {};
}

/** Press a control on one of this reader's app cards. */
export async function actOnAppWidgetAction(
    cardId: string,
    input: unknown
): Promise<{ error?: string }> {
    const user = await requireUser();
    const t = await getTranslations("home");
    const parsed = appWidgetInputSchema.safeParse(input);
    if (!parsed.success || typeof cardId !== "string") return { error: t("appCards.cannotDo") };
    const card = (await getOverviewPreferences(user.id)).appWidgets.find(
        (held) => held.id === cardId
    );
    if (!card) return { error: t("appCards.gone") };
    try {
        const answer = await actOnAppWidget(card, parsed.data);
        if (answer.error === "gone") return { error: t("appCards.gone") };
        if (answer.error === "unknown") return { error: t("appCards.cannotDo") };
        return answer;
    } catch (caught) {
        console.error(caught);
        return { error: t("appCards.cannotDo") };
    }
}
