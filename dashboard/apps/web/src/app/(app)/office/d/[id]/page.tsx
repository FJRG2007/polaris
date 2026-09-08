/**
 * One document, open.
 *
 * The chrome is the server's - the name, who may do what, the way back - and the
 * document itself is handed to the editor as the bytes that were stored. Opening
 * it is also recorded, because "last opened by me" is what every list here is
 * ordered by and it is nobody else's business.
 */

import * as core from "@polaris/core";
import { notFound } from "next/navigation";
import { DocEditor } from "./doc-editor";
import * as office from "@/lib/office/documents";
import { requirePermission } from "@/lib/session";
import { DocumentChrome } from "@/app/(app)/office/document-chrome";

export const dynamic = "force-dynamic";

export default async function OfficeDocumentPage({ params }: { params: Promise<{ id: string }> }) {
    const user = await requirePermission("office.use");
    const { id } = await params;
    const found = await office.readDocument({ id: user.id }, id);
    // The same answer for a document that is not there and one that is not
    // theirs. Telling the two apart is telling somebody that a document exists.
    if (!found || found.view.kind !== "doc") notFound();
    await office.touchDocument({ id: user.id }, id);

    const editable = core.officeRoleAtLeast(found.access.role, "editor");
    return (
        <DocumentChrome document={found.view} role={found.access.role} owned={found.access.owned}>
            <DocEditor
                documentId={id}
                content={found.content ? Array.from(found.content) : null}
                editable={editable}
            />
        </DocumentChrome>
    );
}
