"use client";

import { useCallback } from "react";
import { localizeApp } from "@/lib/apps/app-words";
import type { NamespaceKey } from "@/lib/i18n/types";
import type { AppManifest } from "@/lib/apps/catalog";
import { useNavLabel } from "@/components/i18n/use-nav-label";
import { useTranslations } from "@/components/i18n/i18n-provider";

/**
 * A store entry in the reader's words. A catalog app reads its own catalog
 * entry; a Deploy template reads the line Deploy's template picker shows for
 * it, so the two places never describe one template differently.
 */
export function useLocalizeStoreApp(): (app: AppManifest) => AppManifest {
    const words = useTranslations("catalog");
    const deploy = useTranslations("deploy");
    const navLabel = useNavLabel();
    return useCallback(
        (app: AppManifest) => {
            if (!app.deployTemplate) return localizeApp(words, app, navLabel);
            const key = `view.template.catalog.${app.deployTemplate}.description`;
            const line = deploy.has(key) ? deploy(key as NamespaceKey<"deploy">) : app.summary;
            return { ...app, summary: line, description: line };
        },
        [words, deploy, navLabel]
    );
}
