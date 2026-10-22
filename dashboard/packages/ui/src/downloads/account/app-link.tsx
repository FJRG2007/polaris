"use client";

/**
 * A link to a screen inside Polaris, from a component that is also drawn on
 * the public site. The dashboard links as it always did; the site, which has
 * no signed-in screens, maps each path to its own page or to nothing, and a
 * link with nowhere to go is drawn as its words.
 */

import Link from "next/link";
import { createContext, useContext, type AnchorHTMLAttributes, type ReactNode } from "react";

const AppHrefContext = createContext<(path: string) => string | null>((path) => path);

/** Where the in-app paths lead here; return null for "nowhere". */
export const AppHrefProvider = AppHrefContext.Provider;

export function AppLink({
    href,
    children,
    ...rest
}: Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> & {
    href: string;
    children: ReactNode;
}) {
    const to = useContext(AppHrefContext)(href);
    if (to === null) return <span>{children}</span>;
    return /^https?:/.test(to) ? (
        <a {...rest} href={to}>
            {children}
        </a>
    ) : (
        <Link {...rest} href={to}>
            {children}
        </Link>
    );
}
