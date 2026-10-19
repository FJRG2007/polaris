// Whether each listed tunnel is up, asked again while the page is open. A route, not an action: see lib/poll-route.
import { z } from "zod";
import { listParam, pollRoute } from "@/lib/poll-route";
import { tunnelStatusesAction } from "@/app/(app)/apps/tunnels/actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = pollRoute(
    z.object({ ids: listParam.pipe(z.array(z.string().uuid()).min(1).max(200)) }),
    ({ ids }) => tunnelStatusesAction({ ids })
);
