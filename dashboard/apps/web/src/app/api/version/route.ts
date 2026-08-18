/**
 * Which build is being served right now, as an opaque stamp.
 *
 * Polled by every open tab so an update is noticed before a click is refused by a
 * server that has never heard of this bundle's action ids (see lib/new-build).
 *
 * No session: a poll on a timer should not cost a session lookup, and the answer
 * carries nothing that has to be guarded (see lib/build-stamp).
 *
 * Named `version` rather than `build` because the repository ignores any folder
 * called `build`, so the route existed here, worked here, and 404'd on every
 * deployment - it was never in the image.
 */

import { NextResponse } from "next/server";
import { buildStamp } from "@/lib/build-stamp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** During a no-downtime rollover the old and the new container both serve for a
 *  few seconds, so this answers with whichever one took the request - which is
 *  what lets a tab learn about the update at all. */
export function GET(): Response {
    return NextResponse.json({ build: buildStamp() }, { headers: { "cache-control": "no-store" } });
}
