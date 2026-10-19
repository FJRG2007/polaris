// A mail server's overview, asked again while it starts or changes. A route, not an action: see lib/poll-route.
import { z } from "zod";
import { pollRoute } from "@/lib/poll-route";
import { serverDetailAction } from "@/app/(app)/apps/mail-server/actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = pollRoute(
    z.object({ serverId: z.string().trim().min(1).max(100) }),
    ({ serverId }) => serverDetailAction(serverId)
);
