/**
 * The install a one-click "Install" performs: the manifest's own defaults, the
 * local host, and a server-local volume for each of the app's volumes. The
 * advanced wizard starts from the same values and lets the operator change the
 * server, the storage and the settings before installing, so the two paths can
 * never drift into installing different things.
 */

import type { AppInstallInput } from "./install-schema";
import { promptedEnvVars, type AppManifest } from "./catalog";

/** The default target: the machine Polaris itself runs on. */
export const LOCAL_SERVER_ID = "local";

export function defaultInstallInput(app: AppManifest, serverId: string = LOCAL_SERVER_ID): AppInstallInput {
    return {
        catalogId: app.id,
        name: app.name,
        serverId,
        storage: (app.template?.volumes ?? []).map((volume) => ({
            volumeName: volume.name,
            backing: "local" as const
        })),
        // Generated vars (an app's own admin password) are minted server-side and
        // never travel through the form.
        env: promptedEnvVars(app).map((field) => ({ key: field.key, value: field.default ?? "" }))
    };
}
