/** Office: documents, sheets, slides and canvases, kept in Polaris. */

import { Chrome } from "../runtime/chrome";
import { label } from "../runtime/interact";
import { defineScene } from "../runtime/scene";
import { OfficeView } from "@/app/(app)/office/office-view";
import { DocEditor } from "@/app/(app)/office/d/[id]/doc-editor";
import { DocumentChrome } from "@/app/(app)/office/document-chrome";
import { OPEN_DOCUMENT_ID, launchPlanContent, officeDocuments } from "../fixtures/office";

export const office = defineScene({
    id: "office",
    path: "/office",
    actions: (ctx) => ({ listDocumentsAction: () => ({ documents: officeDocuments(ctx) }) }),
    render: (ctx) => (
        <Chrome>
            <OfficeView
                shelf="live"
                kind=""
                starredOnly={false}
                sharedOnly={false}
                title={label(ctx.locale, "office.pages.office.title")}
                description={label(ctx.locale, "office.pages.office.description")}
            />
        </Chrome>
    )
});

/** A document open in its editor, kept in Polaris rather than sent around. */
export const officeDoc = defineScene({
    id: "office-doc",
    path: `/office/d/${OPEN_DOCUMENT_ID}`,
    params: { id: OPEN_DOCUMENT_ID },
    // Not opened from Google, so nothing to pull back from there.
    actions: () => ({ officeGoogleLinkAction: () => ({ link: null }) }),
    api: () => ({ "POST /api/office/:id/content": () => ({ ok: true }) }),
    // The page `/office/d/[id]` draws, with what it would have read.
    render: (ctx) => (
        <Chrome>
            <DocumentChrome
                document={officeDocuments(ctx).find((row) => row.id === OPEN_DOCUMENT_ID)!}
                role="editor"
                owned
            >
                <DocEditor documentId={OPEN_DOCUMENT_ID} content={launchPlanContent(ctx)} editable />
            </DocumentChrome>
        </Chrome>
    )
});
