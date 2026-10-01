/**
 * Calendar's words on the server: the reader's language from the host, the
 * messages from the app's own catalogs. See dashboard/docs/i18n.md.
 */

import { host } from "@polaris/app-host";
import { DEFAULT_LOCALE, type Locale, type Translator } from "@polaris/core";
import { calendarCatalogs, type CalendarKey, type CalendarRuleKey } from "../../messages";

export type CalendarTranslator = Translator<CalendarKey>;
export type CalendarRuleTranslator = Translator<CalendarRuleKey>;

/** The translator for whoever is reading this request. */
export async function calendarT(): Promise<CalendarTranslator> {
    return calendarCatalogs.translator(await host.i18nRequest.getLocale(), "calendar");
}

/** The language of one account, with no request around it - a reminder, an
 *  invitation. A job that cannot ask still says it, in the source language. */
export async function localeOf(userId: string): Promise<Locale> {
    try {
        return await host.i18nLocaleService.getUserLocale(userId);
    } catch {
        return DEFAULT_LOCALE;
    }
}

/** The translator for one account. */
export async function calendarTFor(userId: string): Promise<CalendarTranslator> {
    return calendarCatalogs.translator(await localeOf(userId), "calendar");
}

/** The translator for a locale already in hand. */
export function calendarTIn(locale: Locale): CalendarTranslator {
    return calendarCatalogs.translator(locale, "calendar");
}

/** How repeats and reminders read, in a locale already in hand. */
export function ruleTIn(locale: Locale): CalendarRuleTranslator {
    return calendarCatalogs.translator(locale, "calendarRule");
}
