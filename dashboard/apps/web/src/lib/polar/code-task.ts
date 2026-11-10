/**
 * A Code task Polar answers itself, with the chat's own models: the repository
 * it is about, and the line that tells the model so.
 *
 * Nothing starts for it - no container, no checkout, no branch - so the first
 * answer comes as fast as a chat's. The repository is read through the repo_
 * tools (`code-host-tools.ts`), which act with the person's own GitHub access.
 */

import { z } from "zod";
import * as core from "@polaris/core";

/** A branch as it is written into the prompt: the characters a ref is made of. */
const branchSchema = z
    .string()
    .trim()
    .max(200)
    .regex(/^[A-Za-z0-9._/-]*$/);

export const polarCodeTaskSchema = z.object({
    repo: core.repoFullNameSchema,
    branch: branchSchema.default("")
});
export type PolarCodeTask = z.infer<typeof polarCodeTaskSchema>;

/** The system line for a Code task, empty for a plain chat. */
export function codeTaskPrompt(task: PolarCodeTask | null): string {
    if (!task) return "";
    const where = task.branch
        ? `https://github.com/${task.repo}/tree/${task.branch}`
        : `https://github.com/${task.repo}`;
    return [
        `This is a Code task on the GitHub repository ${task.repo}${task.branch ? `, branch ${task.branch}` : ""} (${where}).`,
        "Questions are about this repository's code unless the person says otherwise: read it with the repo_ tools before answering, cite the files you used, and write code that fits what is already there."
    ].join(" ");
}
