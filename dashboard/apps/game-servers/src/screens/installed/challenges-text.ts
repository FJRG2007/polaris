/**
 * The words of the Challenges tab, from the app's own catalogs
 * (`messages/<locale>/challenges.json`), in the language the page is drawn in.
 *
 * The catalogue's challenge titles and explanations are the one exception:
 * they are the same bilingual data the game reads its lines from
 * (`lib/minecraft/challenges/catalog.ts`), picked here by the same language.
 */

import { figureLanguage, formatDuration } from "../../lib/figures";
import type { Translator } from "@polaris/core";
import { hostUi } from "@polaris/app-host/client";
import * as catalog from "../../lib/minecraft/challenges/catalog";
import { gameCatalogs, type ChallengesKey } from "../../../messages";

export type ChallengesT = Translator<ChallengesKey>;
export type PanelLanguage = catalog.Language;

/** The catalogue's language for a page locale: Spanish for Spanish, else English. */
export function languageOf(locale: string): PanelLanguage {
    return locale.toLowerCase().startsWith("es") ? "es" : "en";
}

/** The tab's translator, the page's locale and the catalogue's language. */
export function useChallengesText(): { t: ChallengesT; locale: string; language: PanelLanguage } {
    const locale = hostUi.i18nProvider.useLocale();
    return {
        t: gameCatalogs.translator(locale, "challenges"),
        locale,
        language: languageOf(locale)
    };
}

/** A difficulty's name: the weekly three are one step up (medium, hard, elite). */
export function tierName(t: ChallengesT, layer: catalog.Layer, tier: catalog.Difficulty): string {
    if (layer !== "weekly") return t(`tier.${tier}`);
    return t(
        tier === "easy"
            ? "tier.weeklyEasy"
            : tier === "medium"
              ? "tier.weeklyMedium"
              : "tier.weeklyHard"
    );
}

/** How long until something, short (`figures.formatDuration`), in the reader's language. */
export function durationText(locale: string, ms: number): string {
    return formatDuration(Math.max(60_000, ms), figureLanguage(locale));
}

/** The keys a settings refusal may carry (`settings.ts`), and what else is not one. */
export function issueText(t: ChallengesT, message: string | undefined): string {
    if (message && message.startsWith("errors.")) return t(message as ChallengesKey);
    return t("errors.checkSettings");
}
