/** The route a scene stands at, for the `next/navigation` shim. */

let path = "/";
let params: Record<string, string> = {};
const navigations: string[] = [];

export const scenePath = {
    set(next: string, nextParams: Record<string, string> = {}) {
        path = next;
        params = nextParams;
    },
    current: () => path,
    params: () => params,
    /** A scene never leaves its screen; where it was sent is kept for a test. */
    navigate(href: string) {
        navigations.push(href);
    },
    navigations: () => [...navigations]
};
