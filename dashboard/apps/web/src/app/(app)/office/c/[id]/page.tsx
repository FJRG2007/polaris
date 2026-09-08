/**
 * One comparison, open.
 *
 * The same chrome every other kind gets, with the table under it.
 */

import * as core from "@polaris/core";
import { notFound } from "next/navigation";
import * as office from "@/lib/office/documents";
import { requirePermission } from "@/lib/session";
import { ComparisonEditor } from "./comparison-editor";
import { DocumentChrome } from "@/app/(app)/office/document-chrome";

export const dynamic = "force-dynamic";

export default async function OfficeComparisonPage({ params }: { params: Promise<{ id: string }> }) {
    const user = await requirePermission("office.use");
    const { id } = await params;
    const found = await office.readDocument({ id: user.id }, id);
    if (!found || found.view.kind !== "comparison") notFound();
    await office.touchDocument({ id: user.id }, id);

    return (
        <DocumentChrome document={found.view} role={found.access.role} owned={found.access.owned}>
            <ComparisonEditor
                documentId={id}
                content={found.content ? Array.from(found.content) : null}
                editable={core.officeRoleAtLeast(found.access.role, "editor")}
            />
        </DocumentChrome>
    );
}
