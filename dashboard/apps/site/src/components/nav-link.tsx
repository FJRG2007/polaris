"use client";

/**
 * A link in the site's bar that marks itself as the page being read, since the
 * shell around it is shared by every page and does not know which one is open.
 */

import Link from "next/link";
import type { ReactNode } from "react";
import { usePathname } from "next/navigation";

const trim = (path: string) => path.replace(/\/+$/, "");

export function NavLink({
    href,
    className,
    children
}: {
    href: string;
    className: string;
    children: ReactNode;
}) {
    const current = trim(usePathname() ?? "") === trim(href);
    return (
        <Link href={href} className={className} aria-current={current ? "page" : undefined}>
            {children}
        </Link>
    );
}
