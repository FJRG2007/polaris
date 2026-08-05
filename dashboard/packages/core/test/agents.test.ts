import { describe, expect, it } from "vitest";
import {
    agentAutomationSchema,
    agentDefaultsSchema,
    agentRepoConfigSchema,
    ALWAYS_ON_TRIGGER,
    DEFAULT_AGENT_POLICY,
    defaultShellPolicy,
    isTerminalRunState,
    manualAgentRunSchema,
    parseAgentTriggers,
    policyAllowsTrigger,
    policyAllowsVisibility,
    recommendExecution,
    resolveAgentPolicy,
    repoFullNameSchema,
    type ExecutionAdviceInput
} from "../src/index.js";

/** Everything available, so each case below only states what it changes. */
const ABLE: ExecutionAdviceInput = {
    isPrivate: false,
    servingPool: true,
    serverCapable: true,
    publiclyReachable: true
};

describe("recommendExecution", () => {
    it("sends a public repository to GitHub Actions even when everything else is available", () => {
        // The point of the recommendation: hosted runners are free here, so
        // spending the operator's hardware would buy nothing.
        const advice = recommendExecution(ABLE);
        expect(advice.execution).toBe("actions");
        expect(advice.reason).toContain("public");
        expect(advice.unavailable).toEqual({});
    });

    it("sends a private repository to a pool that already covers it", () => {
        const advice = recommendExecution({ ...ABLE, isPrivate: true });
        expect(advice.execution).toBe("runners");
    });

    it("sends a private repository with no pool to the Polaris box", () => {
        const advice = recommendExecution({ ...ABLE, isPrivate: true, servingPool: false });
        expect(advice.execution).toBe("server");
        expect(advice.reason).toContain("no GitHub Actions minutes");
    });

    it("falls back to hosted runners for a private repository with nowhere else to run, and says it costs", () => {
        const advice = recommendExecution({
            isPrivate: true,
            servingPool: false,
            serverCapable: false,
            publiclyReachable: true
        });
        expect(advice.execution).toBe("actions");
        expect(advice.reason).toContain("billed per minute");
    });

    it("refuses GitHub Actions outright when the instance has no public address", () => {
        // Not a preference: the runtime calls back for its run context, so a
        // hosted runner that cannot reach the instance fails after it starts.
        const advice = recommendExecution({ ...ABLE, publiclyReachable: false });
        expect(advice.unavailable.actions).toBeDefined();
        expect(advice.execution).not.toBe("actions");
    });

    it("keeps a public repository off hosted runners it cannot reach, without claiming they are an option", () => {
        const advice = recommendExecution({ ...ABLE, publiclyReachable: false });
        expect(advice.execution).toBe("server");
        expect(advice.unavailable.runners).toBeUndefined();
        expect(advice.unavailable.server).toBeUndefined();
    });

    it("names every blocker when nothing can run", () => {
        const advice = recommendExecution({
            isPrivate: true,
            servingPool: false,
            serverCapable: false,
            publiclyReachable: false
        });
        expect(Object.keys(advice.unavailable).sort()).toEqual(["actions", "runners", "server"]);
        expect(advice.reason).toContain("Nothing can run this repository yet");
    });

    it("explains a missing pool rather than silently ranking it last", () => {
        const advice = recommendExecution({ ...ABLE, servingPool: false });
        expect(advice.unavailable.runners).toContain("Apps > Runners");
    });
});

describe("parseAgentTriggers", () => {
    it("keeps only names this version knows, so a newer row cannot widen what runs", () => {
        expect(parseAgentTriggers(JSON.stringify(["mention", "pr.opened", "invented.trigger"]))).toEqual([
            "mention",
            "pr.opened"
        ]);
    });

    it("reads malformed and non-array values as no triggers", () => {
        expect(parseAgentTriggers("not json")).toEqual([]);
        expect(parseAgentTriggers('"mention"')).toEqual([]);
        expect(parseAgentTriggers("{}")).toEqual([]);
    });

    it("returns triggers in the canonical order however they were stored", () => {
        expect(parseAgentTriggers(JSON.stringify(["pr.opened", "mention"]))).toEqual(["mention", "pr.opened"]);
    });
});

describe("defaultShellPolicy", () => {
    it("filters secrets out of a public repository's shell", () => {
        // Anybody can open the pull request the agent then reads, so the shell it
        // can run commands in must not carry the operator's keys.
        expect(defaultShellPolicy(false)).toBe("restricted");
        expect(defaultShellPolicy(true)).toBe("enabled");
    });
});

describe("isTerminalRunState", () => {
    it("treats only states that have stopped moving as terminal", () => {
        expect(isTerminalRunState("queued")).toBe(false);
        expect(isTerminalRunState("running")).toBe(false);
        expect(isTerminalRunState("succeeded")).toBe(true);
        expect(isTerminalRunState("failed")).toBe(true);
        expect(isTerminalRunState("cancelled")).toBe(true);
    });
});

describe("repoFullNameSchema", () => {
    it("accepts an owner/repo pair", () => {
        expect(repoFullNameSchema.safeParse("FJRG2007/polaris").success).toBe(true);
        expect(repoFullNameSchema.safeParse("acme/my.repo_name-2").success).toBe(true);
    });

    it("rejects anything that is not exactly one owner and one repository", () => {
        for (const value of ["polaris", "a/b/c", "/polaris", "acme/", "-acme/repo", "acme/repo name"]) {
            expect(repoFullNameSchema.safeParse(value).success, value).toBe(false);
        }
    });
});

describe("agentRepoConfigSchema", () => {
    const base = {
        execution: "server" as const,
        model: "anthropic/claude-opus",
        push: "restricted" as const,
        shell: "enabled" as const
    };

    it("fills the defaults an operator did not state", () => {
        const parsed = agentRepoConfigSchema.parse(base);
        expect(parsed.effort).toBe("medium");
        expect(parsed.enabled).toBe(true);
        expect(parsed.poolId).toBeNull();
    });

    it("refuses runner execution that names no pool", () => {
        const result = agentRepoConfigSchema.safeParse({ ...base, execution: "runners" });
        expect(result.success).toBe(false);
        if (!result.success) {
            expect(result.error.issues[0]?.path).toEqual(["poolId"]);
        }
    });

    it("accepts runner execution with a pool", () => {
        const parsed = agentRepoConfigSchema.parse({
            ...base,
            execution: "runners",
            poolId: "0195e5a0-0000-7000-8000-000000000000"
        });
        expect(parsed.poolId).not.toBeNull();
    });

    it("rejects a model slug that is not one", () => {
        expect(agentRepoConfigSchema.safeParse({ ...base, model: "" }).success).toBe(false);
        expect(agentRepoConfigSchema.safeParse({ ...base, model: "has spaces" }).success).toBe(false);
    });
});

describe("agentAutomationSchema", () => {
    it("defaults an unnarrowed condition to lists that do not filter", () => {
        const parsed = agentAutomationSchema.parse({ trigger: "pr.opened" });
        expect(parsed.condition).toEqual({ labels: [], branches: [], authors: [] });
        expect(parsed.mode).toBeNull();
        expect(parsed.instructions).toBe("");
    });

    it("rejects a trigger it does not define", () => {
        expect(agentAutomationSchema.safeParse({ trigger: "pr.merged" }).success).toBe(false);
    });
});

describe("manualAgentRunSchema", () => {
    it("requires something for the agent to do", () => {
        const result = manualAgentRunSchema.safeParse({ repoFullName: "acme/repo", prompt: "   " });
        expect(result.success).toBe(false);
    });

    it("accepts a prompt with no issue attached", () => {
        const parsed = manualAgentRunSchema.parse({ repoFullName: "acme/repo", prompt: "Update the readme" });
        expect(parsed.issueNumber).toBeNull();
    });
});

describe("resolveAgentPolicy", () => {
    it("lets the most specific tier that answered win", () => {
        const policy = resolveAgentPolicy({ gate: "off" }, { gate: "checks", issues: false }, { gate: "full" });
        expect(policy.gate).toBe("off");
        // The repository said nothing about issues, so the account's answer stands.
        expect(policy.issues).toBe(false);
    });

    it("treats null as inherit rather than as a value", () => {
        // The whole reason every column is nullable: a tier that stored its
        // inherited value would freeze it the moment the tier above changed.
        const policy = resolveAgentPolicy({ pullRequests: null }, { pullRequests: false });
        expect(policy.pullRequests).toBe(false);
    });

    it("falls back to the built-in defaults when no tier answered", () => {
        expect(resolveAgentPolicy(null, undefined, {})).toEqual(DEFAULT_AGENT_POLICY);
    });

    it("gates by default, because a gate nobody opted into never catches anything", () => {
        expect(DEFAULT_AGENT_POLICY.gate).toBe("full");
    });
});

describe("policyAllowsVisibility", () => {
    it("reads the switch that matches the repository", () => {
        const policy = resolveAgentPolicy({ publicRepos: false, privateRepos: true });
        expect(policyAllowsVisibility(policy, true)).toBe(true);
        expect(policyAllowsVisibility(policy, false)).toBe(false);
    });
});

describe("policyAllowsTrigger", () => {
    const off = resolveAgentPolicy({ pullRequests: false, issues: false });

    it("stops pull-request and issue triggers when they are turned off", () => {
        expect(policyAllowsTrigger(off, "pr.opened")).toBe(false);
        expect(policyAllowsTrigger(off, "issue.labeled")).toBe(false);
    });

    it("never gates a mention", () => {
        // A repository where addressing the app directly did nothing would look
        // installed and be inert.
        expect(policyAllowsTrigger(off, ALWAYS_ON_TRIGGER)).toBe(true);
    });

    it("leaves a manual run and a failed check alone", () => {
        expect(policyAllowsTrigger(off, "manual")).toBe(true);
        expect(policyAllowsTrigger(off, "ci.failed")).toBe(true);
    });
});

describe("agentDefaultsSchema", () => {
    it("defaults every field to inherit", () => {
        const parsed = agentDefaultsSchema.parse({});
        expect(parsed.scope).toBe("");
        expect(parsed.gate).toBeNull();
        expect(parsed.publicRepos).toBeNull();
    });

    it("takes a GitHub login as the account scope", () => {
        expect(agentDefaultsSchema.parse({ scope: "acme" }).scope).toBe("acme");
    });

    it("refuses a scope that is not a login", () => {
        expect(agentDefaultsSchema.safeParse({ scope: "acme/repo" }).success).toBe(false);
    });
});

describe("agentRepoConfigSchema", () => {
    it("leaves the tiered settings inheriting unless the repository answers them", () => {
        const parsed = agentRepoConfigSchema.parse({
            execution: "server",
            model: "anthropic/claude-opus",
            push: "restricted",
            shell: "restricted"
        });
        expect(parsed.pullRequests).toBeNull();
        expect(parsed.issues).toBeNull();
        expect(parsed.gate).toBeNull();
    });
});
