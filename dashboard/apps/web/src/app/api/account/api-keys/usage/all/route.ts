// what every API key of the account was used for over a range. A route, not an action: see lib/poll-route.
import { z } from "zod";
import { pollRoute } from "@/lib/poll-route";
import { accountUsageAction } from "@/app/(app)/account/api-keys/usage-actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = pollRoute(z.object({ range: z.string().trim().min(1).max(200) }), ({ range }) =>
    accountUsageAction({ range })
);
