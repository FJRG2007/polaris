/**
 * Where Cloud servers lives, and where its accounts are connected: the
 * connections hub, pointed at this app's section, with the way back here.
 * Plain values, shared by the server page and the browser screens.
 */

export const CLOUD_PAGE = "/apps/servers/cloud";

export const CONNECT_HREF = `/account/connections?${new URLSearchParams({
    provider: "cloud-servers",
    return: CLOUD_PAGE
}).toString()}`;

/** What a path under the page is: the screen, the old Connect link, or nothing. */
export function cloudPathTarget(path: string[] | string | undefined): "screen" | "connect" | null {
    if (path === undefined || (Array.isArray(path) && path.length === 0)) return "screen";
    if (Array.isArray(path) && path.length === 1 && path[0] === "connect") return "connect";
    return null;
}
