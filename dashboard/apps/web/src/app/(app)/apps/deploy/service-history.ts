/**
 * A service's history in plain language.
 *
 * Kept out of the component that draws it so the wording can be tested without a
 * browser, the same way Tasks keeps its own describer in `conversation.ts`.
 */

import type { ActivityLine } from "@/lib/activity/activity";

/** One line of a service's history, as a sentence. */
export function describeServiceEvent(line: ActivityLine): string {
    const who = line.authorName ?? "Polaris";
    switch (line.action) {
        case "deployed":
            return `${who} deployed it`;
        case "restarted":
            return `${who} restarted it`;
        case "started":
            return `${who} started it`;
        case "stopped":
            return `${who} stopped it`;
        case "torn down":
            return `${who} tore down the running deployment`;
        case "duplicated":
            return `${who} duplicated it`;
        case "variable":
            // The name, never the value: a feed anybody with the service open can
            // read is not where a secret goes.
            return line.toValue ? `${who} changed the ${line.toValue} variable` : `${who} changed a variable`;
        case "variables-imported":
            return `${who} imported ${line.toValue ?? "some"} variables`;
        case "variable-removed":
            return `${who} removed a variable`;
        case "port":
            return `${who} set the port to ${line.toValue}`;
        default:
            return `${who} changed it`;
    }
}
