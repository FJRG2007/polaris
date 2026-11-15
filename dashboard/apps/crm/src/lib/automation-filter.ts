/**
 * What the central automations list shows when it is narrowed to the CRM's
 * automations: the names on its filter chips - the CRM, and the kind of record
 * - and the CRM's New button, which starts one on that kind of record.
 *
 * Server-only.
 */

import { z } from "zod";
import { crmT } from "./i18n";
import { crmActor } from "./access";
import { host, type AppHostTypes } from "@polaris/app-host";
import { CRM_OBJECTS, type CrmObject } from "../model/objects";

type AppAutomationsFilter = AppHostTypes["AppAutomationsFilter"];

/** What the actions slot is handed: the kind of record the list is narrowed to (null is all). */
export interface AutomationsSlotProps {
    readonly object: CrmObject | null;
    /** The kinds of record the reader may build automations on. */
    readonly objects: readonly CrmObject[];
}

export async function automationsFilter(ref: string | null): Promise<AppAutomationsFilter | null> {
    const user = await host.session.requireUser();
    if (!(await host.session.sessionCanAny(user, "crm.use").catch(() => false))) return null;
    const actor = await crmActor(user);
    const t = await crmT();
    const asked = ref ? z.enum(CRM_OBJECTS).safeParse(ref) : null;
    const object = asked?.success ? asked.data : null;
    // Building one is what editing a workflow needed: changing that kind of record.
    const objects = CRM_OBJECTS.filter((one) => actor.can[one].edit);
    const props: AutomationsSlotProps = { object, objects };
    return {
        name: t("automations.appName"),
        refName: object ? t(`objects.${object}.plural`) : null,
        actions:
            objects.length > 0 && (!object || objects.includes(object))
                ? { app: "crm", kind: "automations-actions", props }
                : null,
        after: null
    };
}
