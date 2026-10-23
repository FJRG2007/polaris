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
import { sameOrigin, sameOriginRead } from "@/lib/same-origin";

const NO_STORE = { "cache-control": "no-store" };

/**
 * A GET handler that validates the query against `query` and answers `read`.
 * `sameOrigin` refuses another site's request, for a read that reveals a secret
 * or leaves a record, as an action's POST was refused.
 */
export function pollRoute<Q extends z.ZodTypeAny>(
    query: Q,
    read: (input: z.infer<Q>) => Promise<unknown>,
    options: { signedIn?: boolean; sameOrigin?: boolean } = {}
): (request: Request) => Promise<Response> {
    return async (request) => {
        // i18n-ignore: status bodies no screen shows; the caller keeps what it had
        if (options.sameOrigin && !sameOriginRead(request))
            return NextResponse.json({ error: "Forbidden" }, { status: 403, headers: NO_STORE });
        // i18n-ignore: status bodies no screen shows; the caller keeps what it had
        if (options.signedIn !== false && !(await backgroundUser()))
            return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: NO_STORE });
        const params = Object.fromEntries(new URL(request.url).searchParams);
        return answer(request, query.safeParse(params), read);
    };
}

/**
 * A POST handler for a press that has to work in a tab older than the server:
 * joining a call is one, and a Join that waits on an action id the server no
 * longer knows, or behind a navigation in Next's action queue, says "Going in"
 * for as long as the tab is open. Validates the JSON body against `body` and
 * answers `run`; refuses another origin, as Next does for its own actions.
 */
export function actionRoute<B extends z.ZodTypeAny>(
    body: B,
    run: (input: z.infer<B>) => Promise<unknown>,
    options: { signedIn?: boolean } = {}
): (request: Request) => Promise<Response> {
    return async (request) => {
        // i18n-ignore: status bodies no screen shows; the caller says it failed
        if (!sameOrigin(request))
            return NextResponse.json({ error: "Forbidden" }, { status: 403, headers: NO_STORE });
        // i18n-ignore: as above
        if (options.signedIn !== false && !(await backgroundUser()))
            return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: NO_STORE });
        const text = await request.text().catch(() => "");
        let json: unknown = null;
        try {
            json = text.length <= MAX_ACTION_BODY ? JSON.parse(text) : null;
        } catch {
            json = null;
        }
        return answer(request, body.safeParse(json), run);
    };
}

/** Far more than any of these presses sends; Next's own limit for an action is 1 MB. */
const MAX_ACTION_BODY = 64 * 1024;

async function answer<T>(
    request: Request,
    parsed: { success: true; data: T } | { success: false },
    run: (input: T) => Promise<unknown>
): Promise<Response> {
    // i18n-ignore: as above
    if (!parsed.success)
        return NextResponse.json({ error: "Bad request" }, { status: 400, headers: NO_STORE });
    try {
        const value = await run(parsed.data);
        return NextResponse.json({ value: toWire(value) }, { headers: NO_STORE });
    } catch (caught) {
        // The action sends somebody without the permission away; a fetch
        // cannot follow that anywhere useful, so it is a refusal here.
        // i18n-ignore: as above
        if (isRedirectError(caught))
            return NextResponse.json({ error: "Forbidden" }, { status: 403, headers: NO_STORE });
        console.error(`polaris: a route action failed (${new URL(request.url).pathname}):`, caught);
        // i18n-ignore: as above
        return NextResponse.json({ error: "Failed" }, { status: 500, headers: NO_STORE });
    }
}

/** A query parameter carrying JSON, for a read whose action takes an object;
 *  pipe it into that object's own schema. */
export const jsonParam = z
    .string()
    .max(8192)
    .transform((text, context) => {
        try {
            return JSON.parse(text) as unknown;
        } catch {
            context.addIssue({ code: z.ZodIssueCode.custom, message: "Not JSON" });
            return z.NEVER;
        }
    });

/** A query parameter carrying a comma-separated list. */
export const listParam = z.string().transform((text) => (text ? text.split(",") : []));
