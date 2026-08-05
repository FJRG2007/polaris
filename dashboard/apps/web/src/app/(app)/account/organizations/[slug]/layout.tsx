/**
 * The frame every one of an organization's screens is drawn in.
 *
 * It carries the identity - photo, name, handle, and what the reader is here as -
 * so the rail's contents and the heading above them always agree about which
 * organization is open. Wrapping it here rather than repeating it per page is
 * also what keeps it from flickering as somebody moves between People and Teams:
 * the frame is not re-rendered, only what sits inside it.
 *
 * Access is resolved here as well as in each page. That is not duplication - a
 * layout cannot hand anything to the pages under it, and a page that trusted its
 * parent to have checked would be one refactor away from being open.
 */

import Link from "next/link";
import { Badge } from "@polaris/ui";
import type { ReactNode } from "react";
import { OrgAvatar } from "@/components/avatar";
import { requireOrgPage } from "@/lib/orgs/page-access";

export const dynamic = "force-dynamic";

export default async function OrganizationLayout({
    children,
    params
}: {
    children: ReactNode;
    params: Promise<{ slug: string }>;
}) {
    const { slug } = await params;
    const { org, access } = await requireOrgPage(slug);

    return (
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-5">
            <header className="flex items-start gap-3">
                <OrgAvatar org={org} size={44} />
                <div className="min-w-0 flex-1">
                    <h1 className="flex flex-wrap items-center gap-2 text-lg font-semibold">
                        <span className="truncate" title={org.name}>
                            {org.name}
                        </span>
                        <Badge variant={access.isOwner ? "primary" : "neutral"}>{access.roleName}</Badge>
                    </h1>
                    <p className="text-muted-foreground truncate text-sm">
                        {/* The handle is what a link to this organization is built
                            from, so it is shown rather than only lived in the URL. */}
                        <Link href={`/account/organizations/${org.slug}`} className="hover:text-foreground">
                            @{org.slug}
                        </Link>
                        {org.description ? ` - ${org.description}` : ""}
                    </p>
                </div>
            </header>
            {children}
        </div>
    );
}
