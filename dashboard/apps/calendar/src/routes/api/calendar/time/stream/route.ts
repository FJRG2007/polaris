/**
 * The word that the reader's alarms, timers or stopwatch changed, pushed the
 * moment any client changes them - a Stream Deck key, Companion, an assistant's
 * tool, another tab or device - so an open Time screen follows without a reload.
 *
 * A frame carries a sequence number and nothing else: the tab answers it by
 * reading `/api/calendar/time` again, through the same session and checks.
 * Scoped to the session for the connection's whole life.
 */

import { apiCalendarUser } from "../../../../../lib/access";
import { wakeStream } from "../../../../../lib/wake-stream";
import { onClockChanged } from "../../../../../lib/clock/live";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
    // A non-200 makes EventSource give up rather than reconnect every few
    // seconds against a session that is gone.
    const user = await apiCalendarUser();
    if (user instanceof Response) return user;
    return wakeStream(request, (wake) =>
        onClockChanged((userId) => {
            if (userId === user.id) wake();
        })
    );
}
