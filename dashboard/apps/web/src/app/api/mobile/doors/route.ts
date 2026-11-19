/**
 * GET /api/mobile/doors - the doors this person can open, for the phone's
 * home-screen widget: its picker, and the state it draws. `?deviceId=` reads one.
 */

import { z } from "zod";
import { apiPermission } from "@/lib/api-session";
import { doorsFor, phoneCaller } from "@/lib/mobile/door-widget";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const query = z.object({ deviceId: z.string().uuid().optional() });

export async function GET(request: Request): Promise<Response> {
    const user = await apiPermission("home.read");
    if (user instanceof Response) return user;
    const asked = query.safeParse(Object.fromEntries(new URL(request.url).searchParams));
    if (!asked.success) return Response.json({ doors: [] }, { status: 400 });
    const doors = await doorsFor(await phoneCaller(user), asked.data.deviceId);
    return Response.json(
        { places: doors !== null, doors: doors ?? [] },
        { headers: { "Cache-Control": "no-store" } }
    );
}
