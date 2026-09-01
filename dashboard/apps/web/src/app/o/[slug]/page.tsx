/**
 * An organization's page, at an address that can be handed out: `/o/<slug>`.
 *
 * Beside `/u/<username>` and drawn in the same frame, because they are the same
 * kind of thing: a handle on this Polaris addresses a page, and whether it
 * belongs to a person or to a company is a fact about the page rather than about
 * the address. The two share one namespace - an organization cannot take a
 * handle somebody signs in with - so the prefixes are a convenience, not what
 * keeps them apart.
 *
 * Whether a signed-out reader is shown anything is the operator's setting, the
 * same one that governs a person's page.
 */

import type { Metadata } from "next";
import { guardedUser } from "@/lib/session";
import { OrgProfileCard } from "./org-profile-card";
import { orgProfile, profilesArePublic } from "@/lib/profile-service";
import { NothingToShow, ProfileFrame } from "@/components/profile-frame";

export const dynamic = "force-dynamic";

/** The same title whether or not the organization exists: a page that named it
 *  in the tab before saying whether it would show it answers "does this handle
 *  exist" to anybody who asks. */
export const metadata: Metadata = { title: "Organization - Polaris" };

export default async function OrganizationPage({ params }: { params: Promise<{ slug: string }> }) {
    const { slug } = await params;
    const viewer = await guardedUser().catch(() => null);
    const org = await orgProfile(
        decodeURIComponent(slug),
        viewer ? { id: viewer.id, isAdmin: viewer.isAdmin } : null
    );

    if (!org) {
        const closed = !viewer && !(await profilesArePublic());
        return (
            <ProfileFrame viewer={viewer}>
                <NothingToShow closed={closed} subject="organization" />
            </ProfileFrame>
        );
    }

    return (
        <ProfileFrame viewer={viewer}>
            <OrgProfileCard org={org} />
        </ProfileFrame>
    );
}
