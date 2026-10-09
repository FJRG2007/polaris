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
import { getTranslations } from "@/lib/i18n/request";
import { ProfileFrame } from "@/components/profile-frame";
import { OrgBody } from "./org-body";

export const dynamic = "force-dynamic";

/** The same title whether or not the organization exists: a page that named it
 *  in the tab before saying whether it would show it answers "does this handle
 *  exist" to anybody who asks. */
export async function generateMetadata(): Promise<Metadata> {
    return { title: (await getTranslations("publicPages"))("org.metaTitle") };
}

export default async function OrganizationPage({ params }: { params: Promise<{ slug: string }> }) {
    const { slug } = await params;
    const viewer = await guardedUser().catch(() => null);
    return (
        <ProfileFrame viewer={viewer}>
            <OrgBody slug={slug} viewer={viewer} />
        </ProfileFrame>
    );
}
