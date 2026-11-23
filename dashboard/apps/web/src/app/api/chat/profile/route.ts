// a person's profile as a conversation shows it. A route, not an action: see lib/poll-route.
import { z } from "zod";
import { pollRoute } from "@/lib/poll-route";
import { profileAction } from "@/app/(app)/chat/actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = pollRoute(
    z.object({
        // The conversation it is asked through, or - for a meeting with no
        // conversation of its own - the meeting in its place.
        channelId: z.string().trim().max(200).default(""),
        meetingId: z.string().trim().min(1).max(200).optional(),
        userId: z.string().trim().min(1).max(200),
        // The larger view also asks what they did lately.
        recent: z.enum(["1"]).optional()
    }),
    ({ channelId, meetingId, userId, recent }) =>
        profileAction(channelId, userId, recent === "1", meetingId)
);
