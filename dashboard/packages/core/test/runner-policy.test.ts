/**
 * The job guard is the only thing standing between a stranger's pull request and
 * one of the operator's machines, and it is shell rather than TypeScript - which
 * means the assertions worth having are the ones that run it.
 *
 * So these execute the generated script under `sh` with the environment GitHub
 * would give it and check the exit status, rather than reading the text back and
 * agreeing with themselves about what it says. Where `sh` is not on the box, the
 * executing half is skipped and the rendering half still runs.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import {
    DEFAULT_RUNNER_REPO_POLICY,
    factsFromLog,
    JOB_FACTS_FILE,
    parseJobFacts,
    parseRunnerEvents,
    renderJobGuard,
    repoServingRefusal,
    secretsWarning,
    type RunnerRepoPolicy
} from "../src/runner-policy.js";

const hasShell = spawnSync("sh", ["-c", "exit 0"]).status === 0;

/** Run the guard the way the runner does, and report what the job would get. */
function runGuard(
    policy: RunnerRepoPolicy,
    env: Record<string, string>,
    options: { visibility?: "public" | "private" | null; payload?: unknown } = {}
): { code: number; output: string; facts: ReturnType<typeof parseJobFacts> } {
    const root = mkdtempSync(join(tmpdir(), "polaris-guard-"));
    const script = join(root, "guard.sh");
    writeFileSync(script, renderJobGuard({ policy, visibility: options.visibility ?? "private" }));

    const full: Record<string, string> = { GITHUB_REPOSITORY: "acme/website", ...env };
    if (options.payload !== undefined) {
        const payload = join(root, "event.json");
        writeFileSync(payload, JSON.stringify(options.payload));
        full.GITHUB_EVENT_PATH = payload;
    }

    const result = spawnSync("sh", [script], { env: { ...process.env, ...full }, encoding: "utf8" });
    let facts = null;
    try {
        facts = parseJobFacts(readFileSync(join(root, JOB_FACTS_FILE), "utf8"));
    } catch {
        facts = null;
    }
    return { code: result.status ?? -1, output: `${result.stdout ?? ""}${result.stderr ?? ""}`, facts };
}

const samePr = {
    pull_request: {
        head: { repo: { full_name: "acme/website" } },
        base: { repo: { full_name: "acme/website" } }
    }
};

const forkedPr = {
    pull_request: {
        head: { repo: { full_name: "stranger/website" } },
        base: { repo: { full_name: "acme/website" } }
    }
};

describe.skipIf(!hasShell)("the job guard, run", () => {
    it("lets a push through on the default policy", () => {
        const { code } = runGuard(DEFAULT_RUNNER_REPO_POLICY, { GITHUB_EVENT_NAME: "push" });
        expect(code).toBe(0);
    });

    it("refuses an event nobody turned on", () => {
        const { code, output } = runGuard(DEFAULT_RUNNER_REPO_POLICY, { GITHUB_EVENT_NAME: "schedule" });
        expect(code).toBe(1);
        expect(output).toContain("schedule");
    });

    it("lets a pull request from the repository itself through", () => {
        const { code } = runGuard(
            DEFAULT_RUNNER_REPO_POLICY,
            { GITHUB_EVENT_NAME: "pull_request" },
            { payload: samePr }
        );
        expect(code).toBe(0);
    });

    it("refuses a pull request whose code comes from a fork", () => {
        const { code, output } = runGuard(
            DEFAULT_RUNNER_REPO_POLICY,
            { GITHUB_EVENT_NAME: "pull_request" },
            { payload: forkedPr }
        );
        expect(code).toBe(1);
        expect(output).toContain("fork");
    });

    it("lets a fork through once forks are allowed", () => {
        const { code } = runGuard(
            { ...DEFAULT_RUNNER_REPO_POLICY, allowForks: true },
            { GITHUB_EVENT_NAME: "pull_request" },
            { payload: forkedPr }
        );
        expect(code).toBe(0);
    });

    it("treats pull_request_target as a pull request, not as something else", () => {
        const { code, output } = runGuard(
            DEFAULT_RUNNER_REPO_POLICY,
            { GITHUB_EVENT_NAME: "pull_request_target" },
            { payload: forkedPr }
        );
        expect(code).toBe(1);
        expect(output).toContain("fork");
    });

    it("refuses when it cannot tell whether the code is from a fork", () => {
        const { code, output } = runGuard(DEFAULT_RUNNER_REPO_POLICY, { GITHUB_EVENT_NAME: "pull_request" });
        expect(code).toBe(1);
        expect(output).toContain("could not");
    });

    it("refuses everything on a public repository nobody opted into", () => {
        const { code, output } = runGuard(
            DEFAULT_RUNNER_REPO_POLICY,
            { GITHUB_EVENT_NAME: "push" },
            { visibility: "public" }
        );
        expect(code).toBe(1);
        expect(output).toContain("public");
    });

    it("serves a public repository once it is allowed", () => {
        const { code } = runGuard(
            { ...DEFAULT_RUNNER_REPO_POLICY, allowPublic: true },
            { GITHUB_EVENT_NAME: "push" },
            { visibility: "public" }
        );
        expect(code).toBe(0);
    });

    it("lets an unnamed event through only when everything else is on", () => {
        const off = runGuard({ ...DEFAULT_RUNNER_REPO_POLICY }, { GITHUB_EVENT_NAME: "release" });
        expect(off.code).toBe(1);
        const on = runGuard(
            { ...DEFAULT_RUNNER_REPO_POLICY, events: [...DEFAULT_RUNNER_REPO_POLICY.events, "other"] },
            { GITHUB_EVENT_NAME: "release" }
        );
        expect(on.code).toBe(0);
    });

    it("records what the job was, whether or not it was allowed to run", () => {
        const ran = runGuard(DEFAULT_RUNNER_REPO_POLICY, {
            GITHUB_EVENT_NAME: "push",
            GITHUB_WORKFLOW: "CI",
            GITHUB_RUN_ID: "1234567",
            GITHUB_ACTOR: "fjrg2007"
        });
        expect(ran.facts?.workflow).toBe("CI");
        expect(ran.facts?.runId).toBe("1234567");
        expect(ran.facts?.actor).toBe("fjrg2007");
        expect(ran.facts?.refused).toBeNull();

        const refused = runGuard(DEFAULT_RUNNER_REPO_POLICY, {
            GITHUB_EVENT_NAME: "pull_request",
            GITHUB_WORKFLOW: "CI"
        });
        expect(refused.facts?.workflow).toBe("CI");
        expect(refused.facts?.refused).toContain("could not");
    });

    it("keeps a repository name with a quote in it from ending the script", () => {
        const { code } = runGuard(DEFAULT_RUNNER_REPO_POLICY, {
            GITHUB_EVENT_NAME: "push",
            GITHUB_REPOSITORY: "acme/it's-fine"
        });
        expect(code).toBe(0);
    });
});

describe("what a repository is allowed", () => {
    it("refuses to serve a public repository until somebody says so", () => {
        expect(repoServingRefusal(DEFAULT_RUNNER_REPO_POLICY, "public")).toContain("public");
        expect(repoServingRefusal(DEFAULT_RUNNER_REPO_POLICY, "private")).toBeNull();
        expect(repoServingRefusal({ ...DEFAULT_RUNNER_REPO_POLICY, allowPublic: true }, "public")).toBeNull();
    });

    it("refuses a repository with every event turned off", () => {
        expect(repoServingRefusal({ ...DEFAULT_RUNNER_REPO_POLICY, events: [] }, "private")).toContain("no events");
    });

    it("says what the secrets are exposed to, and stays quiet when they are not", () => {
        expect(secretsWarning(DEFAULT_RUNNER_REPO_POLICY, "private")).toBeNull();
        expect(secretsWarning({ ...DEFAULT_RUNNER_REPO_POLICY, allowForks: true }, "private")).toContain("forks");
        expect(secretsWarning({ ...DEFAULT_RUNNER_REPO_POLICY, allowPublic: true }, "public")).toContain("public");
        expect(secretsWarning({ ...DEFAULT_RUNNER_REPO_POLICY, secrets: false, allowForks: true }, "private")).toBeNull();
    });
});

describe("reading a stored event list", () => {
    it("keeps only the events this version knows", () => {
        expect(parseRunnerEvents(JSON.stringify(["push", "deploy_key_rotated"]))).toEqual(["push"]);
    });

    it("falls back to the default rather than allowing everything", () => {
        expect(parseRunnerEvents("not json")).toEqual([...DEFAULT_RUNNER_REPO_POLICY.events]);
        expect(parseRunnerEvents(JSON.stringify([]))).toEqual([]);
    });
});

describe("reading a job record out of a log", () => {
    it("finds the marked line among the runner's own chatter", () => {
        const log = [
            "√ Connected to GitHub",
            "Current runner version: '2.320.0'",
            `${"::polaris-job::"}{"workflow":"CI","runId":"99","refused":""}`,
            "Running job: build"
        ].join("\n");
        expect(factsFromLog(log)?.workflow).toBe("CI");
        expect(factsFromLog(log)?.runId).toBe("99");
    });

    it("takes the last record when a log carries more than one", () => {
        const log = [
            `${"::polaris-job::"}{"workflow":"first"}`,
            `${"::polaris-job::"}{"workflow":"second"}`
        ].join("\n");
        expect(factsFromLog(log)?.workflow).toBe("second");
    });

    it("says nothing about a runner that was never given a job", () => {
        expect(factsFromLog("√ Connected to GitHub\nListening for Jobs")).toBeNull();
    });
});

describe("reading a job record", () => {
    it("refuses a run id that is not one", () => {
        expect(parseJobFacts(JSON.stringify({ runId: "7; rm -rf /" }))?.runId).toBeNull();
        expect(parseJobFacts(JSON.stringify({ runId: "42" }))?.runId).toBe("42");
    });

    it("survives a file that was never finished", () => {
        expect(parseJobFacts('{"workflow":"CI"')).toBeNull();
        expect(parseJobFacts("")).toBeNull();
        expect(parseJobFacts("[]")).toBeNull();
    });
});
