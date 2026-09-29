/**
 * The words of the Challenges tab, from the app's own catalogs
 * (`messages/<locale>/challenges.json`), in the language the page is drawn in.
 *
 * The catalogue's challenge titles and explanations are the one exception:
 * they are the same bilingual data the game reads its lines from
 * (`lib/minecraft/challenges/catalog.ts`), picked here by the same language.
 */

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
    return { t: gameCatalogs.translator(locale, "challenges"), locale, language: languageOf(locale) };
}

/** A difficulty's name: the weekly three are one step up (medium, hard, elite). */
export function tierName(t: ChallengesT, layer: catalog.Layer, tier: catalog.Difficulty): string {
    if (layer !== "weekly") return t(`tier.${tier}`);
    return t(tier === "easy" ? "tier.weeklyEasy" : tier === "medium" ? "tier.weeklyMedium" : "tier.weeklyHard");
}

/** How long until something, the way the tab says it. */
export function durationText(t: ChallengesT, ms: number): string {
    const minutes = Math.max(1, Math.round(ms / 60_000));
    const days = Math.floor(minutes / 1440);
    const hours = Math.floor((minutes % 1440) / 60);
    if (days > 0) return t("duration.days", { days, hours });
    if (hours > 0) return t("duration.hours", { hours, minutes: minutes % 60 });
    return t("duration.minutes", { minutes });
}

/** The keys a settings refusal may carry (`settings.ts`), and what else is not one. */
export function issueText(t: ChallengesT, message: string | undefined): string {
    if (message && message.startsWith("errors.")) return t(message as ChallengesKey);
    return t("errors.checkSettings");
}
