// a page of an account's Google files. A route, not an action: see lib/poll-route.
import { z } from "zod";
import { jsonParam, pollRoute } from "@/lib/poll-route";
import { listGoogleFilesAction } from "@/app/(app)/office/google-actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = pollRoute(z.object({ input: jsonParam }), ({ input }) =>
    listGoogleFilesAction(input)
);
