// what one address did over a window. A route, not an action: see lib/poll-route.
import { z } from "zod";
import { pollRoute } from "@/lib/poll-route";
import { getWafAddressActivityAction } from "@/app/(app)/apps/firewall/actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = pollRoute(
    z.object({ ip: z.string().trim().min(1).max(200), hours: z.coerce.number() }),
    ({ ip, hours }) => getWafAddressActivityAction(ip, hours)
);
