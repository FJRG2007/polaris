/**
 * What installing an app takes, read off its manifest: a server and what the
 * container asks of it, or nothing at all for an app that is part of the
 * dashboard; and the permission the install action checks. The app's
 * Marketplace page lists it, and the public site's page for the app reads the
 * same lines at build time.
 */

import type { NamespaceTranslator } from "@/lib/i18n/types";
import { promptedEnvVars, type AppManifest } from "@/lib/apps/catalog";

export function appNeeds(t: NamespaceTranslator<"marketplace">, app: AppManifest): string[] {
    const lines: string[] = [];
    if (app.installMethod === "builtin") lines.push(t("detail.needsNothing"));
    else if (app.installMethod === "deploy-template") lines.push(t("detail.needsProject"));
    else {
        lines.push(t("detail.needsServer"));
        const ports = app.template?.ports ?? [];
        if (ports.length > 0)
            lines.push(
                t("detail.needsPorts", {
                    ports: ports
                        .map((port) => `${port.host ?? port.container}/${port.protocol}`)
                        .join(", ")
                })
            );
        const volumes = app.template?.volumes ?? [];
        if (volumes.length > 0)
            lines.push(
                t("detail.needsStorage", {
                    volumes: volumes.map((volume) => volume.label).join(", ")
                })
            );
        const fields = promptedEnvVars(app);
        if (fields.length > 0)
            lines.push(
                t("detail.needsSettings", { fields: fields.map((field) => field.label).join(", ") })
            );
    }
    if (app.instanceWide) lines.push(t("detail.needsOnce"));
    lines.push(t("detail.needsPermission"));
    return lines;
}
