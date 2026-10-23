// who opened a snippet. A route, not an action: see lib/poll-route.
import { z } from "zod";
import { pollRoute } from "@/lib/poll-route";
import { getSnippetLogsAction } from "@/app/(app)/drive/snippets/snippet-actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = pollRoute(
    z.object({ snippetId: z.string().trim().min(1).max(200) }),
    ({ snippetId }) => getSnippetLogsAction(snippetId)
);
