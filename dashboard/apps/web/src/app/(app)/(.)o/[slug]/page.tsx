/**
 * An organization's page, followed from inside Polaris - drawn in this layout so
 * the call this tab is in carries on; see `(.)u/[username]`.
 */

import type { Metadata } from "next";
import { guardedUser } from "@/lib/session";
import { OrgBody } from "@/app/o/[slug]/org-body";
import { getTranslations } from "@/lib/i18n/request";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
    return { title: (await getTranslations("publicPages"))("org.metaTitle") };
}

export default async function OrganizationInApp({ params }: { params: Promise<{ slug: string }> }) {
    const { slug } = await params;
    const viewer = await guardedUser().catch(() => null);
    return (
        <div className="mx-auto w-full max-w-2xl">
            <OrgBody slug={slug} viewer={viewer} />
        </div>
    );
}
