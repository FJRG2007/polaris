// where and when an item was used. A route, not an action: see lib/poll-route.
import { z } from "zod";
import { pollRoute } from "@/lib/poll-route";
import { itemUsesAction } from "@/app/(app)/vault/vault-actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = pollRoute(
    z.object({ itemId: z.string().trim().min(1).max(200) }),
    ({ itemId }) => itemUsesAction(itemId)
);
