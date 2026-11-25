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

import { z } from "zod";
import { requireUser } from "@/lib/session";
import { reportUser } from "@/lib/safety-queue";
import { userReportSchema } from "@polaris/core";
import { firstIssue, localized } from "./security/action-messages";
import { DISCLOSURE_PATTERN } from "@/lib/chat/e2ee/sealed-report";
import { recentSealed, REPORT_CONTEXT } from "@/lib/chat/report-context";

/** A person report with the keys of their sealed lines it carries, by message id (docs/chat-e2ee-mls.md, "Sealed reports"). */
const sealedUserReportSchema = userReportSchema.extend({
    disclosures: z
        .record(z.string().uuid(), z.string().regex(DISCLOSURE_PATTERN))
        .refine((value) => Object.keys(value).length <= REPORT_CONTEXT)
        .optional()
});

/** Their sealed lines a report from this conversation would carry, so the browser can hand over their keys. None where the reporter cannot read it. */
export async function personReportSealedAction(input: unknown): Promise<{ ids: string[] }> {
    const user = await requireUser();
    const parsed = z.object({ subjectId: z.string().uuid(), channelId: z.string().uuid() }).strict().safeParse(input);
    if (!parsed.success) return { ids: [] };
    return { ids: await recentSealed({ id: user.id }, parsed.data.channelId, parsed.data.subjectId) };
}

export async function reportPersonAction(input: unknown): Promise<{ error?: string }> {
    const user = await requireUser();
    const parsed = sealedUserReportSchema.safeParse(input);
    if (!parsed.success) return firstIssue(parsed.error.issues, "errors.unreadable");
    return localized(await reportUser(user.id, parsed.data));
}
