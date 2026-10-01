"use server";

/** Answering an invitation from its link. No session: the token is the right
 *  to answer for the one address it was sent to. Rate limited per address and
 *  per link. */

import * as rsvp from "../lib/rsvp";
import { outcome, type Outcome } from "../lib/outcome";
import { refusedInput } from "../lib/scheduling-guard";
import { rsvpInputSchema } from "../lib/scheduling-schemas";

export async function answerInvitationAction(input: unknown): Promise<Outcome<object>> {
    const parsed = rsvpInputSchema.safeParse(input);
    if (!parsed.success) return refusedInput(parsed.error.issues);
    return outcome(async () => {
        await rsvp.answerByToken(parsed.data);
        return {};
    });
}
