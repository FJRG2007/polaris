"use client";

/**
 * A link that fetches the screen behind it only when somebody shows they mean
 * to go there: the pointer on it, a finger on it, or keyboard focus.
 *
 * The router's default fetches every link the moment it scrolls into view, so a
 * reload of a screen with a long rail - every conversation, every app - was a
 * burst of one request per row before anybody had pressed anything. Turning
 * that off alone would also turn off the fetch on hover (`prefetch={false}`
 * disables both), and the press would then wait on the server; so the intent
 * is caught here and handed to `router.prefetch`. The router keeps one answer
 * per address, so passing back and forth over a row asks once.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { forwardRef, useCallback, type ComponentProps, type FocusEvent, type PointerEvent, type TouchEvent } from "react";

export interface IntentHandlers {
    onPointerEnter: () => void;
    onFocus: () => void;
    onTouchStart: () => void;
}

/** The handlers that fetch `href` on intent, for a link drawn by something else. */
export function useFetchOnIntent(): (href: string) => IntentHandlers {
    const router = useRouter();
    return useCallback(
        (href: string) => {
            const ask = () => router.prefetch(href);
            return { onPointerEnter: ask, onFocus: ask, onTouchStart: ask };
        },
        [router]
    );
}

type IntentLinkProps = Omit<ComponentProps<typeof Link>, "prefetch">;

/** `next/link`, fetched ahead on intent rather than on sight. */
export const IntentLink = forwardRef<HTMLAnchorElement, IntentLinkProps>(function IntentLink(
    { href, onPointerEnter, onFocus, onTouchStart, ...rest },
    ref
) {
    const intent = useFetchOnIntent();
    // An object href has no single address to fetch ahead; it is still a link.
    const ahead = typeof href === "string" ? intent(href) : null;
    return (
        <Link
            ref={ref}
            href={href}
            prefetch={false}
            onPointerEnter={(event: PointerEvent<HTMLAnchorElement>) => {
                ahead?.onPointerEnter();
                onPointerEnter?.(event);
            }}
            onFocus={(event: FocusEvent<HTMLAnchorElement>) => {
                ahead?.onFocus();
                onFocus?.(event);
            }}
            onTouchStart={(event: TouchEvent<HTMLAnchorElement>) => {
                ahead?.onTouchStart();
                onTouchStart?.(event);
            }}
            {...rest}
        />
    );
});
