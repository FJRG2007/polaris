/**
 * Runner pool schemas: what an operator may ask Polaris to keep running on one of
 * their machines.
 *
 * A pool is a standing offer of compute to GitHub, so the bounds here are not
 * cosmetic. `maxConcurrent` decides how many processes Polaris starts on somebody
 * else's server; the scope decides whose workflows get to run on it, and every
 * owner and repository in it ends up in a REST path; the labels decide which
 * workflows are allowed to land there. All of them are checked before anything is
 * stored, and the same schemas run on the form so the two never disagree about
 * what is acceptable.
 *
 * The scope is a tagged union rather than a set of optional fields, because the
 * fields a repository scope needs and the fields a Polaris group scope needs have
 * nothing in common, and a shape that accepts both accepts neither properly.
 *
 * What is deliberately absent is a way to ask for a non-ephemeral runner. A runner
 * that survives its job keeps a credential on disk and carries one workflow's
 * leftovers into the next, and neither is something an operator should be able to
 * opt into from a form.
 */

import { z } from "zod";
import { serverIdSchema } from "./host.js";
import { MAX_RUNNER_CONCURRENCY, MAX_RUNNER_TARGETS, normalizeRunnerLabels, RUNNER_ISOLATIONS, RUNNER_JOB_STATES } from "../runners.js";
import {
    MAX_JOBS_PER_DAY,
    MAX_MINUTES_BUDGET,
    RUNNER_EXHAUSTED_ACTIONS,
    RUNNER_WINDOWS
} from "../runner-placement.js";

export const runnerIsolationSchema = z.enum(RUNNER_ISOLATIONS);
export const runnerJobStateSchema = z.enum(RUNNER_JOB_STATES);
export const runnerWindowSchema = z.enum(RUNNER_WINDOWS);
export const runnerExhaustedActionSchema = z.enum(RUNNER_EXHAUSTED_ACTIONS);

/** A GitHub account login: alphanumerics and single hyphens, 39 characters max,
 *  and never hyphen-terminated. Held to GitHub's own rule because the value is
 *  interpolated into an API path. */
const githubLoginSchema = z
    .string()
    .trim()
    .min(1, "Enter the GitHub account")
    .max(39)
    .regex(/^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9]))*$/, "Not a GitHub account name");

/** A repository name. Wider than a login - dots and underscores are legal - but
 *  still an allowlist rather than free text. */
const githubRepoSchema = z
    .string()
    .trim()
    .min(1, "Enter the repository")
    .max(100)
    .regex(/^[A-Za-z0-9._-]+$/, "Not a repository name");

const repoRefSchema = z.object({ owner: githubLoginSchema, repo: githubRepoSchema });

/**
 * What the pool serves. Each variant carries only what its own kind needs, and the
 * two that name Polaris principals carry ids rather than logins - a GitHub account
 * enters this through the link the person made themselves, never through something
 * typed on their behalf.
 */
export const runnerScopeSchema = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("repo"), owner: githubLoginSchema, repo: githubRepoSchema }),
    z.object({
        kind: z.literal("repos"),
        repos: z
            .array(repoRefSchema)
            .min(1, "Pick at least one repository")
            .max(MAX_RUNNER_TARGETS, `At most ${MAX_RUNNER_TARGETS} repositories`)
    }),
    z.object({ kind: z.literal("account"), owner: githubLoginSchema }),
    z.object({ kind: z.literal("org"), owner: githubLoginSchema }),
    z.object({
        kind: z.literal("users"),
        userIds: z.array(z.string().uuid()).min(1, "Pick at least one person").max(50)
    }),
    z.object({ kind: z.literal("group"), groupId: z.string().uuid("Pick a group") })
]);

export type RunnerScopeInput = z.infer<typeof runnerScopeSchema>;

/**
 * What one repository may spend inside this pool. Every field is optional and
 * absent means unlimited; zero would mean "may never run", which is what pausing
 * the pool is for.
 */
export const runnerLimitsSchema = z.object({
    perTargetConcurrent: z.coerce.number().int().min(1).max(MAX_RUNNER_CONCURRENCY).nullable().default(null),
    minutesBudget: z.coerce.number().int().min(1).max(MAX_MINUTES_BUDGET).nullable().default(null),
    minutesWindow: runnerWindowSchema.default("month"),
    jobsPerDay: z.coerce.number().int().min(1).max(MAX_JOBS_PER_DAY).nullable().default(null),
    onExhausted: runnerExhaustedActionSchema.default("pause")
});

export type RunnerLimitsInput = z.infer<typeof runnerLimitsSchema>;

/** Labels a workflow selects with `runs-on`. Normalized the way GitHub normalizes
 *  them, so what the form shows is what the runner registers with. */
const runnerLabelsSchema = z
    .array(z.string().trim().min(1).max(64))
    .max(10, "Ten labels is plenty")
    .transform(normalizeRunnerLabels)
    .refine((labels) => labels.length > 0, "A pool needs at least one label");

/** The label every pool starts with: it is what `runs-on: self-hosted` matches,
 *  and a pool nothing can select is not worth creating. */
export const DEFAULT_RUNNER_LABELS = ["self-hosted"];

export const createRunnerPoolSchema = z.object({
    /** The server the runners run on: a registered Host, or the box Polaris
     *  itself runs on. */
    serverId: serverIdSchema,
    name: z.string().trim().min(1, "Name this pool").max(80),
    scope: runnerScopeSchema,
    labels: runnerLabelsSchema,
    maxConcurrent: z.coerce
        .number()
        .int()
        .min(1, "At least one runner")
        .max(MAX_RUNNER_CONCURRENCY, `At most ${MAX_RUNNER_CONCURRENCY} runners`)
        .default(1),
    isolation: runnerIsolationSchema,
    limits: runnerLimitsSchema.default({})
});

export type CreateRunnerPoolInput = z.infer<typeof createRunnerPoolSchema>;

/**
 * Everything about a pool that can change without re-registering it on a different
 * machine. The scope can: a target that leaves it has its runners stood down on the
 * next pass, the same way one that leaves a resolved account does.
 */
export const updateRunnerPoolSchema = z.object({
    id: z.string().uuid(),
    name: z.string().trim().min(1, "Name this pool").max(80).optional(),
    scope: runnerScopeSchema.optional(),
    labels: runnerLabelsSchema.optional(),
    maxConcurrent: z.coerce.number().int().min(1).max(MAX_RUNNER_CONCURRENCY).optional(),
    limits: runnerLimitsSchema.optional(),
    enabled: z.boolean().optional()
});

export type UpdateRunnerPoolInput = z.infer<typeof updateRunnerPoolSchema>;
