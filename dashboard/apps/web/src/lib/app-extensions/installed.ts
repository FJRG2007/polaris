/**
 * The installable apps this build carries.
 *
 * The one server-side place allowed to name an app's code (the boundary test in
 * `test/build/app-boundaries.test.ts` holds everything else to that). When an
 * app ships as a bundle instead, its line here is replaced by the bundle loader.
 */

import type { AppExtension } from "./types";
import { placesExtension } from "@/lib/home/places-extension";
import { gameServersExtension } from "@/lib/apps/games-extension";

export function installedExtensions(): readonly AppExtension[] {
    return [gameServersExtension, placesExtension];
}
