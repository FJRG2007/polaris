// the signed-in accounts a connection can use. A route, not an action: see lib/poll-route.
import { z } from "zod";
import { pollRoute } from "@/lib/poll-route";
import { linkedAccountsAction } from "@/app/(app)/drive/actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = pollRoute(
    z.object({ provider: z.string().trim().min(1).max(200) }),
    ({ provider }) => linkedAccountsAction(provider)
);
