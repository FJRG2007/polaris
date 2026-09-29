/**
 * A server's history in plain language.
 *
 * Kept out of the panel that draws it so the wording can be tested without a
 * browser and without dragging the server actions - and therefore the session -
 * into the test. Deploy keeps its own describer in `service-history.ts` for the
 * same reason.
 */

import type { ActivityLine } from "@/lib/activity/activity";
import type { NamespaceTranslator } from "@/lib/i18n/types";

/** One line of a server's history, as a sentence in the reader's words. */
export function describeServerEvent(line: ActivityLine, t: NamespaceTranslator<"servers">): string {
    const who = line.authorName ?? "Polaris";
    switch (line.action) {
        case "renamed":
            return line.toValue ? t("history.renamedTo", { who, name: line.toValue }) : t("history.renamed", { who });
        case "environment":
            return t("history.environment", { who, where: line.toValue ?? t("history.elsewhere") });
        case "edge-ready":
            return t("history.edgeReady", { who });
        case "edge-failed":
            return line.toValue
                ? t("history.edgeFailedWhy", { who, reason: line.toValue })
                : t("history.edgeFailed", { who });
        default:
            return t("history.changed", { who });
    }
}
