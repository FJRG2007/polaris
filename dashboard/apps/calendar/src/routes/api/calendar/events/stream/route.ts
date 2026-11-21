/**
 * The word that an event or task in a calendar the reader can see changed,
 * pushed the moment any client changes it - an assistant's calendar tool, an
 * invitation answered, a Stream Deck key, another tab or device - so an open
 * calendar follows without a reload.
 *
 * A frame carries a sequence number and nothing else: the tab answers it by
 * reading its window from `/api/calendar/range` again, through the same session
 * and checks. Only a change to a calendar the reader reaches is delivered.
 */

import { wakeStream } from "../../../../../lib/wake-stream";
import { onCalendarChanged } from "../../../../../lib/live";
import { apiCalendarUser, reachableCalendars } from "../../../../../lib/access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
    // A non-200 makes EventSource give up rather than reconnect every few
    // seconds against a session that is gone.
    const user = await apiCalendarUser();
    if (user instanceof Response) return user;
    // Read once, when the stream opens: a calendar shared with the reader since
    // then is picked up on the next connection - every time the tab is looked at
    // again - rather than by a read per stream on every change somebody else
    // makes. Their own calendars are matched by owner, so one they created a
    // moment ago is followed at once.
    const reach = new Set((await reachableCalendars(user.id)).keys());

    return wakeStream(request, (wake) =>
        onCalendarChanged((change) => {
            if (change.ownerId === user.id || reach.has(change.calendarId)) wake();
        })
    );
}
