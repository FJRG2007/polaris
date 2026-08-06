"use client";

/**
 * What the rail is allowed to show for one organization.
 *
 * The rail is drawn by the app shell, which sits above every organization screen
 * in the tree and so cannot be handed anything by them. It knows the handle from
 * the path and nothing else - not the organization's name, and not whether the
 * person looking may define its roles or add its domains.
 *
 * So it asks, once per handle, and keeps the answer for the tab. Until it arrives
 * the rail draws only the entries everybody on a roster can open, which is what
 * stops a screen somebody cannot reach from flashing into the list and back out.
 * Nothing here is authorization: every one of those screens is enforced on the
 * server. This exists so a member is not shown three doors that are locked.
 */

import { useEffect, useState } from "react";
import { readSnapshot, writeSnapshot } from "@/lib/snapshot-cache";

export interface OrgNav {
    readonly name: string;
    readonly permissions: readonly string[];
    /** Whether this reader may end the organization. Separate from the
     *  permissions because deleting is not one - it belongs to the owner, the
     *  successor they named, and an instance administrator. */
    readonly canDelete: boolean;
}

/** A roster changes rarely and a role less often than that, so an answer stands
 *  for the tab's session - and a change to either reloads the page that made it. */
const MAX_AGE_MS = 30 * 60_000;

const key = (slug: string) => `org.nav:${slug}`;

export function useOrgNav(slug: string | null): OrgNav | null {
    const [nav, setNav] = useState<OrgNav | null>(() => (slug ? readSnapshot<OrgNav>(key(slug), MAX_AGE_MS)?.value ?? null : null));

    useEffect(() => {
        if (!slug) {
            setNav(null);
            return;
        }
        // Painted from the cache first so moving between the organization's own
        // screens never blinks the rail.
        setNav(readSnapshot<OrgNav>(key(slug), MAX_AGE_MS)?.value ?? null);

        const controller = new AbortController();
        void fetch(`/api/orgs/${encodeURIComponent(slug)}/nav`, { signal: controller.signal })
            .then(async (response) => {
                if (!response.ok) return;
                const body = (await response.json()) as Partial<OrgNav>;
                const value: OrgNav = {
                    name: typeof body.name === "string" ? body.name : slug,
                    permissions: Array.isArray(body.permissions) ? body.permissions.filter((p) => typeof p === "string") : [],
                    canDelete: body.canDelete === true
                };
                setNav(value);
                writeSnapshot(key(slug), value);
            })
            .catch(() => {
                // Offline, or an organization that is no longer this account's.
                // The baseline rail is still drawn and every screen still answers
                // for itself, so there is nothing useful to say here.
            });
        return () => controller.abort();
    }, [slug]);

    return nav;
}
