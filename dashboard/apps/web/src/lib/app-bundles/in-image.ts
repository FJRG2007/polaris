/**
 * The installed apps' routes as this image compiled them, for the release in
 * which an app's code travels both ways.
 *
 * An app is served from its bundle when this server has one loaded, and from
 * here otherwise; see `code.ts`. Once bundles are the only way an app arrives,
 * this file and the app packages leave the image together.
 *
 * Routes only: a route is a function Next never looks inside. Pages are in
 * `in-image-pages.ts`, which the page catch-alls import so Next finds the
 * client components those pages draw.
 */

import "@/lib/app-host/server";
import type { AppExtension } from "@/lib/app-extensions/types";
import { placesExtension } from "@polaris-app/places/src/lib/places-extension";
import { gameServersExtension } from "@polaris-app/game-servers/src/lib/games-extension";

type RouteModule = Record<string, unknown>;

export interface ImageApp {
    readonly extension: AppExtension;
    readonly routes: Readonly<Record<string, () => Promise<RouteModule>>>;
}

export const IN_IMAGE: Readonly<Record<string, ImageApp>> = {
    home: {
        extension: placesExtension,
        routes: {
            "/api/home/cameras/[id]/hls/[file]": () =>
                import("@polaris-app/places/src/routes/api/home/cameras/[id]/hls/[file]/route"),
            "/api/home/cameras/[id]/snapshot": () =>
                import("@polaris-app/places/src/routes/api/home/cameras/[id]/snapshot/route"),
            "/api/home/cameras/[id]/stream": () =>
                import("@polaris-app/places/src/routes/api/home/cameras/[id]/stream/route"),
            "/api/home/cameras/detections": () =>
                import("@polaris-app/places/src/routes/api/home/cameras/detections/route"),
            "/api/home/clips/[id]/video": () =>
                import("@polaris-app/places/src/routes/api/home/clips/[id]/video/route"),
            "/api/home/events/[id]/still": () =>
                import("@polaris-app/places/src/routes/api/home/events/[id]/still/route"),
            "/api/home/vision/activity": () =>
                import("@polaris-app/places/src/routes/api/home/vision/activity/route"),
            "/api/home/vision/assignments": () =>
                import("@polaris-app/places/src/routes/api/home/vision/assignments/route"),
            "/api/home/vision/events": () =>
                import("@polaris-app/places/src/routes/api/home/vision/events/route"),
            "/api/home/vision/live": () =>
                import("@polaris-app/places/src/routes/api/home/vision/live/route")
        }
    },
    "game-servers": {
        extension: gameServersExtension,
        routes: {
            "/api/apps/games/live": () =>
                import("@polaris-app/game-servers/src/routes/api/apps/games/live/route"),
            "/api/apps/games": () =>
                import("@polaris-app/game-servers/src/routes/api/apps/games/route"),
            "/api/apps/games/stream": () =>
                import("@polaris-app/game-servers/src/routes/api/apps/games/stream/route"),
            "/api/apps/installed/[id]/ark": () =>
                import("@polaris-app/game-servers/src/routes/api/apps/installed/[id]/ark/route"),
            "/api/apps/installed/[id]/ark/workshop-icon": () =>
                import(
                    "@polaris-app/game-servers/src/routes/api/apps/installed/[id]/ark/workshop-icon/route"
                ),
            "/api/apps/installed/[id]/fivem": () =>
                import("@polaris-app/game-servers/src/routes/api/apps/installed/[id]/fivem/route"),
            "/api/apps/installed/[id]/game/players": () =>
                import(
                    "@polaris-app/game-servers/src/routes/api/apps/installed/[id]/game/players/route"
                ),
            "/api/apps/installed/[id]/minecraft/icon": () =>
                import(
                    "@polaris-app/game-servers/src/routes/api/apps/installed/[id]/minecraft/icon/route"
                ),
            "/api/apps/installed/[id]/minecraft/items/icon": () =>
                import(
                    "@polaris-app/game-servers/src/routes/api/apps/installed/[id]/minecraft/items/icon/route"
                ),
            "/api/apps/installed/[id]/minecraft/items": () =>
                import(
                    "@polaris-app/game-servers/src/routes/api/apps/installed/[id]/minecraft/items/route"
                ),
            "/api/apps/installed/[id]/minecraft/modrinth/icon": () =>
                import(
                    "@polaris-app/game-servers/src/routes/api/apps/installed/[id]/minecraft/modrinth/icon/route"
                ),
            "/api/apps/installed/[id]/minecraft/modrinth": () =>
                import(
                    "@polaris-app/game-servers/src/routes/api/apps/installed/[id]/minecraft/modrinth/route"
                ),
            "/api/apps/installed/[id]/minecraft": () =>
                import(
                    "@polaris-app/game-servers/src/routes/api/apps/installed/[id]/minecraft/route"
                ),
            "/api/apps/installed/[id]/minecraft/world/[name]": () =>
                import(
                    "@polaris-app/game-servers/src/routes/api/apps/installed/[id]/minecraft/world/[name]/route"
                ),
            "/api/apps/installed/[id]/minecraft/world": () =>
                import(
                    "@polaris-app/game-servers/src/routes/api/apps/installed/[id]/minecraft/world/route"
                ),
            "/api/minecraft/login/[id]/[action]": () =>
                import(
                    "@polaris-app/game-servers/src/routes/api/minecraft/login/[id]/[action]/route"
                ),
            "/api/minecraft/mod/[file]": () =>
                import("@polaris-app/game-servers/src/routes/api/minecraft/mod/[file]/route"),
            "/api/minecraft/pack/[id]/[token]/[file]": () =>
                import(
                    "@polaris-app/game-servers/src/routes/api/minecraft/pack/[id]/[token]/[file]/route"
                )
        }
    }
};
