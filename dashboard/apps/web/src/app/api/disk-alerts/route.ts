// the disks running out of room, asked again on a timer. A route, not an action: see lib/poll-route.
import { z } from "zod";
import { pollRoute } from "@/lib/poll-route";
import { diskAlertsAction } from "@/app/(app)/disk-alert-actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = pollRoute(z.object({}), () => diskAlertsAction(), { signedIn: false });
