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
import { Card, CardBody } from "@polaris/ui";
import { resolveSession } from "@/lib/session";
import { OrgProfileCard } from "./org-profile-card";
import { PublicShell } from "@/components/public-shell";
import { orgProfile, profilesArePublic } from "@/lib/profile-service";

export const dynamic = "force-dynamic";

/** The same title whether or not the organization exists: a page that named it
 *  in the tab before saying whether it would show it answers "does this handle
 *  exist" to anybody who asks. */
export const metadata: Metadata = { title: "Organization - Polaris" };

export default async function OrganizationPage({ params }: { params: Promise<{ slug: string }> }) {
    const { slug } = await params;
    const session = await resolveSession().catch(() => null);
    const viewer = session ? { id: session.id, isAdmin: Boolean(session.isAdmin) } : null;
    const org = await orgProfile(decodeURIComponent(slug), viewer);

    if (!org) {
        const closed = !viewer && !(await profilesArePublic());
        return (
            <PublicShell signedIn={viewer !== null}>
                <Card>
                    <CardBody className="flex flex-col gap-2 py-10 text-center">
                        <p className="text-sm font-medium">Nothing to show here</p>
                        <p className="text-muted-foreground mx-auto max-w-md text-sm">
                            {closed
                                ? "This Polaris does not show profiles to people who are not signed in."
                                : "There is no organization at this address."}
                        </p>
                    </CardBody>
                </Card>
            </PublicShell>
        );
    }

    return (
        <PublicShell signedIn={viewer !== null}>
            <OrgProfileCard org={org} />
        </PublicShell>
    );
}
