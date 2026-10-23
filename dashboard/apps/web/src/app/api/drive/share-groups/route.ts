// the groups an item can be shared with. A route, not an action: see lib/poll-route.
import { z } from "zod";
import { pollRoute } from "@/lib/poll-route";
import { myShareGroupsAction } from "@/app/(app)/drive/sharing-actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = pollRoute(z.object({}), () => myShareGroupsAction());
