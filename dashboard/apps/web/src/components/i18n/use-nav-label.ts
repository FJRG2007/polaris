"use client";

/**
 * The navigation's labels, in the reader's language.
 *
 * The app catalogue (`lib/apps.ts`) is data read by the rail, the switcher,
 * search and the Overview, and its labels stay English there - they are also
 * what search matches on. Translation happens where a label is drawn: the `nav`
 * namespace's `labels` holds every label the catalogue declares, keyed by the
 * English, and the catalog test fails when one is missing.
 *
 * Only for labels the catalogue declares. A name somebody typed - an
 * organization, an installed app - is drawn as it is, and must not be passed
 * through here: an organization called "People" is not the People screen.
 */

import { useCallback } from "react";
import { useTranslations } from "./i18n-provider";
import type { NamespaceKey } from "@/lib/i18n/types";

export function useNavLabel(): (label: string) => string {
    const t = useTranslations("nav");
    return useCallback(
        (label: string) => {
            const key = `labels.${label}`;
            return t.has(key) ? t(key as NamespaceKey<"nav">) : label;
        },
        [t]
    );
}
