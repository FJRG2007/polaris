/**
 * A service's history in plain language.
 *
 * Kept out of the component that draws it so the wording can be tested without a
 * browser, the same way Tasks keeps its own describer in `conversation.ts`.
 */

import type { ActivityLine } from "@/lib/activity/activity";
import type { NamespaceTranslator } from "@/lib/i18n/types";
import { AUTOSCALE_IDLE_AFTER, AUTOSCALE_SIGNALS, AUTOSCALED_ACTION_PREFIX } from "@polaris/core";

/**
 * Why the autoscaler moved the count, from the signal in the action's name. A
 * line written by a later release with a signal this one does not know still
 * says what happened, without the why.
 */
type ServiceT = NamespaceTranslator<"deployService">;

function autoscaleReason(action: string, up: boolean, t: ServiceT): string {
    const signal = AUTOSCALE_SIGNALS.find(
        (known) => action === `${AUTOSCALED_ACTION_PREFIX}${known}`
    );
    switch (signal) {
        case undefined:
            return "";
        case "range":
            return t("history.reason.range");
        case "idle":
            return t("history.reason.idle", { minutes: AUTOSCALE_IDLE_AFTER });
        case "cpu":
            return up ? t("history.reason.cpuUp") : t("history.reason.cpuDown");
        case "traffic":
            return up ? t("history.reason.trafficUp") : t("history.reason.trafficDown");
        case "both":
            return up ? t("history.reason.bothUp") : t("history.reason.bothDown");
    }
}

function describeAutoscale(line: ActivityLine, who: string, t: ServiceT): string {
    const from = Number(line.fromValue);
    const to = Number(line.toValue);
    if (!line.fromValue || !line.toValue || !Number.isInteger(from) || !Number.isInteger(to)) {
        return t("history.autoscaled", { who });
    }
    const reason = autoscaleReason(line.action, to > from, t);
    return t("history.autoscaledFromTo", { who, from, to, reason });
}

/** One line of a service's history, as a sentence. */
export function describeServiceEvent(line: ActivityLine, t: ServiceT): string {
    // i18n-ignore: the product's name stands in for a person
    const who = line.authorName ?? "Polaris";
    if (line.action.startsWith(AUTOSCALED_ACTION_PREFIX)) return describeAutoscale(line, who, t);
    switch (line.action) {
        case "deployed":
            return t("history.deployed", { who });
        case "restarted":
            return t("history.restarted", { who });
        case "started":
            return t("history.started", { who });
        case "stopped":
            return t("history.stopped", { who });
        // Written by the pass that halts services recorded as stopped
        // (`deploy/desired-state.ts`), with nobody as the author.
        case "stopped-unasked":
            return t("history.stoppedUnasked", { who });
        case "resumed":
            return t("history.resumed", { who });
        case "torn down":
            return t("history.tornDown", { who });
        case "duplicated":
            return t("history.duplicated", { who });
        case "variable":
            // The name, never the value: a feed anybody with the service open can
            // read is not where a secret goes.
            return line.toValue
                ? t("history.variableNamed", { who, name: line.toValue })
                : t("history.variable", { who });
        case "variables-imported":
            return line.toValue
                ? t("history.variablesImported", { who, count: line.toValue })
                : t("history.variablesImportedSome", { who });
        case "variable-removed":
            return t("history.variableRemoved", { who });
        case "port":
            return t("history.port", { who, port: line.toValue ?? "" });
        // A one-click service's setup. What a step printed is its last line with
        // the service's secrets masked, written that way before it was stored.
        case "setup":
            return line.toValue
                ? t("history.setupWithOutput", {
                      who,
                      step: line.fromValue ?? "",
                      output: line.toValue
                  })
                : t("history.setup", { who, step: line.fromValue ?? "" });
        case "setup-failed":
            return t("history.setupFailed", {
                who,
                step: line.fromValue ?? "",
                output: line.toValue ?? ""
            });
        case "setup-blocked":
            return t("history.setupBlocked", {
                who,
                companion: line.fromValue ?? "",
                output: line.toValue ?? ""
            });
        case "first-deploy-failed":
            return t("history.firstDeployFailed", { who, output: line.toValue ?? "" });
        case "secrets-withheld":
            return t("history.secretsWithheld", { who, names: line.toValue ?? "" });
        default:
            return t("history.changed", { who });
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
