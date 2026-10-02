/**
 * The reader's alarms, timers and stopwatch, for the header's indicator and the
 * ring that sounds in any open tab. One small read: a few dozen rows at most.
 */

import { apiCalendarUser } from "../../../../lib/access";
import { clockSnapshot } from "../../../../lib/clock/service";

export async function GET(): Promise<Response> {
    const user = await apiCalendarUser();
    if (user instanceof Response) return user;
    try {
        return Response.json(await clockSnapshot(user.id), {
            headers: { "cache-control": "no-store" }
        });
    } catch (caught) {
        console.error("polaris: the Time area could not be read:", caught);
        return Response.json({ error: "unavailable" }, { status: 500 });
    }
}
