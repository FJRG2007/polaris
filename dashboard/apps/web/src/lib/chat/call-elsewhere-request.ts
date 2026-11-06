/**
 * Where this account's call is, asked from the browser.
 *
 * One function for the two places that ask - the card offering to move the call
 * here, and the ringing that has to stop once somebody answered on another
 * device - so the route and the shape it answers in are spelled once. It goes to
 * a route and not to a server action; `app/api/chat/meetings/elsewhere/route.ts`
 * says why.
 *
 * Every failure is "no call elsewhere": the card stays away and the ringing
 * carries on, which is what both did when the question could not be asked.
 */

import { z } from "zod";
// The shape from the module that defines it; only the type crosses over.
import type { CallElsewhere } from "@/lib/chat/meetings";

export const CALL_ELSEWHERE_PATH = "/api/chat/meetings/elsewhere";

const answerSchema = z.object({
    call: z
        .object({
            meetingId: z.string().min(1),
            channelId: z.string().min(1),
            participantId: z.string().min(1),
            title: z.string()
        })
        .nullable(),
    /** Calls this account declined on another device a moment ago. Absent from
     *  a server older than it. */
    declined: z.array(z.string().min(1).max(100)).max(50).optional()
});

export interface RingState {
    readonly call: CallElsewhere | null;
    readonly declined: readonly string[];
}

export async function askCallElsewhere(): Promise<CallElsewhere | null> {
    return (await askRingState())?.call ?? null;
}

/** The same question, with the calls declined elsewhere: what a ringing
 *  telephone asks, so it stops for a decline whose frame it never heard. */
export async function askRingState(): Promise<RingState | null> {
    try {
        const response = await fetch(CALL_ELSEWHERE_PATH, { cache: "no-store" });
        if (!response.ok) return null;
        const parsed = answerSchema.safeParse(await response.json());
        return parsed.success
            ? { call: parsed.data.call, declined: parsed.data.declined ?? [] }
            : null;
    } catch {
        return null;
    }
}
