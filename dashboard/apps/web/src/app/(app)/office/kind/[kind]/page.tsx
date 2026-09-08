/**
 * One kind of thing, on its own.
 *
 * A single route rather than five files, because they differ only in which kind
 * they narrow to - and that is data. A path naming anything else is a 404 rather
 * than an empty list pretending to be a real screen.
 */

import * as core from "@polaris/core";
import { notFound } from "next/navigation";
import { OfficeView } from "../../office-view";
import { requirePermission } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function OfficeKindPage({ params }: { params: Promise<{ kind: string }> }) {
    await requirePermission("office.use");
    const { kind } = await params;
    if (!core.isOfficeKind(kind)) notFound();
    return (
        <OfficeView
            shelf="live"
            kind={kind}
            starredOnly={false}
            sharedOnly={false}
            title={`${core.OFFICE_KIND_LABELS[kind]}s`}
            description={core.OFFICE_KIND_HINTS[kind]}
        />
    );
}
