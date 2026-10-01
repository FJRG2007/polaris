/**
 * Calendar's catalogs, every locale, as one set. The app cannot import the
 * dashboard's, so it ships its own and builds them with the same function.
 */

import enUS from "./en-US";
import esES from "./es-ES";
import { defineCatalogs, type MessageKey } from "@polaris/core";

export const calendarCatalogs = defineCatalogs({ "en-US": enUS, "es-ES": esES });

/** Every key in the `calendar` namespace. */
export type CalendarKey = MessageKey<(typeof enUS)["calendar"]>;

/** Every key in the `calendarRule` namespace: how a repeat or a reminder reads. */
export type CalendarRuleKey = MessageKey<(typeof enUS)["calendarRule"]>;

/** The source language, for code with no reader to ask - a log line, a test, a
 *  default. A screen never uses this. */
export const englishCalendar = calendarCatalogs.translator("en-US", "calendar");
