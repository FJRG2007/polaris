/** Marketplace: the apps Polaris can install, and the ones already in. */

import { Chrome } from "../runtime/chrome";
import { defineScene } from "../runtime/scene";
import { VIEWER, ago, id } from "../fixtures/people";
import { MarketplaceView } from "@/app/(app)/apps/marketplace/marketplace-view";

export const marketplace = defineScene({
    id: "marketplace",
    path: "/apps/marketplace",
    render: (ctx) => (
        <Chrome>
            <MarketplaceView
                installed={[
                    {
                        id: id("app-install", 1),
                        catalogId: "calendar",
                        name: ctx.say("Calendar", "Calendario"),
                        status: "running"
                    },
                    {
                        id: id("app-install", 2),
                        catalogId: "game-servers",
                        name: ctx.say("Game servers", "Servidores de juegos"),
                        status: "running"
                    },
                    {
                        id: id("app-install", 3),
                        catalogId: "crm",
                        name: "CRM",
                        status: "installing"
                    }
                ].map((row, index) => ({
                    ...row,
                    applicationId: null,
                    targetId: null,
                    createdAt: ago(ctx.now, 60 * 24 * (index + 3)),
                    ownerId: VIEWER.id
                }))}
            />
        </Chrome>
    )
});
