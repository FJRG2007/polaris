/**
 * A comment on anything.
 *
 * The body's ceiling lives here rather than beside the one screen that first
 * needed it: a note on a service and a comment on a task are the same text in
 * the same table, and two different limits for it is how one surface quietly
 * accepts what another refuses.
 */

import { z } from "zod";

/** Long enough for anything somebody types by hand, low enough that a paste
 *  cannot be used to fill the database. */
export const COMMENT_BODY_MAX = 10000;

export const commentBody = z.string().trim().min(1, "Write something first").max(COMMENT_BODY_MAX);

/** Posting a note on something that is not a task - a service, a server. The
 *  task version adds a parent and an assignee; see `commentSchema`. */
export const subjectCommentSchema = z.object({
    subjectId: z.string().uuid(),
    body: commentBody
});

export type SubjectCommentInput = z.infer<typeof subjectCommentSchema>;
