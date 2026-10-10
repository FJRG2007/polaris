/** Drive: their own space beside the storage they connected, in one explorer. */

import { PageHeader } from "@polaris/ui";
import { Chrome } from "../runtime/chrome";
import { label } from "../runtime/interact";
import { defineScene } from "../runtime/scene";
import { DriveExplorer } from "@/app/(app)/drive/drive-explorer";
import { SharedView } from "@/app/(app)/drive/shared-links/shared-links-view";
import { DRIVE_ID, connections, folderSizes, rootEntries, shareLinks } from "../fixtures/drive";

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

/** The links they handed out, with what each may do and how much it was used. */
export const driveLinks = defineScene({
    id: "drive-links",
    path: "/drive/shared-links",
    // The page `/drive/shared-links` draws, with what it would have read.
    render: (ctx) => (
        <Chrome>
            <div className="mx-auto flex max-w-3xl flex-col gap-4">
                <div>
                    <h1 className="text-[1.0625rem] font-semibold tracking-tight">
                        {label(ctx.locale, "drive.pages.sharedLinks.title")}
                    </h1>
                    <p className="text-sm text-muted-foreground">
                        {label(ctx.locale, "drive.pages.sharedLinks.description")}
                    </p>
                </div>
                <SharedView shares={shareLinks(ctx)} />
            </div>
        </Chrome>
    )
});
