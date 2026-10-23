// Where the DNS blocker stands, asked when the screen opens and while it starts. A route, not an action: see lib/poll-route.
import { z } from "zod";
import { pollRoute } from "@/lib/poll-route";
import { dnsBlockerStatusAction } from "@/app/(app)/apps/network-filter/actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = pollRoute(z.object({}), () => dnsBlockerStatusAction());
