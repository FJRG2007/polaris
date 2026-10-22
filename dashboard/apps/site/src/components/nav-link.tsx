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
    section,
    except,
    children
}: {
    href: string;
    className: string;
    /** Also current on every page under this one ("docs/" for each guide). */
    section?: boolean;
    /** A page under it that has its own entry in the bar. */
    except?: string;
    children: ReactNode;
}) {
    const path = trim(usePathname() ?? "");
    const current =
        path === trim(href) ||
        (section === true &&
            path.startsWith(`${trim(href)}/`) &&
            (!except || !path.startsWith(trim(except))));
    return (
        <Link href={href} className={className} aria-current={current ? "page" : undefined}>
            {children}
        </Link>
    );
}
