/** The check Next makes before running one of its own server actions: the
 *  request came from a page this server served, not from another site. */
export function sameOrigin(request: Request): boolean {
    const origin = request.headers.get("origin");
    if (!origin) return false;
    const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
    try {
        return new URL(origin).host === host;
    } catch {
        return false;
    }
}

/** A GET asked by a page this server served: a fetch from another site, or a
 *  link or form that navigates here from one, is refused. A same-origin GET
 *  carries no `Origin`, so the browser's `Sec-Fetch-Site` decides when sent. */
export function sameOriginRead(request: Request): boolean {
    const site = request.headers.get("sec-fetch-site");
    if (site) return site === "same-origin";
    return sameOrigin(request);
}
