/**
 * The Overview's cards and widths, named in the reader's language.
 *
 * The catalogue in `lib/overview/catalog.ts` is data the server reads too, and
 * keeps its English; the words are chosen where they are drawn, keyed by the
 * card's id. A card this catalog does not know yet keeps the catalogue's name.
 */

import type { OverviewWidgetSize } from "@polaris/core";
import type { NamespaceTranslator } from "@/lib/i18n/types";

type Translate = NamespaceTranslator<"home">;

export function widgetLabel(t: Translate, id: string, fallback: string): string {
    const key = `widgets.${id}.label`;
    return t.has(key) ? t(key) : fallback;
}

export function widgetDescription(t: Translate, id: string, fallback: string): string {
    const key = `widgets.${id}.description`;
    return t.has(key) ? t(key) : fallback;
}

export function sizeLabel(t: Translate, size: OverviewWidgetSize): string {
    return t(`sizes.${size}` as const);
}
