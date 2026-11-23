/**
 * Carry the cookies a better-auth endpoint called from a server action set
 * (`returnHeaders: true`) onto that action's response, the way better-auth's
 * own `nextCookies` plugin does. A route that rotates the session - removing a
 * second factor - otherwise leaves the browser on the session it just ended.
 */

import { cookies } from "next/headers";
import { parseSetCookieHeader, toCookieOptions } from "better-auth/cookies";

export async function forwardAuthCookies(returned: Headers): Promise<void> {
    const setCookie = returned.get("set-cookie");
    if (!setCookie) return;
    const store = await cookies();
    parseSetCookieHeader(setCookie).forEach((value, name) => {
        if (name) store.set(name, value.value, toCookieOptions(value));
    });
}
