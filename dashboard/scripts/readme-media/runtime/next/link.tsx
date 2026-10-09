/** `next/link` as the anchor it renders, minus the prefetching. */

import { forwardRef, type AnchorHTMLAttributes, type ReactNode } from "react";

type Props = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> & {
    href: string | { pathname?: string; query?: Record<string, string> };
    prefetch?: boolean | null;
    replace?: boolean;
    scroll?: boolean;
    shallow?: boolean;
    children?: ReactNode;
};

const Link = forwardRef<HTMLAnchorElement, Props>(function Link(
    { href, prefetch, replace, scroll, shallow, onClick, ...rest },
    ref
) {
    void prefetch;
    void replace;
    void scroll;
    void shallow;
    const target =
        typeof href === "string"
            ? href
            : `${href.pathname ?? ""}${href.query ? `?${new URLSearchParams(href.query)}` : ""}`;
    return (
        <a
            ref={ref}
            href={target}
            onClick={(event) => {
                onClick?.(event);
                event.preventDefault();
            }}
            {...rest}
        />
    );
});

export default Link;
