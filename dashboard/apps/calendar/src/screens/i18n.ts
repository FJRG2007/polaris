/**
 * Calendar's words in the browser, in the language the page is drawn in.
 *
 *     const t = useCalendarT();
 *     <h2>{t("sidebar.mine")}</h2>
 *
 * The engine phrases repeats and reminders itself and takes a plain
 * `(key, values) => string`; `useRuleT` hands it one over the `calendarRule`
 * namespace.
 */

import type { RuleTranslator } from "../engine";
import { hostUi } from "@polaris/app-host/client";
import type { MessageParams } from "@polaris/core";
import type { CalendarRuleTranslator, CalendarTranslator } from "../lib/i18n";
import { calendarCatalogs, type CalendarKey, type CalendarRuleKey } from "../../messages";

export type { CalendarKey };

export function useCalendarT(): CalendarTranslator {
    return calendarCatalogs.translator(hostUi.i18nProvider.useLocale(), "calendar");
}

/** The engine's view of the rule words: any key, checked by the catalog test. */
export function ruleWords(t: CalendarRuleTranslator): RuleTranslator {
    return (key, values) => t(key as CalendarRuleKey, values as MessageParams | undefined);
}

export function useRuleT(): { t: CalendarRuleTranslator; words: RuleTranslator; locale: string } {
    const locale = hostUi.i18nProvider.useLocale();
    const t = calendarCatalogs.translator(locale, "calendarRule");
    return { t, words: ruleWords(t), locale };
}
