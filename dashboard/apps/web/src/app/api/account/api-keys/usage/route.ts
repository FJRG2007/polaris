// what an API key was used for over a range. A route, not an action: see lib/poll-route.
import { z } from "zod";
import { pollRoute } from "@/lib/poll-route";
import { keyUsageAction } from "@/app/(app)/account/api-keys/usage-actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = pollRoute(
    z.object({
        keyId: z.string().trim().min(1).max(200),
        range: z.string().trim().min(1).max(200)
    }),
    ({ keyId, range }) => keyUsageAction({ keyId, range })
);
