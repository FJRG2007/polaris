/**
 * A server's history in plain language.
 *
 * Kept out of the panel that draws it so the wording can be tested without a
 * browser and without dragging the server actions - and therefore the session -
 * into the test. Deploy keeps its own describer in `service-history.ts` for the
 * same reason.
 */

import type { ActivityLine } from "@/lib/activity/activity";

/** One line of a server's history, as a sentence. */
export function describeServerEvent(line: ActivityLine): string {
    const who = line.authorName ?? "Polaris";
    switch (line.action) {
        case "renamed":
            return line.toValue ? `${who} renamed it to ${line.toValue}` : `${who} renamed it`;
        case "environment":
            return `${who} set where it lives to ${line.toValue ?? "somewhere else"}`;
        default:
            return `${who} changed it`;
    }
}
