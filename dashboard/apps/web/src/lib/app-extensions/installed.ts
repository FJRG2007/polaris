/**
 * The installable apps this dashboard serves, from wherever each is served: its
 * bundle when this server runs one, the copy compiled into the image otherwise
 * (see `lib/app-bundles/code.ts`).
 */

import type { AppExtension } from "./types";
import { appExtensions } from "@/lib/app-bundles/code";

export function installedExtensions(): readonly AppExtension[] {
    return appExtensions();
}
