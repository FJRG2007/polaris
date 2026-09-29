/**
 * The app catalogue's words, in the reader's language.
 *
 * The manifests (`catalog.ts`) are data, in English: the install path reads
 * them, and a manifest is the same whoever opens it. What a screen draws from
 * one - an app's name and summary, a setting's label, its help, its choices -
 * is translated where it is drawn, from the `catalog` namespace: an app's words
 * by its id, a label keyed by its English the way `nav.labels` is. Anything with
 * no entry is drawn as written, which is right for the names of products, maps
 * and server software.
 *
 * Pure, and free of server imports, so the marketplace can use it in the
 * browser and the settings read can use it on the server.
 */

import type { AppManifest } from "./catalog";
import type { NamespaceTranslator } from "@/lib/i18n/types";

type Words = NamespaceTranslator<"catalog">;

/** How the words a catalog entry does not have are drawn: as written, or
 *  through another table (the rail's labels, for an app named after a screen). */
type Fallback = (english: string) => string;

const asWritten: Fallback = (english) => english;

function lookup(t: Words, key: string, fallback: string): string {
    return t.has(key) ? t(key) : fallback;
}

/** A setting label, a choice or a heading from a manifest. */
export function catalogLabel(t: Words, english: string, fallback: Fallback = asWritten): string {
    return lookup(t, `labels.${english}`, fallback(english));
}

/** A marketplace category. */
export function categoryLabel(t: Words, category: string, fallback: Fallback = asWritten): string {
    return lookup(t, `categories.${category}`, fallback(category));
}

/** An app's name, by catalog id, with the manifest's English as the default. */
export function appName(t: Words, id: string, english: string, fallback: Fallback = asWritten): string {
    return lookup(t, `apps.${id}.name`, fallback(english));
}

/** A manifest as the reader reads it: name, summary, description, consent and
 *  the storage and settings the install wizard shows. Ids and values are left
 *  alone, so what is installed is the same in every language. */
export function localizeApp(t: Words, app: AppManifest, fallback: Fallback = asWritten): AppManifest {
    const template = app.template;
    return {
        ...app,
        name: appName(t, app.id, app.name, fallback),
        summary: lookup(t, `apps.${app.id}.summary`, app.summary),
        description: lookup(t, `apps.${app.id}.description`, app.description),
        ...(app.consent ? { consent: { ...app.consent, label: catalogLabel(t, app.consent.label) } } : {}),
        ...(template
            ? {
                  template: {
                      ...template,
                      volumes: template.volumes?.map((volume) => ({ ...volume, label: catalogLabel(t, volume.label) })),
                      env: template.env?.map((field) => localizeSetting(t, app.id, field))
                  }
              }
            : {})
    };
}

/**
 * One setting as the reader reads it.
 *
 * `group` stays the English it was declared with, because screens compare it to
 * find a section; the heading to draw for it is `groupLabel`.
 */
export function localizeSetting<
    S extends {
        key: string;
        label: string;
        help?: string;
        group?: string;
        options?: ReadonlyArray<{ value: string; label: string }>;
    }
>(t: Words, appId: string, setting: S): S & { groupLabel?: string } {
    return {
        ...setting,
        label: catalogLabel(t, setting.label),
        ...(setting.help ? { help: lookup(t, `help.${appId}.${setting.key}`, setting.help) } : {}),
        ...(setting.group ? { groupLabel: catalogLabel(t, setting.group) } : {}),
        ...(setting.options
            ? { options: setting.options.map((option) => ({ ...option, label: catalogLabel(t, option.label) })) }
            : {})
    };
}
