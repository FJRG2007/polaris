/**
 * How long a suspension runs for.
 *
 * A day first, because a suspension is nearly always "come back tomorrow"; the
 * rest are the shapes a moderation decision actually takes, plus the one that
 * does not end. Zero is a ban with no end - the deliberate choice rather than
 * the default, since a ban somebody has to remember to lift a week later is the
 * one every administrator meant to be a suspension.
 *
 * Its own module because two screens offer it - the record for one account, and
 * the menu on a row of the directory - and a second copy would be a second list
 * to keep in step.
 */

import type { NamespaceTranslator } from "@/lib/i18n/types";

export const BAN_LENGTHS = [
    { minutes: 60, key: "hour" },
    { minutes: 1440, key: "day" },
    { minutes: 4320, key: "threeDays" },
    { minutes: 10080, key: "week" },
    { minutes: 43200, key: "thirtyDays" },
    { minutes: 0, key: "untilLifted" }
] as const;

/** The lengths as picker options, in the reader's language. */
export function banLengthOptions(t: NamespaceTranslator<"admin">): { value: string; label: string }[] {
    return BAN_LENGTHS.map((entry) => ({ value: String(entry.minutes), label: t(`users.ban.lengths.${entry.key}`) }));
}

/** What the button says: a length is a suspension, no length is a ban. */
export function banVerb(t: NamespaceTranslator<"admin">, minutes: number): string {
    return minutes > 0 ? t("users.ban.suspend") : t("users.ban.ban");
}
