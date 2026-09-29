/**
 * What the runner service writes down in English, in the reader's words.
 *
 * A pool's note, a repository's reason for not being served and a runner's
 * reason for stopping are written by the reconcile loop - a background pass with
 * nobody to ask for a language - and stored as sentences. This matches the
 * English back to its key in the `runners` catalog, exactly or by its shape for
 * a sentence that names a repository or a count. Anything it does not know - what
 * a runner printed, a machine's own error, a newer service - passes through.
 */

import type { NamespaceKey, NamespaceTranslator } from "@/lib/i18n/types";

type Words = NamespaceTranslator<"runners">;
type Key = NamespaceKey<"runners">;

const EXACT: Readonly<Record<string, Key>> = {
    "Could not reconcile this pool": "notes.couldNotReconcile",
    "This pool serves no repositories.": "notes.servesNothing",
    "The pool no longer serves this repository.": "notes.noLongerServed",
    "The machine did not start the runner": "notes.didNotStart",
    "The runner exited before it registered": "notes.exitedEarly",
    "None of the people chosen have linked a GitHub account yet, so there is nothing to serve.": "notes.usersUnlinked",
    "Nobody in that group has linked a GitHub account yet, so there is nothing to serve.": "notes.groupUnlinked",
    "This scope resolves to no repositories.": "notes.scopeEmpty",
    "This pool's scope could not be read, so it is serving whatever it last resolved to.": "notes.scopeUnread",
    "This repository is public, so anybody can open a pull request that runs on your machine. Allow public repositories on it if that is what you want.":
        "notes.publicRefused",
    "Nothing is allowed to run here: no events are turned on.": "notes.noEvents",
    "This repository is public and its jobs can read the secrets set for it. Anybody who gets a workflow to run here reads them too.":
        "notes.publicSecrets",
    "Pull requests from forks run here and their jobs can read the secrets set for it. Whoever opens one chooses the code that reads them.":
        "notes.forkSecrets",
    "Pool not found": "notes.poolNotFound",
    "This pool does not serve that repository": "notes.notServed",
    "GitHub returned no usable runner version": "notes.noRunnerVersion",
    "This repository is public, and public repositories are not allowed on this runner.": "guard.publicRefused",
    "Polaris could not read this job's event, so it could not tell whether the code comes from a fork.": "guard.eventUnread",
    "Polaris could not tell whether this pull request comes from a fork, so it did not run it.": "guard.forkUnknown",
    "Polaris could not read where this pull request's code comes from, so it did not run it.": "guard.headUnread",
    "This scope serves no repositories.": "notes.scopeServesNothing",
    "Nobody chosen has linked a GitHub account yet, so this pool would serve nothing.": "notes.nobodyLinked",
    "This machine did not report what it has, so start with one job and watch it.": "machine.unreported",
    "Polaris cannot reach this machine's container engine, which is the only way it runs jobs here. Check that the host daemon is running.":
        "machine.engineUnreachable",
    "Connect GitHub under Integrations before adding runners.": "access.connect",
    "Polaris cannot read a fine-grained token's permissions. Give it Administration: read and write on the repositories you want runners for, and it will tell you if that is missing when you add one.":
        "access.fineGrained",
    "This token has neither the `repo` nor the `admin:org` scope, so it cannot register runners. Replace it, or connect a GitHub App instead.":
        "access.tokenScopes",
    "The GitHub App is not installed on any account yet.": "access.appNotInstalled",
    "The GitHub App cannot register runners yet. On its settings page add Repository permissions > Administration: Read and write for repository runners, or Organization permissions > Self-hosted runners: Read and write for organization-wide ones, then approve the request on each installation.":
        "access.appPermissions",
    "Enter the GitHub account": "schema.enterAccount",
    "Not a GitHub account name": "schema.notAccount",
    "Enter the repository": "schema.enterRepository",
    "Not a repository name": "schema.notRepository",
    "Pick at least one repository": "schema.pickRepository",
    "Pick at least one person": "schema.pickPerson",
    "Pick a group": "schema.pickGroup",
    "Ten labels is plenty": "schema.tooManyLabels",
    "A pool needs at least one label": "schema.needsLabel",
    "Name this pool": "schema.namePool",
    "At least one runner": "schema.oneRunner",
    "Name this secret": "schema.nameSecret",
    "That name is too long": "schema.nameTooLong",
    "A name can only be letters, digits and underscores, and cannot start with a digit": "schema.nameShape",
    "Enter the value": "schema.enterValue",
    "That value is too long for a runner to carry": "schema.valueTooLong",
    "A value has to be one line. For a key or a certificate, store it as base64 and decode it in the workflow step that needs it.":
        "schema.valueOneLine"
};

/** Sentences that carry a value, by their shape. */
const SHAPED: readonly (readonly [RegExp, Key, readonly string[]])[] = [
    [/^Used (\d+) of (\d+) minutes today\.$/, "notes.minutesToday", ["used", "budget"]],
    [/^Used (\d+) of (\d+) minutes this month\.$/, "notes.minutesMonth", ["used", "budget"]],
    [/^Ran (\d+) of (\d+) jobs allowed today\.$/, "notes.jobsToday", ["ran", "allowed"]],
    [/^(\d+) repositories are over their budget this window\.$/, "notes.overBudget", ["count"]],
    [/^Stopped serving (.+) and (\d+) more\.$/, "notes.stoppedServingMore", ["names", "rest"]],
    [/^Stopped serving (.+)\.$/, "notes.stoppedServing", ["names"]],
    [
        /^This resolves to (\d+) repositories; the (\d+) most recently pushed are served\.$/,
        "notes.tooMany",
        ["count", "max"]
    ],
    [/^Polaris cannot see any repositories on (.+)\. Check the GitHub App is installed there\.$/, "notes.noRepositoriesOn", ["owner"]],
    [/^Jobs started by '(.+)' are not allowed on this runner\.$/, "guard.eventRefused", ["event"]],
    [
        /^This pull request's code comes from (.+), which is a fork of (.+)\. Pull requests from forks are not allowed on this runner\.$/,
        "guard.forkRefused",
        ["head", "base"]
    ],
    [/^GitHub publishes no runner for (.+) on (.+)\.$/, "notes.noRunnerForMachine", ["platform", "arch"]],
    [/^GitHub publishes no runner for (.+) on (.+)$/, "notes.noRunnerFor", ["platform", "arch"]],
    [/^The GitHub App is not installed on (.+)\.$/, "access.notInstalledOn", ["owner"]],
    [
        /^The connection cannot register organization runners for (.+)\. Grant it Organization permissions > Self-hosted runners: Read and write\.$/,
        "access.noOrgRunners",
        ["owner"]
    ],
    [
        /^The connection cannot register runners on (.+)'s repositories\. Grant it Repository permissions > Administration: Read and write, or register at the organization level instead\.$/,
        "access.noRepoRunners",
        ["owner"]
    ],
    [/^Names starting with (\S+) belong to the runner and cannot be replaced$/, "schema.reservedName", ["prefix"]],
    [/^Could not read the runner release from GitHub \((\d+)\)$/, "notes.releaseUnread", ["status"]],
    [/^GitHub publishes no (.+) runner for (.+)$/, "notes.noRunnerBuild", ["platform", "version"]],
    [/^GitHub published no checksum for the (.+) runner (.+)$/, "notes.noChecksum", ["platform", "version"]]
];

const NUMBERS = new Set(["used", "budget", "ran", "allowed", "count", "rest", "max", "status"]);

/** Every English sentence this knows, for the test that holds the catalog to it. */
export const KNOWN_RUNNER_NOTES: readonly string[] = Object.keys(EXACT);

/** What a machine reported having - "8 processors, 15.6 GB of memory, 120 GB
 *  free" - or null when any part of it is not one of those. */
function summaryText(t: Words, summary: string): string | null {
    const parts = summary.split(", ").map((part) => {
        const processors = /^(\d+) processors?$/.exec(part);
        if (processors) return t("machine.processors", { count: Number(processors[1]) });
        const memory = /^(\S+ GB) of memory$/.exec(part);
        if (memory?.[1]) return t("machine.memory", { size: memory[1] });
        const free = /^(\S+ GB) free$/.exec(part);
        if (free?.[1]) return t("machine.free", { size: free[1] });
        return null;
    });
    return parts.every((part) => part !== null) ? parts.join(", ") : null;
}

/** "this system" and "this processor" stand in for what a machine did not say. */
function unnamed(t: Words, value: string): string {
    if (value === "this system") return t("machine.thisSystem");
    if (value === "this processor") return t("machine.thisProcessor");
    return value;
}

/** The sentences that carry another sentence of this service's inside them. */
function nested(t: Words, message: string): string | null {
    const room = /^(.+): room for about (\d+) jobs? at once\.$/.exec(message);
    if (room?.[1]) {
        const summary = summaryText(t, room[1]);
        if (summary !== null) return t("machine.room", { summary, count: Number(room[2]) });
    }
    const short =
        /^(.+) is not enough to run a job here\. One job needs about (\S+ GB) of memory and (\S+ GB) of free disk, on top of what the machine is already doing\.$/.exec(
            message
        );
    if (short?.[1]) {
        const summary = summaryText(t, short[1]);
        if (summary !== null) {
            return t("machine.notEnough", { summary, memory: short[2] ?? "", disk: short[3] ?? "" });
        }
    }
    const worth = /^This machine is worth about (\d+) jobs? at once \((.+)\)\.$/s.exec(message);
    if (worth?.[2]) {
        return t("machine.worth", { count: Number(worth[1]), note: runnerText(t, worth[2]) });
    }
    const platform = /^GitHub publishes no runner for (.+) on (.+)\.$/.exec(message);
    if (platform?.[1] && platform[2]) {
        return t("notes.noRunnerForMachine", { platform: unnamed(t, platform[1]), arch: unnamed(t, platform[2]) });
    }
    return null;
}

function known(t: Words, message: string): string | null {
    const exact = EXACT[message];
    if (exact) return t(exact);
    const inner = nested(t, message);
    if (inner !== null) return inner;
    for (const [pattern, key, names] of SHAPED) {
        const match = pattern.exec(message);
        if (!match) continue;
        const params: Record<string, string | number> = {};
        names.forEach((name, index) => {
            const value = match[index + 1] ?? "";
            params[name] = NUMBERS.has(name) ? Number(value) : value;
        });
        return t(key, params);
    }
    return null;
}

/** The sentence in the reader's words, or null when it is not one of this
 *  service's - which is how a schema's own sentence is told from Zod's. */
export function knownRunnerText(t: Words, message: string): string | null {
    const said = known(t, message);
    if (said !== null) return said;
    // One repository over its budget is noted as "owner/repo: <its reason>". Only
    // a reason this knows is taken apart, so a machine's own "host: error" is left
    // as it came.
    const split = /^([^\s:]+): (.+)$/s.exec(message);
    if (split?.[1] && split[2]) {
        const reason = known(t, split[2]);
        if (reason !== null) return `${split[1]}: ${reason}`;
    }
    // A machine with too little to run a job is described by its parts alone.
    return summaryText(t, message);
}

export function runnerText(t: Words, message: string): string {
    return knownRunnerText(t, message) ?? message;
}

/** What a pool's scope comes to, in one line: "acme/website", "4 repositories". */
export function scopeSummaryText(
    t: Words,
    pool: { scope: string; targets: readonly { key: string }[] }
): string {
    if (pool.scope === "org") {
        const key = pool.targets[0]?.key;
        return key ? t("scope.organization", { name: key }) : t("scope.anOrganization");
    }
    if (pool.targets.length === 0) return t("scope.nothingYet");
    if (pool.targets.length === 1) return pool.targets[0]?.key ?? "";
    return t("scope.repositories", { count: pool.targets.length });
}
