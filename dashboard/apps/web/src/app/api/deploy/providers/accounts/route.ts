// the provider accounts one has linked. A route, not an action: see lib/poll-route.
import { z } from "zod";
import { pollRoute } from "@/lib/poll-route";
import { listProviderAccountsAction } from "@/app/(app)/apps/deploy/external-actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = pollRoute(z.object({}), () => listProviderAccountsAction());
