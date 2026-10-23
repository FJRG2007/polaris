// whether to offer the overview tour. A route, not an action: see lib/poll-route.
import { z } from "zod";
import { pollRoute } from "@/lib/poll-route";
import { shouldOfferOverviewAction } from "@/app/(app)/tour-actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = pollRoute(z.object({}), () => shouldOfferOverviewAction(), { signedIn: false });
