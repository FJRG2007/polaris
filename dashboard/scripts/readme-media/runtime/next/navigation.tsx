/** `next/navigation` for a page with no router: the scene's path, and a router
 *  that records where it was asked to go instead of going. */

import { scenePath } from "../route";

/** One router for the page, as Next's own is: a screen that lists the router
 *  among an effect's dependencies would otherwise run that effect on every
 *  render, and one that sets state there never stops. */
const router = {
    push: (href: string) => scenePath.navigate(href),
    replace: (href: string) => scenePath.navigate(href),
    refresh: () => undefined,
    back: () => undefined,
    forward: () => undefined,
    prefetch: () => undefined
};

export function useRouter() {
    return router;
}

export function usePathname(): string {
    return scenePath.current().split("?")[0] ?? "/";
}

export function useSearchParams(): URLSearchParams {
    return new URLSearchParams(scenePath.current().split("?")[1] ?? "");
}

export function useParams(): Record<string, string> {
    return scenePath.params();
}

export function useSelectedLayoutSegment(): string | null {
    return null;
}

export function notFound(): never {
    throw new Error("notFound() in a README scene");
}

export function redirect(href: string): never {
    throw new Error(`redirect(${href}) in a README scene`);
}

export const RedirectType = { push: "push", replace: "replace" } as const;
export function unstable_rethrow(): void {}
