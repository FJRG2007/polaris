/**
 * A read the browser repeats on a timer, answered by a route.
 *
 * A tab stays open across Polaris updates, and a server action is addressed by
 * an id only the build that served the page knows: after an update every timed
 * ask failed until a reload, and the screen froze on what it last heard. A
 * route's path is the same in every build. Server actions from one tab also run
 * one at a time, so a poll as an action held up every other action the screen
 * sent, navigation included.
 *
 * Each route runs the server action it replaces, so the permission, the
 * validation and the answer stay exactly what they were. The answer travels in
 * the wire format the app bundles use (`toWire`), which keeps a `Date` a `Date`,
 * the way Next's own action format did. Read it with `readPoll`.
 */

import { z } from "zod";
import { NextResponse } from "next/server";
import { isRedirectError } from "next/dist/client/components/redirect-error";
import { backgroundUser } from "@/lib/session";
import { toWire } from "@/lib/app-bundles/wire";

const NO_STORE = { "cache-control": "no-store" };

/** A GET handler that validates the query against `query` and answers `read`. */
export function pollRoute<Q extends z.ZodTypeAny>(
    query: Q,
    read: (input: z.infer<Q>) => Promise<unknown>,
    options: { signedIn?: boolean } = {}
): (request: Request) => Promise<Response> {
    return async (request) => {
        // i18n-ignore: status bodies no screen shows; the caller keeps what it had
        if (options.signedIn !== false && !(await backgroundUser()))
            return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: NO_STORE });
        const params = Object.fromEntries(new URL(request.url).searchParams);
        const parsed = query.safeParse(params);
        // i18n-ignore: as above
        if (!parsed.success)
            return NextResponse.json({ error: "Bad request" }, { status: 400, headers: NO_STORE });
        try {
            const value = await read(parsed.data);
            return NextResponse.json({ value: toWire(value) }, { headers: NO_STORE });
        } catch (caught) {
            // The action sends somebody without the permission away; a fetch
            // cannot follow that anywhere useful, so it is a refusal here.
            // i18n-ignore: as above
            if (isRedirectError(caught))
                return NextResponse.json(
                    { error: "Forbidden" },
                    { status: 403, headers: NO_STORE }
                );
            console.error(
                `polaris: a timed read failed (${new URL(request.url).pathname}):`,
                caught
            );
            // i18n-ignore: as above
            return NextResponse.json({ error: "Failed" }, { status: 500, headers: NO_STORE });
        }
    };
}
