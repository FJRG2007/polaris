import type { NamespaceTranslator } from "@/lib/i18n/types";

/**
 * A sentence the tracker code wrote, in the reader's language.
 *
 * The sync and the check run from a schedule as well as from this screen, and
 * what they say is stored on the connection as it was said, so the fixed
 * sentences Polaris writes are translated here, where somebody is reading them.
 * What a provider said about its own refusal is its words and passes through.
 */
export function trackerSentence(t: NamespaceTranslator<"tasks">, text: string): string {
    const connectedAs = /^Connected as (.+)\.$/.exec(text);
    if (connectedAs) return t("trackers.reasons.connectedAs", { name: connectedAs[1] ?? "" });
    const known: Record<string, Parameters<typeof t>[0]> = {
        "That connection no longer exists.": "trackers.reasons.gone",
        "This build does not know that tracker.": "trackers.reasons.unknownTracker",
        "This connection has no key stored on it.": "trackers.reasons.noKey",
        "That connection has no key stored on it.": "trackers.reasons.noKey",
        "The tracker did not answer.": "trackers.reasons.noAnswer",
        "That connection is not one of yours.": "trackers.reasons.notYours",
        "It did not answer.": "trackers.reasons.itDidNotAnswer",
        "Linear did not answer.": "trackers.reasons.linearNoAnswer",
        "Jira did not answer.": "trackers.reasons.jiraNoAnswer",
        "Linear refused the request": "trackers.reasons.linearRefused",
        "This Jira connection has no site on it.": "trackers.reasons.noSite"
    };
    const key = known[text];
    return key ? t(key) : text;
}
