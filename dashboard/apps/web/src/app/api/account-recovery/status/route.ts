// Where an account recovery request stands, asked again until it is decided. Asked before sign-in: the ticket is the proof, as in the action. A route, not an action: see lib/poll-route.
import { z } from "zod";
import { pollRoute } from "@/lib/poll-route";
import { recoveryStatusAction } from "@/app/oauth/recover/actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = pollRoute(
    z.object({ ticket: z.string().trim().min(1).max(200) }),
    ({ ticket }) => recoveryStatusAction(ticket),
    { signedIn: false }
);
