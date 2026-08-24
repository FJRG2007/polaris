"use server";

/**
 * Reporting a person.
 *
 * Its own module rather than a line in the chat's actions, because it is not
 * about a conversation: somebody can be reported from a profile, from a member
 * list, from anywhere their name is drawn. Reporting a *message* stays where it
 * is, with the message.
 *
 * Open to anybody signed in, like reporting a message: the check on a report is
 * that an administrator reads it, not that the reporter earned the right to
 * make it.
 */

import { requireUser } from "@/lib/session";
import { reportUser } from "@/lib/safety-queue";
import { userReportSchema } from "@polaris/core";

export async function reportPersonAction(input: unknown): Promise<{ error?: string }> {
    const user = await requireUser();
    const parsed = userReportSchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "That could not be read." };
    return reportUser(user.id, parsed.data);
}
