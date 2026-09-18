/**
 * The installable apps this build carries.
 *
 * The one server-side place allowed to name an app's code (the boundary test in
 * `test/build/app-boundaries.test.ts` holds everything else to that). When an
 * app ships as a bundle instead, its line here is replaced by the bundle loader.
 */

// First: the apps below take the dashboard's services from it as they load.
import "@/lib/app-host/server";
import type { AppExtension } from "./types";
import { placesExtension } from "@polaris-app/places/src/lib/places-extension";
import { gameServersExtension } from "@polaris-app/game-servers/src/lib/games-extension";

export function installedExtensions(): readonly AppExtension[] {
    return [gameServersExtension, placesExtension];
}
