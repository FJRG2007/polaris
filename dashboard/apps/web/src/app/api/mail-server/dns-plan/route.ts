// the DNS records a mail domain needs. A route, not an action: see lib/poll-route.
import { z } from "zod";
import { jsonParam, pollRoute } from "@/lib/poll-route";
import { planDnsAction } from "@/app/(app)/apps/mail-server/actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = pollRoute(z.object({ input: jsonParam }), ({ input }) => planDnsAction(input));
