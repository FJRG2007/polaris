/**
 * The appearance of a page's worth of people, and what has changed since.
 *
 * Asked by the store the faces share, exactly as presence is: a screen mounts
 * thirty avatars, the ids are collected for a tick, and one request answers all
 * of them. Ids arrive from a browser, so at most a page-full, and an id that is
 * nobody gets a plain style back rather than an error - a face that has gone is
 * not an exception.
 *
 * With `since`, the same request becomes the revalidation: it answers only the
 * people who are different, so a browser can keep every face on it current
 * without ever reloading and without asking for anything it already has. That is
 * the whole scaling argument - the work is proportional to the faces being
 * looked at, not to the number of accounts, so a change by one person in a
 * million costs the people looking at that person and nobody else.
 *
 * `at` is the server's clock, and the browser sends it back as the next `since`.
 * Taken from here rather than from the browser because the two disagree, and a
 * browser running fast would ask about a window that had not happened yet and
 * miss everything in it.
 */

import { z } from "zod";
import { apiUser } from "@/lib/api-session";
import { MAX_PEOPLE_PER_STYLE_ASK } from "@polaris/core";
import {
    namesFor,
    nameChangesSince,
    stylesFor,
    styleChangesSince
} from "@/lib/profile-style-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** More than any one screen draws at once, and a ceiling on what one request can
 *  ask this to look up. Shared with the browser that does the asking, which cuts
 *  its list at the same number rather than being refused for a list too long. */
const MOST = MAX_PEOPLE_PER_STYLE_ASK;

const askSchema = z.object({
    ids: z.array(z.string().uuid()).max(MOST),
    /** When this browser last had an answer. Absent on the first ask. */
    since: z.string().datetime().optional(),
    /** Which of those it is currently drawing decorated - see `styleChangesSince`.
     *  Short by definition: it is the people who have chosen something. */
    styled: z.array(z.string().uuid()).max(MOST).optional()
});

export async function POST(request: Request): Promise<Response> {
    const viewer = await apiUser();
    if (viewer instanceof Response) return viewer;

    let body: unknown;
    try {
        body = await request.json();
    } catch {
        return Response.json({ error: "That could not be read" }, { status: 400 });
    }
    const asked = askSchema.safeParse(body);
    if (!asked.success) return Response.json({ error: "That could not be read" }, { status: 400 });

    const at = new Date();
    const { ids, since, styled } = asked.data;

    if (since) {
        const from = new Date(since);
        const [moved, names] = await Promise.all([
            styleChangesSince(ids, from, styled ?? []),
            nameChangesSince(ids, from)
        ]);
        return Response.json(
            {
                people: Object.fromEntries(moved.changed),
                // What they are called, which changes for the same reasons and is
                // drawn in the same places - see `namesFor`. No nicknames ride
                // with it: the browser holds those from its first answer and they
                // do not change because their subject renamed themselves.
                names: Object.fromEntries(names),
                cleared: moved.cleared,
                at: at.toISOString()
            },
            // Never cached: the whole point of this shape is that it is the
            // question "what is new", and an answer from a minute ago is the
            // wrong answer to it.
            { headers: { "Cache-Control": "no-store" } }
        );
    }

    const [found, live] = await Promise.all([stylesFor(ids), namesFor(viewer.id, ids)]);
    return Response.json(
        {
            people: Object.fromEntries(found),
            names: Object.fromEntries(live.names),
            // What this reader calls them, kept apart from what they call
            // themselves rather than merged over it: the two are different claims
            // and only the screen drawing them knows which one it may show. Sent
            // for everybody asked about, so a nickname taken off is an id missing
            // from here rather than one that lingers until a reload.
            nicknames: Object.fromEntries(live.called),
            cleared: [],
            at: at.toISOString()
        },
        { headers: { "Cache-Control": "private, max-age=120" } }
    );
}
