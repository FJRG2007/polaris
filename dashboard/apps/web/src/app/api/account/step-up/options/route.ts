// the ways one can confirm it is them. A route, not an action: see lib/poll-route.
import { z } from "zod";
import { pollRoute } from "@/lib/poll-route";
import { stepUpOptionsAction } from "@/app/(app)/account/step-up-actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = pollRoute(z.object({}), () => stepUpOptionsAction());
