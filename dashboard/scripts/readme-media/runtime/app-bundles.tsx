/** `components/app-bundles/runtime` for a page with no app bundles to fetch: the
 *  apps a scene shows are bundled with it, so loading one is a lookup. */

import { GameServersSlot } from "../../../apps/game-servers/src/screens/extension-slot";

const MODULES: Record<string, Record<string, unknown>> = {
    "readme-media:game-servers": { GameServersSlot }
};

export function loadAppModule(src: string): Promise<Record<string, unknown>> {
    const found = MODULES[src];
    return found ? Promise.resolve(found) : Promise.reject(new Error(`no app bundle ${src}`));
}
