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
        // A one-click service's setup. What a step printed is its last line with
        // the service's secrets masked, written that way before it was stored.
        case "setup":
            return `${who} ran "${line.fromValue}"${line.toValue ? `: ${line.toValue}` : ""}`;
        case "setup-failed":
            return `${who} could not run "${line.fromValue}": ${line.toValue}`;
        case "setup-blocked":
            return `${who} did not deploy it, because ${line.fromValue} did not come up: ${line.toValue}`;
        case "first-deploy-failed":
            return `${who} could not start its first deploy: ${line.toValue}`;
        default:
            return `${who} changed it`;
    }
}

/**
 * The setup failure a service still has, from its history (newest first), or
 * null.
 *
 * A failed setup command stays failed until one runs through: deploying again
 * does not run it. A deploy that never started - its database or companion did
 * not come up - is over once somebody deploys the service themselves.
 */
export function unresolvedSetupFailure(lines: readonly ActivityLine[]): ActivityLine | null {
    let deployedSince = false;
    for (const line of lines) {
        if (line.action === "setup") return null;
        if (line.action === "setup-failed") return line;
        if (line.action === "setup-blocked" || line.action === "first-deploy-failed") {
            return deployedSince ? null : line;
        }
        if (line.action === "deployed") deployedSince = true;
    }
    return null;
}
