/** Drive: their own space beside the storage they connected, in one explorer. */

import { PageHeader } from "@polaris/ui";
import { Chrome } from "../runtime/chrome";
import { label } from "../runtime/interact";
import { defineScene } from "../runtime/scene";
import { DriveExplorer } from "@/app/(app)/drive/drive-explorer";
import { DRIVE_ID, connections, folderSizes, rootEntries } from "../fixtures/drive";

export const drive = defineScene({
    id: "drive",
    path: "/drive",
    actions: () => ({
        waitingTransfersAction: () => [],
        sentTransfersAction: () => [],
        driveJobsAction: () => ({ jobs: [], going: [] })
    }),
    api: (ctx) => ({
        "GET /api/drive/source-status": () => ({ sources: [] }),
        "GET /api/drive/list": () => ({ entries: rootEntries(ctx) }),
        "GET /api/drive/insights": () => folderSizes(ctx)
    }),
    render: (ctx) => (
        <Chrome>
            <PageHeader
                title={label(ctx.locale, "drive.pages.drive.title")}
                description={label(ctx.locale, "drive.pages.drive.description")}
            />
            <DriveExplorer
                connections={connections(ctx)}
                connectionId={DRIVE_ID}
                path=""
                abilities={{ read: true, write: true, remove: true }}
            />
        </Chrome>
    )
});
