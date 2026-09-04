/**
 * Who is asking, when the answer has to be an answer.
 *
 * `requireUser` and its siblings redirect. That is right for a page - somebody
 * whose session ended should land on the sign-in screen - and it is wrong for
 * everything under `/api`, because a redirect to an HTML page is what a browser
 * follows and then saves.
 *
 * That is not hypothetical. The Download button on a backup handed people a file
 * called `login.htm`: the session had ended, the route redirected, the browser
 * followed it because the link said `download`, and what landed in their
 * Downloads folder was the sign-in page with the backup's name nowhere near it.
 * A `fetch` in the same position gets HTML where it expected JSON and reports a
 * parse error, which is the same defect wearing a different hat.
 *
 * So an API route asks here instead. The refusal is a status the caller can read
 * - 401 when there is nobody, 403 when there is somebody who may not - and the
 * screen decides what to say about it.
 *
 * The check itself is the same one the pages run, guards and all: this only
 * changes what a refusal looks like on the wire.
 */

import { NextResponse } from "next/server";
import type { Permission } from "@polaris/core";
import { guardedUser, sessionCan, type SessionUser } from "@/lib/session";

/** No session at all, or one a guard has ended. Deliberately says nothing about
 *  which: a caller that is signed out gets the same answer either way. */
function unauthorized(): NextResponse {
    return NextResponse.json({ error: "Sign in to continue" }, { status: 401 });
}

/** Somebody real, who may not have this. */
function forbidden(): NextResponse {
    return NextResponse.json({ error: "You do not have access to that" }, { status: 403 });
}

/**
 * The caller, or the response to send instead.
 *
 * Written as a union rather than a throw so the check is visible in the route:
 * `if (user instanceof Response) return user;` is one line, it is impossible to
 * forget without the types complaining, and nothing about the handler's shape
 * has to change around it.
 */
export type ApiCaller = SessionUser | NextResponse;

export async function apiUser(): Promise<ApiCaller> {
    return (await guardedUser()) ?? unauthorized();
}

export async function apiAdmin(): Promise<ApiCaller> {
    const user = await guardedUser();
    if (!user) return unauthorized();
    return user.isAdmin ? user : forbidden();
}

export async function apiPermission(permission: Permission): Promise<ApiCaller> {
    const user = await guardedUser();
    if (!user) return unauthorized();
    return (await sessionCan(user, permission)) ? user : forbidden();
}
