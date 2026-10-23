/** Automations: what runs on its own, with how each one last went. */

import { tourScene } from "../runtime/tour";
import { PageHeader } from "@polaris/ui";
import { ORG } from "../fixtures/people";
import { Chrome } from "../runtime/chrome";
import { label } from "../runtime/interact";
import { defineScene } from "../runtime/scene";
import { AutomationsList } from "@/app/(app)/automations/automations-list";
import { automationFolders, automationRows } from "../fixtures/automations";

const automationsStill = defineScene({
    id: "automations",
    path: "/automations",
    actions: (ctx) => ({
        listAutomationsAction: () => ({
            ok: true,
            rows: automationRows(ctx),
            canEdit: true,
            folders: automationFolders(ctx)
        }),
        creatableShelvesAction: () => ({
            ok: true,
            orgs: [{ id: ORG.id, name: ORG.name }],
            openOrgId: ORG.id
        })
    }),
    // The page `/automations` draws, with what it would have read.
    render: (ctx) => (
        <Chrome>
            <div className="mx-auto w-full max-w-4xl">
                <PageHeader
                    title={label(ctx.locale, "automations.title")}
                    description={label(ctx.locale, "automations.description")}
                />
                <AutomationsList />
            </div>
        </Chrome>
    )
});

/** The list, then the alert that failed run again and passed. */
export const automations = tourScene([automationsStill], [
    { hold: 2000 },
    { fresh: true, hold: 3000 }
]);
