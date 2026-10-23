// the organizations a notebook can belong to. A route, not an action: see lib/poll-route.
import { z } from "zod";
import { pollRoute } from "@/lib/poll-route";
import { noteSpaceOwnersAction } from "@/app/(app)/notes/actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = pollRoute(z.object({}), () => noteSpaceOwnersAction());
