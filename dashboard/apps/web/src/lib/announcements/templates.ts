/**
 * The words an announcement is read in, per reader.
 *
 * A template left as written is drawn from the `announcements` catalog in the
 * reader's own language, and every text - template or edited - has its
 * placeholders ({start}, {end}, {duration}, {affected}) filled in that reader's
 * language and time zone. So a window written in Madrid reads as 03:00 in
 * Madrid and 21:00 in New York, each in their own words.
 *
 * Maintenance changes words as it goes: the text the administrator edited
 * belongs to the phase its template is for, and the other phases (in progress,
 * finished) use their own template rather than repeating "will be down".
 *
 * Server-only: it holds the catalogs.
 */

import type { Phase } from "./phase";
import type { Locale } from "@polaris/core";
import { translatorFor } from "@/lib/i18n/translate";
import { PLACEHOLDERS, type Placeholder, type TemplateId } from "./schema";

export interface Reader {
    locale: Locale;
    timeZone: string;
}

export interface RenderInput {
    kind: string;
    template: string;
    localized: boolean;
    title: string;
    body: string;
    startsAt: Date;
    endsAt: Date | null;
    windowStart: Date | null;
    windowEnd: Date | null;
    affected: readonly string[];
}

const PHASE_TEMPLATE: Partial<Record<Phase, TemplateId>> = {
    scheduled: "maintenanceScheduled",
    upcoming: "maintenanceScheduled",
    inProgress: "maintenanceInProgress",
    finished: "maintenanceFinished",
    ended: "maintenanceFinished"
};

/** The template a phase reads from: a maintenance step's own, or the one picked. */
export function templateForPhase(item: Pick<RenderInput, "kind" | "template">, phase: Phase): string {
    if (item.kind !== "maintenance") return item.template;
    return PHASE_TEMPLATE[phase] ?? item.template;
}

function safeZone(zone: string): string {
    try {
        new Intl.DateTimeFormat("en-US", { timeZone: zone });
        return zone;
    } catch {
        return "UTC";
    }
}

/** "2 hours, 30 minutes" in the reader's language, from Intl alone. */
export function formatDuration(ms: number, locale: Locale): string {
    const minutes = Math.max(1, Math.round(ms / 60_000));
    const days = Math.floor(minutes / 1440);
    const hours = Math.floor((minutes % 1440) / 60);
    const rest = minutes % 60;
    const unit = (value: number, name: "day" | "hour" | "minute") =>
        new Intl.NumberFormat(locale, { style: "unit", unit: name, unitDisplay: "long" }).format(value);
    const parts = [
        days > 0 ? unit(days, "day") : null,
        hours > 0 ? unit(hours, "hour") : null,
        rest > 0 ? unit(rest, "minute") : null
    ].filter((part): part is string => part !== null);
    return new Intl.ListFormat(locale, { type: "unit", style: "long" }).format(parts);
}

/** What each placeholder stands for, for this reader. */
export function placeholderValues(item: RenderInput, reader: Reader): Record<Placeholder, string> {
    const t = translatorFor(reader.locale, "announcements");
    const start = item.windowStart ?? item.startsAt;
    const end = item.windowEnd ?? item.endsAt;
    const when = new Intl.DateTimeFormat(reader.locale, {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: safeZone(reader.timeZone)
    });
    return {
        start: when.format(start),
        end: end ? when.format(end) : t("vars.noEnd"),
        duration: end ? formatDuration(end.getTime() - start.getTime(), reader.locale) : t("vars.noEnd"),
        affected:
            item.affected.length > 0
                ? new Intl.ListFormat(reader.locale, { type: "conjunction" }).format([...item.affected])
                : t("vars.everything")
    };
}

/** Put the reader's values in. Anything that is not one of the four is left alone. */
export function fillPlaceholders(text: string, values: Record<Placeholder, string>): string {
    return text.replace(/\{(\w+)\}/g, (whole, name: string) =>
        (PLACEHOLDERS as readonly string[]).includes(name) ? values[name as Placeholder] : whole
    );
}

/** A template's words with the placeholders still in, for the compose form to start from. */
export function templateText(locale: Locale, id: string): { title: string; body: string } {
    const t = translatorFor(locale, "announcements");
    const raw = Object.fromEntries(PLACEHOLDERS.map((name) => [name, `{${name}}`]));
    const key = id as TemplateId;
    return {
        title: t(`templates.${key}.title`, raw),
        body: t(`templates.${key}.body`, raw)
    };
}

/** The title and body one reader sees in one phase. */
export function renderFor(item: RenderInput, phase: Phase, reader: Reader): { title: string; body: string } {
    const values = placeholderValues(item, reader);
    const template = templateForPhase(item, phase);
    const own = !item.localized && template === item.template;
    const text = own ? { title: item.title, body: item.body } : templateText(reader.locale, template);
    return { title: fillPlaceholders(text.title, values), body: fillPlaceholders(text.body, values) };
}
