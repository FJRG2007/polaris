// a document's share links. A route, not an action: see lib/poll-route.
import { z } from "zod";
import { pollRoute } from "@/lib/poll-route";
import { listLinksAction } from "@/app/(app)/office/link-actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = pollRoute(
    z.object({ documentId: z.string().trim().min(1).max(200) }),
    ({ documentId }) => listLinksAction(documentId)
);
