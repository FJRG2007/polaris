/**
 * Filling in an announcement's placeholders, with Intl alone. Client-safe, so
 * the compose preview and the server agree on every word.
 */

import type { Locale } from "@polaris/core";
import { PLACEHOLDERS, type Placeholder } from "./schema";

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

/** Put the reader's values in. Anything that is not one of the four is left alone. */
export function fillPlaceholders(text: string, values: Record<Placeholder, string>): string {
    return text.replace(/\{(\w+)\}/g, (whole, name: string) =>
        (PLACEHOLDERS as readonly string[]).includes(name) ? values[name as Placeholder] : whole
    );
}

