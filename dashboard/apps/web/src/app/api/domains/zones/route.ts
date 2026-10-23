// the DNS zones the provider token reaches. A route, not an action: see lib/poll-route.
import { z } from "zod";
import { pollRoute } from "@/lib/poll-route";
import { listDnsZonesAction } from "@/app/(app)/account/domains/dns-actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = pollRoute(z.object({}), () => listDnsZonesAction());
