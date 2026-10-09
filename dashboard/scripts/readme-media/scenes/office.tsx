/** Office: documents, sheets, slides and canvases, kept in Polaris. */

import { Chrome } from "../runtime/chrome";
import { label } from "../runtime/interact";
import { defineScene } from "../runtime/scene";
import { OfficeView } from "@/app/(app)/office/office-view";
import { officeDocuments } from "../fixtures/office";

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
