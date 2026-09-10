"use client";

/**
 * The organization's history: its roster, its roles, its teams and its work.
 *
 * Narrowed, paged and exported through the same feed every audit screen uses, so
 * "what has Ana done here since Monday" is a link somebody can hand on, and the
 * whole history - member joins, role changes, removals - is a file whoever may
 * read it can take.
 */

import { AuditFeed } from "@/components/audit-feed";

export function ActivityView({ slug }: { slug: string }) {
    const base = `/api/orgs/${encodeURIComponent(slug)}/activity`;
    return (
        <AuditFeed
            endpoint={base}
            exportEndpoint={`${base}/export`}
            path={`/account/organizations/${slug}/activity`}
            cacheKey={`org.activity:${slug}`}
            contextLabel="Who"
            emptyLabel="Nothing has been done here yet."
            context={(entry) => entry.actorName}
        />
    );
}
