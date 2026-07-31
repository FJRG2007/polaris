/**
 * Runner pool schemas: what an operator may ask Polaris to keep running on one of
 * their machines.
 *
 * A pool is a standing offer of compute to GitHub, so the bounds here are not
 * cosmetic. `maxConcurrent` decides how many processes Polaris starts on somebody
 * else's server; the target owner and repository end up in REST paths; the labels
 * decide which workflows are allowed to land there. All of them are checked before
 * anything is stored, and the same schemas run on the form so the two never
 * disagree about what is acceptable.
 *
 * What is deliberately absent is a way to ask for a non-ephemeral runner. A runner
 * that survives its job keeps a credential on disk and carries one workflow's
 * leftovers into the next, and neither is something an operator should be able to
 * opt into from a form.
 */

import { z } from "zod";
import {
    MAX_RUNNER_CONCURRENCY,
    normalizeRunnerLabels,
    RUNNER_ISOLATIONS,
    RUNNER_JOB_STATES,
    RUNNER_SCOPES
} from "../runners.js";

export const runnerScopeSchema = z.enum(RUNNER_SCOPES);
export const runnerIsolationSchema = z.enum(RUNNER_ISOLATIONS);
export const runnerJobStateSchema = z.enum(RUNNER_JOB_STATES);

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

export const createRunnerPoolSchema = z
    .object({
        /** The registered server the runners run on. */
        hostId: z.string().uuid("Choose a server"),
        name: z.string().trim().min(1, "Name this pool").max(80),
        scope: runnerScopeSchema,
        targetOwner: githubLoginSchema,
        /** Required for a repository pool, ignored for an organization one. */
        targetRepo: githubRepoSchema.optional(),
        labels: runnerLabelsSchema,
        maxConcurrent: z.coerce
            .number()
            .int()
            .min(1, "At least one runner")
            .max(MAX_RUNNER_CONCURRENCY, `At most ${MAX_RUNNER_CONCURRENCY} runners`)
            .default(1),
        isolation: runnerIsolationSchema
    })
    .superRefine((value, ctx) => {
        if (value.scope === "repo" && !value.targetRepo) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ["targetRepo"],
                message: "Enter the repository these runners serve"
            });
        }
    });

export type CreateRunnerPoolInput = z.infer<typeof createRunnerPoolSchema>;

/** Everything about a pool that can change without re-registering it against a
 *  different target. Moving a pool to another repository is a different pool. */
export const updateRunnerPoolSchema = z.object({
    id: z.string().uuid(),
    name: z.string().trim().min(1, "Name this pool").max(80).optional(),
    labels: runnerLabelsSchema.optional(),
    maxConcurrent: z.coerce.number().int().min(1).max(MAX_RUNNER_CONCURRENCY).optional(),
    enabled: z.boolean().optional()
});

export type UpdateRunnerPoolInput = z.infer<typeof updateRunnerPoolSchema>;
