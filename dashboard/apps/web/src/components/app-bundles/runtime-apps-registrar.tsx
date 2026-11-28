"use client";

/**
 * Hands the browser the apps of the published catalogue before the screens
 * under it render, so a store card, the rail and `findApp` know an app this
 * image was built without. Renders nothing.
 */

import { registerRuntimeApps } from "@/lib/apps/runtime-apps";
import type { RuntimeAppView } from "@/lib/apps/runtime-catalog-schema";

export function RuntimeAppsRegistrar({ apps }: { apps: readonly RuntimeAppView[] }) {
    registerRuntimeApps(apps);
    return null;
}
