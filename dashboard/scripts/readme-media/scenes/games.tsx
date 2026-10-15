/**
 * Game servers, toured: every server in one table, then one Minecraft world
 * opened - who is playing, what one of them carries and wears, the events
 * running on it, its settings - and the settings of the ARK and FiveM servers
 * beside it.
 *
 * A scene stands at one route, so the tour is one component whose view each
 * step switches, with the route moved to that view's before it draws.
 */

import { Fragment, useEffect, useSyncExternalStore, type ReactNode } from "react";
import { Chrome } from "../runtime/chrome";
import { scenePath } from "../runtime/route";
import { defineScene, type SceneContext } from "../runtime/scene";
import { visibleGameTabs } from "@/app/(app)/apps/installed/[id]/tabs";
import { GamesView } from "../../../apps/game-servers/src/screens/games-view";
import { gameFacts, gameLive, gameServers } from "../fixtures/games";
import { gameMessage } from "../../../apps/game-servers/src/lib/game-message";
import { SERVER_GRANTS } from "../fixtures/game-server";
import * as tour from "../fixtures/game-tour";
import {
    Server,
    gameEvents,
    gameInventory,
    playerMenu,
    survivalApi,
    survivalIdFor
} from "./game-server";

interface View {
    /** The server it opens, by its place in the list; none for the list. */
    readonly server?: number;
    readonly tab?: string;
    readonly hold: number;
    readonly render: (ctx: SceneContext) => ReactNode;
    /** What a hand does once the view is up. */
    readonly then?: () => Promise<void>;
}

const LIST: View["render"] = (ctx) => (
    <Chrome>
        <GamesView servers={gameServers(ctx)} installed canCreate />
    </Chrome>
);

const SURVIVAL: View["render"] = (ctx) => (
    <Server ctx={ctx} settings={tour.survivalSettings(ctx)} />
);

const TOUR: readonly View[] = [
    { hold: 2600, render: LIST },
    { server: 0, tab: "players", hold: 2400, render: SURVIVAL },
    {
        server: 0,
        tab: "players",
        hold: 3000,
        render: SURVIVAL,
        then: () => playerMenu("Builder_Ana", /^(Inventory and items|Inventario y objetos)$/)
    },
    {
        server: 0,
        tab: "players",
        hold: 2600,
        render: SURVIVAL,
        then: () => playerMenu("PixelPriya", /^Skin$/)
    },
    { server: 0, tab: "events", hold: 2800, render: SURVIVAL },
    { server: 0, tab: "settings", hold: 2600, render: SURVIVAL },
    {
        server: tour.ARK_INDEX,
        tab: "settings",
        hold: 2600,
        render: (ctx) => (
            <Server
                ctx={ctx}
                app={tour.installedApp(ctx, tour.ARK_INDEX)}
                settings={tour.arkSettings(ctx)}
                slot={tour.arkSlot(ctx)}
            />
        )
    },
    {
        server: tour.FIVEM_INDEX,
        tab: "settings",
        hold: 2600,
        render: (ctx) => (
            <Server
                ctx={ctx}
                app={tour.installedApp(ctx, tour.FIVEM_INDEX)}
                settings={[]}
                slot={tour.fivemSlot(ctx)}
            />
        )
    }
];

/** The view on screen, which the steps move. */
let shown = 0;
const watchers = new Set<() => void>();

function subscribe(watcher: () => void) {
    watchers.add(watcher);
    return () => watchers.delete(watcher);
}

/** Where `view` lives: the list, or one tab of one server. */
function placeOf(view: View): { path: string; params: Record<string, string> } {
    if (view.server === undefined) return { path: "/apps/games", params: {} };
    const id = view.server === 0 ? survivalIdFor() : gameServers(ENGLISH)[view.server]!.id;
    return { path: `/apps/installed/${id}/${view.tab ?? ""}`, params: { id } };
}

/** Ids do not depend on the locale, so any context finds them. */
const ENGLISH: SceneContext = { locale: "en-US", theme: "dark", now: 0, say: (en) => en };

function show(index: number) {
    const place = placeOf(TOUR[index]!);
    scenePath.set(place.path, place.params);
    shown = index;
    for (const watcher of watchers) watcher();
}

/** The view React has put on screen, which trails `shown` by a render. */
let mounted = 0;
const mountWatchers = new Set<() => void>();

/** Resolves once view `index` is the one on screen: a hand reaching for a
 *  button before then finds the previous view's, on its way out. */
function mountedAt(index: number): Promise<void> {
    if (mounted === index) return Promise.resolve();
    return new Promise((resolve) => {
        const check = () => {
            if (mounted !== index) return;
            mountWatchers.delete(check);
            resolve();
        };
        mountWatchers.add(check);
    });
}

function Tour({ ctx }: { ctx: SceneContext }) {
    const index = useSyncExternalStore(subscribe, () => shown);
    useEffect(() => {
        mounted = index;
        for (const watcher of [...mountWatchers]) watcher();
    }, [index]);
    // A new key per view: every screen mounts fresh at its own route, the way
    // following a link to it would.
    return <Fragment key={index}>{TOUR[index]!.render(ctx)}</Fragment>;
}

export const games = defineScene({
    id: "games",
    path: "/apps/games",
    actions: (ctx) => ({
        ...gameInventory.actions?.(ctx),
        ...gameEvents.actions?.(ctx),
        readSkinAction: () => tour.survivalSkin(),
        previewSkinAction: () => ({ png: tour.SKIN_TEXTURE, model: "slim" }),
        readSeasonalAction: () => tour.survivalSeasonal(),
        readGameStorageAction: () => tour.gameStorage(),
        // What the Settings tab reads for itself: a Paper server, so no mod
        // loader to hold and no login mod on, with memory the plan already covers.
        readLoaderPinAction: () => ({ view: { pin: { state: "none" }, updating: false } }),
        readMemoryPlanAction: () => ({
            plan: {
                mode: "auto",
                ceilingMb: 8192,
                currentMb: 6144,
                plannedMb: 6144,
                reason: gameMessage("games", "lib.memory.reason", {
                    cost: "plugins",
                    mods: 0,
                    players: 12
                })
            }
        }),
        loginStateAction: () => ({
            state: {
                on: false,
                build: null,
                foreign: null,
                reachable: true,
                health: "waiting",
                seenAt: null,
                modVersion: null,
                currentVersion: null,
                outdated: false,
                players: []
            }
        }),
        minecraftReleasesAction: () => ["1.21.4", "1.21.3", "1.21.1", "1.20.6", "1.20.4"],
        readGameRestartAction: () => ({ pending: null })
    }),
    api: (ctx) => ({
        "GET /api/apps/games": () => ({ servers: gameFacts(ctx) }),
        "GET /api/apps/games/live": () => ({ servers: gameLive(ctx) }),
        ...gameInventory.api?.(ctx),
        ...survivalApi(ctx),
        "GET /api/apps/installed/:id/ark": () => tour.arkReading(ctx),
        "GET /api/apps/installed/:id/fivem": () => tour.fivemReading(ctx),
        // Every server's page asks for its own tab bar.
        "GET /api/apps/installed/:id/nav": ({ url }) => {
            const id = url.pathname.split("/")[4];
            const seed = gameServers(ctx).find((one) => one.id === id) ?? gameServers(ctx)[0]!;
            return {
                name: seed.name,
                tabs: visibleGameTabs(SERVER_GRANTS, seed.game).map((one) => one.slug),
                labels: {}
            };
        }
    }),
    render: (ctx) => <Tour ctx={ctx} />,
    animation: {
        frames: TOUR.length,
        step: async (index) => {
            if (index > 0) show(index);
            await mountedAt(index);
            await TOUR[index]!.then?.();
        },
        hold: (index) => TOUR[index]!.hold,
        // Long enough for a screen that just mounted to hear back from every
        // request it made.
        advance: () => 1500
    }
});
