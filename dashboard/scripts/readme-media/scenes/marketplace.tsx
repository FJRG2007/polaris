/** Marketplace: the apps Polaris can install, and the ones already in. */

import { Chrome } from "../runtime/chrome";
import { label, press } from "../runtime/interact";
import { defineScene } from "../runtime/scene";
import { VIEWER, ago, id } from "../fixtures/people";
import { connections } from "../fixtures/drive";
import type { SceneContext } from "../runtime/scene";
import { MarketplaceView } from "@/app/(app)/apps/marketplace/marketplace-view";

function Marketplace({ ctx }: { ctx: SceneContext }) {
    return (
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
    );
}

export const marketplace = defineScene({
    id: "marketplace",
    path: "/apps/marketplace",
    render: (ctx) => <Marketplace ctx={ctx} />
});

/** Installing with a choice: which machine runs it, and where its data lives. */
export const marketplaceInstall = defineScene({
    id: "marketplace-install",
    path: "/apps/marketplace",
    actions: (ctx) => ({
        listInstallTargetsAction: () => [
            { id: "local", name: label(ctx.locale, "marketplace.wizard.thisServer"), kind: "local" },
            { id: id("host", 1), name: "office-server", kind: "host" },
            { id: id("host", 2), name: "edge-01", kind: "host" }
        ],
        listStorageConnectionsAction: () =>
            connections(ctx)
                .filter((connection) => connection.kind !== "personal")
                .map((connection) => ({ id: connection.id, name: connection.name }))
    }),
    render: (ctx) => <Marketplace ctx={ctx} />,
    // The one app here that runs something of its own, so the one with choices.
    prepare: (ctx) => press(label(ctx.locale, "marketplace.card.configure"))
});
