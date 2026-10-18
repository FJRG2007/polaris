/**
 * What the central automations list shows when it is narrowed to Places'
 * automations: the names on its filter chips, and the two slots Places draws
 * there - its New menu with the templates, and the automations that have not
 * moved to the central engine yet.
 *
 * Server-only.
 */

import { placesT } from "./i18n";
import { getPlace } from "./places";
import { homeInstall } from "./access";
import { host, type AppHostTypes } from "@polaris/app-host";

type AppAutomationsFilter = AppHostTypes["AppAutomationsFilter"];

const { requireUser, sessionCanAny } = host.session;

/** What the slots are handed: the place the list is narrowed to (null is all). */
export interface AutomationsSlotProps {
    readonly placeId: string | null;
    readonly canManage: boolean;
}

export async function automationsFilter(ref: string | null): Promise<AppAutomationsFilter | null> {
    const user = await requireUser();
    const install = await homeInstall();
    if (!install) return null;
    const [canRead, canManage] = await Promise.all([
        sessionCanAny(user, "home.read"),
        sessionCanAny(user, "home.manage")
    ]);
    if (!canRead) return null;
    const t = await placesT();
    const place = ref ? await getPlace(install.id, ref) : null;
    const props: AutomationsSlotProps = { placeId: place?.id ?? null, canManage };
    return {
        name: t("automations.list.appName"),
        refName: place?.name ?? null,
        actions: canManage ? { app: "home", kind: "automations-actions", props } : null,
        after: { app: "home", kind: "automations-after", props }
    };
}
