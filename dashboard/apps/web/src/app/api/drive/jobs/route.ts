// the drive's running jobs, asked again while any runs. A route, not an action: see lib/poll-route.
import { z } from "zod";
import { pollRoute } from "@/lib/poll-route";
import { driveJobsAction } from "@/app/(app)/drive/actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = pollRoute(
    z.object({
        connectionId: z.string().trim().min(1).max(200).optional(),
        folder: z.string().max(4096).optional()
    }),
    ({ connectionId, folder }) => driveJobsAction(connectionId, folder)
);
