// one trusted device's detail. A route, not an action: see lib/poll-route.
import { z } from "zod";
import { pollRoute } from "@/lib/poll-route";
import { trustedDeviceAction } from "@/app/(app)/account/sessions/actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = pollRoute(
    z.object({ deviceId: z.string().trim().min(1).max(200) }),
    ({ deviceId }) => trustedDeviceAction(deviceId)
);
