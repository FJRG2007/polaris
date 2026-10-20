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
