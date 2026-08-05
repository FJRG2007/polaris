/**
 * What an operator may ask a coding agent to do in one of their repositories.
 *
 * Everything here crosses a boundary twice: once from the form into Polaris, and
 * again from Polaris into the run context the runtime reads on a machine that is
 * about to check out somebody's code and run a model against it. Both directions
 * are validated against these schemas, so what the screen accepts and what a run
 * is handed can never drift.
 *
 * The instructions field is the one worth being careful about. It is operator
 * prose that ends up inside the agent's prompt, so it is bounded but deliberately
 * not sanitised: an operator writing instructions for their own repository is
 * entitled to say anything a prompt can say. What must never join it is text from
 * an issue or a comment, which is a different trust level entirely and is handled
 * where those are read, not here.
 */

import { z } from "zod";
import { githubLoginSchema, githubRepoSchema } from "./runners.js";
import {
    AGENT_EXECUTIONS,
    AGENT_GATE_MODES,
    AGENT_PUSH_POLICIES,
    AGENT_RUN_STATES,
    AGENT_SHELL_POLICIES,
    AGENT_TRIGGERS
} from "../agents.js";

export const agentExecutionSchema = z.enum(AGENT_EXECUTIONS);
export const agentTriggerSchema = z.enum(AGENT_TRIGGERS);
export const agentRunStateSchema = z.enum(AGENT_RUN_STATES);
export const agentPushPolicySchema = z.enum(AGENT_PUSH_POLICIES);
export const agentShellPolicySchema = z.enum(AGENT_SHELL_POLICIES);
export const agentGateModeSchema = z.enum(AGENT_GATE_MODES);

/** The named reasoning levels the form offers. Stored by name and turned into the
 *  runtime's position on the running model's own ladder when a run is dispatched,
 *  because a name survives a model changing its published range and a number does
 *  not. */
export const AGENT_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type AgentEffort = (typeof AGENT_EFFORTS)[number];
export const agentEffortSchema = z.enum(AGENT_EFFORTS);

/** "owner/repo", the form every GitHub API path and every stored row uses. */
export const repoFullNameSchema = z
    .string()
    .trim()
    .min(3, "Pick a repository")
    .max(140)
    .refine(
        (value) => {
            const [owner, repo, ...rest] = value.split("/");
            if (rest.length > 0 || !owner || !repo) return false;
            return githubLoginSchema.safeParse(owner).success && githubRepoSchema.safeParse(repo).success;
        },
        { message: "Not a repository name" }
    );

/**
 * A model slug, as the runtime names them: a curated alias like
 * `anthropic/claude-opus`, or a raw provider specifier. Checked for shape rather
 * than against a list, because the list lives in the runtime and moves with the
 * providers; an unknown slug fails at dispatch with a message naming it, which is
 * a better failure than a form that rejects a model the runtime just gained.
 */
export const agentModelSchema = z
    .string()
    .trim()
    .min(1, "Pick a model")
    .max(120)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/, "Not a model name");

/**
 * How one repository runs.
 *
 * `poolId` is only meaningful for `runners` execution and is checked against the
 * chosen execution rather than left as a loose optional, so a repository cannot
 * be stored claiming to run on a pool it does not name.
 */
export const agentRepoConfigSchema = z
    .object({
        execution: agentExecutionSchema,
        poolId: z.string().uuid().nullable().default(null),
        model: agentModelSchema,
        effort: agentEffortSchema.default("medium"),
        push: agentPushPolicySchema,
        shell: agentShellPolicySchema,
        enabled: z.boolean().default(true),
        // Null is "inherit from the organization, or from the instance". Storing
        // the inherited value instead would freeze it the moment somebody changed
        // the tier above, which is the whole thing the tiers exist to avoid.
        pullRequests: z.boolean().nullable().default(null),
        issues: z.boolean().nullable().default(null),
        gate: agentGateModeSchema.nullable().default(null)
    })
    .refine((value) => value.execution !== "runners" || value.poolId !== null, {
        message: "Pick the runner pool this repository should use",
        path: ["poolId"]
    });

export type AgentRepoConfigInput = z.infer<typeof agentRepoConfigSchema>;

/**
 * What one tier above a repository decides.
 *
 * Every field is nullable for the same reason the repository's own overrides
 * are: a tier that says nothing about a setting must not vote on it. The scope
 * is either the whole instance or one GitHub account, and which of the two it is
 * comes from the `scope` field rather than from which endpoint was called, so
 * one action serves both screens.
 */
export const agentDefaultsSchema = z.object({
    /** Empty for the instance-wide row; a GitHub account or organization login
     *  otherwise. */
    scope: z.union([z.literal(""), githubLoginSchema]).default(""),
    execution: agentExecutionSchema.nullable().default(null),
    poolId: z.string().uuid().nullable().default(null),
    model: agentModelSchema.nullable().default(null),
    effort: agentEffortSchema.nullable().default(null),
    push: agentPushPolicySchema.nullable().default(null),
    shell: agentShellPolicySchema.nullable().default(null),
    publicRepos: z.boolean().nullable().default(null),
    privateRepos: z.boolean().nullable().default(null),
    pullRequests: z.boolean().nullable().default(null),
    issues: z.boolean().nullable().default(null),
    gate: agentGateModeSchema.nullable().default(null)
});

export type AgentDefaultsInput = z.infer<typeof agentDefaultsSchema>;

/** Enabling a repository: its identity, plus how it should run. */
export const enableAgentRepoSchema = z.object({
    repoFullName: repoFullNameSchema,
    installationId: z.string().trim().min(1).max(40),
    config: agentRepoConfigSchema
});

/**
 * What narrows a trigger to the cases an operator actually wants.
 *
 * Every field is a list, and an empty list means "do not narrow on this" rather
 * than "match nothing" - the alternative reads as a filter that silently disables
 * the automation it belongs to. `labels` is what makes `issue.labeled` usable at
 * all; `branches` keeps a pull-request automation off release branches; `authors`
 * is how an operator stops the agent answering itself or a bot.
 */
export const agentConditionSchema = z.object({
    labels: z.array(z.string().trim().min(1).max(80)).max(20).default([]),
    branches: z.array(z.string().trim().min(1).max(200)).max(20).default([]),
    authors: z.array(githubLoginSchema).max(20).default([])
});

export type AgentConditionInput = z.infer<typeof agentConditionSchema>;

/**
 * One rule: when this happens in this repository, run the agent with these
 * instructions.
 *
 * `mode` is the runtime's own vocabulary (Build, Review, and so on) and is
 * optional: left unset, the agent picks the mode that fits what it was handed,
 * which is the right default for a mention and the wrong one for an automation
 * whose whole purpose is to always review.
 */
export const agentAutomationSchema = z.object({
    trigger: agentTriggerSchema,
    condition: agentConditionSchema.default({ labels: [], branches: [], authors: [] }),
    mode: z.string().trim().max(40).nullable().default(null),
    instructions: z.string().trim().max(8000).default(""),
    enabled: z.boolean().default(true)
});

export type AgentAutomationInput = z.infer<typeof agentAutomationSchema>;

/**
 * A run somebody started by hand.
 *
 * The prompt is required and bounded. `issueNumber` attaches the run to an issue
 * or pull request so its output lands there instead of nowhere; without one the
 * result comes back to Polaris only.
 */
export const manualAgentRunSchema = z.object({
    repoFullName: repoFullNameSchema,
    prompt: z.string().trim().min(1, "Say what the agent should do").max(8000),
    issueNumber: z.number().int().positive().max(1_000_000).nullable().default(null),
    mode: z.string().trim().max(40).nullable().default(null)
});

export type ManualAgentRunInput = z.infer<typeof manualAgentRunSchema>;

/** Narrowing the run list. Every field is optional: no filter is the common case. */
export const agentRunFilterSchema = z.object({
    repoFullName: repoFullNameSchema.optional(),
    state: agentRunStateSchema.optional(),
    trigger: agentTriggerSchema.optional(),
    limit: z.number().int().min(1).max(200).default(50),
    cursor: z.string().uuid().optional()
});

export type AgentRunFilterInput = z.infer<typeof agentRunFilterSchema>;
