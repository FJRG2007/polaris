// a note's public link, if it has one. A route, not an action: see lib/poll-route.
import { z } from "zod";
import { pollRoute } from "@/lib/poll-route";
import { noteShareAction } from "@/app/(app)/notes/actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = pollRoute(
    z.object({ noteId: z.string().trim().min(1).max(200) }),
    ({ noteId }) => noteShareAction(noteId)
);
