/**
 * What `@polaris/core` names in English for the Agents app, in the reader's words.
 *
 * Core keeps a label and a note for every execution place, trigger, run state and
 * policy, because the service and the model's own instructions read them too.
 * The screens say them through the `agents` catalog instead, keyed by the same
 * ids: `labels.<group>.<id>`, with a dotted or underscored id written in camel
 * case. An id core adds before the catalog has words for it shows as core names it.
 */

import {
    AGENT_EXECUTION_LABELS,
    AGENT_EXECUTION_NOTES,
    AGENT_GATE_MODE_LABELS,
    AGENT_GATE_MODE_NOTES,
    AGENT_PUSH_POLICY_LABELS,
    AGENT_PUSH_POLICY_NOTES,
    AGENT_RUN_STATE_LABELS,
    AGENT_SESSION_PLACE_LABELS,
    AGENT_SESSION_STATE_LABELS,
    AGENT_SHELL_POLICY_LABELS,
    AGENT_SHELL_POLICY_NOTES,
    AGENT_TRIGGER_LABELS,
    AGENT_TRIGGER_NOTES
} from "@polaris/core";
import type { NamespaceKey, NamespaceTranslator } from "@/lib/i18n/types";

/** Every group of words, with the English core holds for it. */
export const AGENT_WORD_GROUPS = {
    execution: AGENT_EXECUTION_LABELS,
    executionNote: AGENT_EXECUTION_NOTES,
    trigger: AGENT_TRIGGER_LABELS,
    triggerNote: AGENT_TRIGGER_NOTES,
    runState: AGENT_RUN_STATE_LABELS,
    pushPolicy: AGENT_PUSH_POLICY_LABELS,
    pushPolicyNote: AGENT_PUSH_POLICY_NOTES,
    shellPolicy: AGENT_SHELL_POLICY_LABELS,
    shellPolicyNote: AGENT_SHELL_POLICY_NOTES,
    gateMode: AGENT_GATE_MODE_LABELS,
    gateModeNote: AGENT_GATE_MODE_NOTES,
    sessionState: AGENT_SESSION_STATE_LABELS,
    sessionPlace: AGENT_SESSION_PLACE_LABELS
} as const;

export type AgentWordGroup = keyof typeof AGENT_WORD_GROUPS;

/** `pr.review_requested` -> `prReviewRequested`, the form the catalog keys take. */
function keyOf(id: string): string {
    return id.replace(/[._-](\w)/g, (_, letter: string) => letter.toUpperCase());
}

/** What one id of a group is called, in the reader's words. */
export function agentWord(t: NamespaceTranslator<"agents">, group: AgentWordGroup, id: string): string {
    const english: Readonly<Record<string, string>> = AGENT_WORD_GROUPS[group];
    if (!Object.hasOwn(english, id)) return id;
    return t(`labels.${group}.${keyOf(id)}` as NamespaceKey<"agents">);
}

/**
 * A sentence the agent services or the shared schemas wrote in English, in the
 * reader's words: a refusal, a run's reason for stopping, a repository's
 * problem. Matched exactly, or by its shape for one that names an account, a
 * number or a status. Anything else - GitHub's own answer, what a program
 * printed - passes through.
 */
const EXACT: Readonly<Record<string, NamespaceKey<"agents">>> = {
    "Pick a repository": "text.pickRepository",
    "Not a repository name": "text.notRepository",
    "Pick a model": "text.pickModel",
    "Not a model name": "text.notModel",
    "Pick the runner pool this repository should use": "text.pickPool",
    "Say what the agent should do": "text.sayWhat",
    "Pick a provider": "text.pickProvider",
    "Paste the key": "text.pasteKey",
    "Not a URL": "text.notUrl",
    "Name the model your endpoint serves": "text.nameModel",
    "Not a date": "text.notDate",
    "Pick a date in the future": "text.futureDate",
    "Pick a sign-in": "text.pickSignIn",
    "That sign-in is no longer open.": "text.signInClosed",
    "Type something": "text.typeSomething",
    "That is longer than a code": "text.tooLongForCode",
    "A usage limit stopped this run.": "text.limitStopped",
    "Canceled from Polaris.": "text.cancelled",
    // The spelling runs finished before the catalogs moved to US English were stored with.
    "Cancelled from Polaris.": "text.cancelled",
    "The run stopped reporting and was closed out. Its logs, if any, are on the job it ran as.": "text.stoppedReporting",
    "Could not write the workflow file": "text.workflowWrite",
    "GitHub has not registered the workflow file yet. It was just written, so try again in a moment.":
        "text.workflowUnregistered",
    "GitHub could not find the agent workflow in this repository.": "text.workflowMissing",
    "Polaris could not start this session. Nothing was left running.": "text.sessionFailed",
    "Polaris could not read the stored credentials just now. Try again in a moment.": "text.credentialsUnread",
    "The server refused to start the session.": "text.serverRefused",
    "This Polaris is running as many agent sessions as it is set to allow. Try again when one finishes, or ask an administrator to raise the limit.":
        "text.instanceFull",
    "That server already has a workspace session open, and a workspace is one directory. Stop that session and this will start.":
        "text.hostWorkspaceTaken",
    "Somebody already has a session open on the shared machine, and it has one workspace. Wait for that to finish, or open this one on your own machine.":
        "text.sharedWorkspaceTaken",
    "You already have a workspace session open, and it is the same directory this one would use. Stop that session and this will start.":
        "text.ownWorkspaceTaken",
    "its agent never opened a terminal to type into": "text.noTerminal",
    "Preparing your machine": "boot.workspace",
    "Fetching the repository": "boot.fetch",
    "Opening your workspace": "boot.opening",
    "Installing Enigma": "boot.enigma",
    "Installing the agent": "boot.agent",
    "The agent is already here": "boot.agentHere",
    "Starting the agent": "boot.start",
    "A GitHub-hosted runner has to reach this Polaris instance, and it has no public address yet.": "advice.noPublicAddress",
    "This Polaris instance cannot start containers, so it cannot run an agent itself.": "advice.noContainers",
    "No runner pool covers this repository yet. Add one under Apps > Runners.": "advice.noPool",
    "This repository is public, so GitHub-hosted runners are free and nothing runs on your hardware.": "advice.public",
    "A runner pool already covers this repository, so it runs on your own machine instead of a hosted one.": "advice.pool",
    "This repository is private, and running it here spends no GitHub Actions minutes.": "advice.private",
    "This instance has no public address, so the run happens here rather than on a hosted machine.": "advice.noAddress",
    "Nothing here can run it, so it falls to GitHub-hosted runners. A private repository is billed per minute.": "advice.hostedPrivate",
    "GitHub-hosted runners are free for this repository.": "advice.hostedFree",
    "Nothing can run this repository yet. Fix one of the reasons below.": "advice.nothing"
};

const SHAPED: readonly (readonly [RegExp, NamespaceKey<"agents">, readonly string[]])[] = [
    [
        /^Polaris has no GitHub App installation for (.+), so it cannot write the workflow file\.$/,
        "text.noInstallationWorkflow",
        ["owner"]
    ],
    [
        /^Polaris has no GitHub App installation for (.+)\. An administrator connects one under Integrations\.$/,
        "text.noInstallationRun",
        ["owner"]
    ],
    [
        /^Polaris has no GitHub App installation for (.+), so it cannot check the repository out\.$/,
        "text.noInstallationCheckout",
        ["owner"]
    ],
    [
        /^Polaris has no GitHub App installation for (.+), so it cannot check the repository out\. Connect it again under Agents settings\.$/,
        "text.noInstallationSession",
        ["owner"]
    ],
    [
        /^You already have (\d+) sessions running, which is the most one account may have at once\. Stop one and this will start\.$/,
        "text.accountFull",
        ["count"]
    ],
    [/^Polaris no longer knows an agent called (.+)\.$/, "text.unknownAgent", ["cli"]],
    [/^GitHub returned (\d+) starting the workflow$/, "text.githubStart", ["status"]],
    [/^GitHub returned (\d+) reading the repository$/, "text.githubRead", ["status"]],
    [/^The workflow finished as (.+)\. Its log is on the run in GitHub Actions\.$/, "text.workflowFinished", ["conclusion"]]
];

/** The usage-limit refusal, which names whose limit, what and over what window. */
const LIMIT =
    /^(This repository|This account|Repositories under (.+)) has used (\d+) of the (\d+) (runs|tokens) allowed in (1 day|1 week|30 days)\. An administrator sets these under Admin > Agents\.$/;
const PERIODS: Readonly<Record<string, string>> = { "1 day": "day", "1 week": "week", "30 days": "month" };

/** The sentence in the reader's words, or null when it is not one of these. */
export function knownAgentText(t: NamespaceTranslator<"agents">, message: string): string | null {
    const exact = EXACT[message];
    if (exact) return t(exact);
    for (const [pattern, key, names] of SHAPED) {
        const match = pattern.exec(message);
        if (!match) continue;
        const params: Record<string, string | number> = {};
        names.forEach((name, index) => {
            const value = match[index + 1] ?? "";
            params[name] = name === "status" || name === "count" ? Number(value) : value;
        });
        return t(key, params);
    }
    // The first prompt that never arrived, with why - which may be one of these too.
    const prompt = /^Polaris could not send the first prompt: (.+)\. Send it again from the box below\.$/s.exec(message);
    if (prompt?.[1]) {
        const reason = prompt[1] === "unknown" ? t("text.unknownReason") : agentText(t, prompt[1]);
        return t("text.firstPrompt", { reason });
    }
    const limit = LIMIT.exec(message);
    if (limit) {
        const whose = limit[1] === "This repository" ? "repo" : limit[1] === "This account" ? "account" : "org";
        return t("text.limit", {
            whose,
            org: limit[2] ?? "",
            used: Number(limit[3]),
            amount: Number(limit[4]),
            metric: limit[5] ?? "runs",
            period: PERIODS[limit[6] ?? ""] ?? "day"
        });
    }
    return null;
}

export function agentText(t: NamespaceTranslator<"agents">, message: string): string {
    return knownAgentText(t, message) ?? message;
}

/** A session's state as the list shows it: one that has never reported is still
 *  starting, whatever its row says. The same rule as core's `sessionStateLabel`. */
export function sessionStateWord(
    t: NamespaceTranslator<"agents">,
    state: string,
    hasReported: boolean
): string {
    return agentWord(t, "sessionState", state === "idle" && !hasReported ? "starting" : state);
}
