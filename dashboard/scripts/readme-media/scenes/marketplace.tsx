/** Marketplace: the apps Polaris can install, and the ones already in. */

import { Chrome } from "../runtime/chrome";
import { label } from "../runtime/interact";
import { defineScene } from "../runtime/scene";
import { VIEWER, ago, id } from "../fixtures/people";
import { connections } from "../fixtures/drive";
import type { SceneContext } from "../runtime/scene";
import { MarketplaceView } from "@/app/(app)/apps/marketplace/marketplace-view";

function Marketplace({
    ctx,
    scope = "deployable"
}: {
    ctx: SceneContext;
    /** Which marketplace: deployable apps, or Polaris's own (/admin/apps). */
    scope?: "deployable" | "polaris";
}) {
    return (
        <Chrome>
            <MarketplaceView
                // The viewer runs this Polaris, so every app offers its install.
                canInstall
                scope={scope}
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
    // Polaris's own apps: the ones that run something of their own, and so the
    // ones with choices, are listed there.
    path: "/admin/apps",
    actions: (ctx) => ({
        listInstallTargetsAction: () => [
            {
                id: "local",
                name: label(ctx.locale, "marketplace.wizard.thisServer"),
                kind: "local"
            },
            { id: id("host", 1), name: "office-server", kind: "host" },
            { id: id("host", 2), name: "edge-01", kind: "host" }
        ],
        listStorageConnectionsAction: () =>
            connections(ctx)
                .filter((connection) => connection.kind !== "personal")
                .map((connection) => ({ id: connection.id, name: connection.name }))
    }),
    render: (ctx) => <Marketplace ctx={ctx} scope="polaris" />,
    prepare: (ctx) => configureFirst(ctx)
});

/** A beat of the scene's clock: a menu takes its first ticks to open or close. */
const beat = () => new Promise((resolve) => setTimeout(resolve, 300));

/**
 * Configure sits in each card's overflow menu, beside Details, on an app that
 * runs something of its own. Open the menus in order, the way a reader looks
 * for it, and choose it from the first one that has it.
 */
async function configureFirst(ctx: SceneContext): Promise<void> {
    const configure = label(ctx.locale, "marketplace.card.configure");
    const more = label(ctx.locale, "marketplace.card.more").split("{name}")[0]!;
    const triggers = [...document.querySelectorAll<HTMLElement>("[aria-haspopup=menu]")].filter(
        (element) =>
            element.getAttribute("aria-label")?.startsWith(more) && element.offsetParent !== null
    );
    for (const trigger of triggers) {
        trigger.dispatchEvent(
            new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" })
        );
        await beat();
        const item = [...document.querySelectorAll<HTMLElement>("[role=menuitem]")].find(
            (element) => element.textContent?.trim() === configure
        );
        if (item) {
            item.click();
            return;
        }
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        await beat();
    }
    throw new Error(`no card offers "${configure}"`);
}
