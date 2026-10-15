/** One game server, managed: who is playing, what they carry, events, the console. */

import { Chrome } from "../runtime/chrome";
import type { AppSlot } from "@/lib/app-extensions/types";
import type { InstalledAppDetail, InstalledAppSetting } from "@/lib/apps/install-service";
import { defineScene, type SceneContext, type SceneDefinition } from "../runtime/scene";
import { visibleGameTabs } from "@/app/(app)/apps/installed/[id]/tabs";
import { InstalledAppDashboard } from "@/app/(app)/apps/installed/[id]/installed-app-dashboard";
import {
    SERVER_GRANTS,
    SURVIVAL_SETTINGS,
    survival,
    survivalApp,
    survivalCommands,
    survivalEvents,
    survivalInventory,
    survivalLog,
    survivalReading,
    survivalSlot
} from "../fixtures/game-server";

/** The page `/apps/installed/<id>/<tab>` draws for one server, Survival unless
 *  another is named. */
export function Server({
    ctx,
    app = survivalApp(ctx),
    settings = SURVIVAL_SETTINGS,
    slot = survivalSlot(ctx)
}: {
    ctx: SceneContext;
    app?: InstalledAppDetail;
    settings?: InstalledAppSetting[];
    slot?: AppSlot;
}) {
    return (
        <Chrome>
            <InstalledAppDashboard
                app={app}
                settings={settings}
                slot={slot}
                held={SERVER_GRANTS}
                duplicate={{ allowed: true }}
            />
        </Chrome>
    );
}

/** What every tab of the Survival server asks, whichever tab it is. */
export function survivalApi(ctx: SceneContext) {
    return {
        "GET /api/apps/installed/:id/minecraft": () => survivalReading(ctx),
        "GET /api/apps/installed/:id/nav": () => ({
            name: survivalApp(ctx).name,
            tabs: visibleGameTabs(SERVER_GRANTS, "minecraft").map((one) => one.slug),
            labels: {}
        })
    };
}

/** One tab of the Survival server, answered from the same fixtures. */
function serverScene(
    id: string,
    tab: string,
    extra: Pick<SceneDefinition, "actions" | "api" | "prepare" | "streams"> = {}
): SceneDefinition {
    return defineScene({
        id,
        path: `/apps/installed/${survivalIdFor()}/${tab}`,
        params: { id: survivalIdFor() },
        actions: (ctx) => ({
            redeployStrategyAction: () => null,
            ...extra.actions?.(ctx)
        }),
        api: (ctx) => ({ ...survivalApi(ctx), ...extra.api?.(ctx) }),
        streams: extra.streams,
        prepare: extra.prepare,
        render: (ctx) => <Server ctx={ctx} />
    });
}

/** The server's id does not depend on the locale, only its name does. */
export function survivalIdFor(): string {
    return survival({ locale: "en-US", theme: "dark", now: 0, say: (en) => en }).seed.id;
}

/** Resolve once `find` finds something. Watches the page rather than a timer,
 *  because the capture holds the clock still while a scene is prepared. */
export function appeared<T>(find: () => T | null | undefined): Promise<T> {
    const now = find();
    if (now) return Promise.resolve(now);
    return new Promise((resolve) => {
        const watch = new MutationObserver(() => {
            const found = find();
            if (!found) return;
            watch.disconnect();
            resolve(found);
        });
        watch.observe(document.body, { childList: true, subtree: true, attributes: true });
    });
}

const visible = (element: HTMLElement) => element.offsetParent !== null;

/** Open one player's row menu and pick the entry that reads `entry`. */
export async function playerMenu(player: string, entry: RegExp): Promise<void> {
    const trigger = await appeared(() =>
        [...document.querySelectorAll<HTMLElement>("[aria-haspopup=menu]")].find(
            (element) => element.getAttribute("aria-label")?.endsWith(player) && visible(element)
        )
    );
    trigger.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" })
    );
    const item = await appeared(() =>
        [...document.querySelectorAll<HTMLElement>("[role=menuitem]")].find((element) =>
            entry.test(element.textContent?.trim() ?? "")
        )
    );
    // A menu takes its first ticks to finish opening, and a click before then
    // is dropped: the hand waits a beat of the scene's clock, as a hand would.
    await new Promise((resolve) => setTimeout(resolve, 300));
    item.click();
}

export const gamePlayers = serverScene("game-players", "players");

export const gameInventory = serverScene("game-inventory", "players", {
    actions: (ctx) => ({
        readPlayerInventoryAction: () => survivalInventory(ctx),
        pendingActionsAction: () => ({ pending: [] }),
        recentItemsAction: () => ({
            items: ["minecraft:diamond", "minecraft:golden_apple", "minecraft:elytra"]
        })
    }),
    api: () => ({ "GET /api/apps/installed/:id/minecraft/items": () => ({ items: [] }) }),
    prepare: () => playerMenu("Builder_Ana", /^(Inventory and items|Inventario y objetos)$/)
});

export const gameEvents = serverScene("game-events", "events", {
    actions: (ctx) => ({ readEventsAction: () => survivalEvents(ctx) })
});

export const gameConsole = serverScene("game-console", "console", {
    actions: (ctx) => ({
        listConsoleSchedulesAction: () => ({ schedules: [] }),
        listConsoleCommandsAction: () => survivalCommands(ctx),
        recentItemsAction: () => ({ items: [] })
    }),
    api: (ctx) => ({
        "GET /api/deploy/apps/:id/logs": () => ({ log: survivalLog(ctx) })
    })
});
