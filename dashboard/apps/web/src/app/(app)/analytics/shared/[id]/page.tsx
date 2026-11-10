/**
 * Analytics, a shared site (/analytics/shared/<id>): where the "shared with you"
 * list sends somebody. A grant names a service, or - for Polaris itself and a
 * site run elsewhere - the site's own record, and only a read tells the two
 * apart, so this resolves the id and moves on to the site's own address. Whether
 * the reader may open it is decided there, by the read itself.
 */

import { prisma } from "@polaris/db";
import { notFound, redirect } from "next/navigation";
import { requireAnalyticsReader } from "@/app/(app)/analytics/reader";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function AnalyticsSharedSitePage({ params }: { params: Promise<{ id: string }> }) {
    await requireAnalyticsReader();
    const { id } = await params;
    if (!UUID.test(id)) notFound();
    const [application, site] = await Promise.all([
        prisma.application.findUnique({ where: { id }, select: { id: true } }),
        prisma.analyticsSite.findUnique({ where: { id }, select: { scopeType: true, scopeId: true } })
    ]);
    if (application) redirect(`/analytics?scope=application&id=${encodeURIComponent(id)}`);
    if (site?.scopeType === "polaris") redirect("/analytics?scope=polaris");
    if (site?.scopeType === "external") redirect(`/analytics?scope=external&id=${encodeURIComponent(site.scopeId)}`);
    notFound();
}
