/**
 * The login handoff's redirects, written the one way both listeners need.
 *
 * `no-store` is the point. A redirect with no caching header is still stored by the
 * browser, and a tab reopened the next day - restored after a restart, or woken from
 * a discarded state - is loaded preferring that cache without asking again. It then
 * replays yesterday's hops: the app's bounce to Polaris, and Polaris's bounce back
 * carrying a token that expired overnight, round and round until the browser gives
 * up with "redirected you too many times". A reload asks the network, which is why
 * it always worked. Nothing on this path is ever worth replaying.
 */

import type { ServerResponse } from "node:http";

export function sendRedirect(res: ServerResponse, location: string, setCookie?: string): void {
    const headers: Record<string, string> = { location, "cache-control": "no-store" };
    if (setCookie) headers["set-cookie"] = setCookie;
    res.writeHead(302, headers);
    res.end();
}
