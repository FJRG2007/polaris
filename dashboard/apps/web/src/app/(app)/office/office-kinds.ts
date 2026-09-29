/**
 * The office kinds' words, as catalog keys.
 *
 * Kept out of the client view so a server page can read them too: a plain value
 * exported from a "use client" module reaches a server component as a reference,
 * not as the object.
 */

import type * as core from "@polaris/core";
import type { NamespaceKey } from "@/lib/i18n/types";

/** What each kind is called, in the reader's language. */
export const OFFICE_KIND_KEYS = {
    doc: "kinds.doc",
    sheet: "kinds.sheet",
    slides: "kinds.slides",
    diagram: "kinds.diagram",
    comparison: "kinds.comparison"
} as const satisfies Record<core.OfficeKind, NamespaceKey<"office">>;

/** The same five, as a screen that lists only that kind is headed. */
export const OFFICE_KIND_PLURAL_KEYS = {
    doc: "kindsPlural.doc",
    sheet: "kindsPlural.sheet",
    slides: "kindsPlural.slides",
    diagram: "kindsPlural.diagram",
    comparison: "kindsPlural.comparison"
} as const satisfies Record<core.OfficeKind, NamespaceKey<"office">>;

/** One line on what each kind is for. */
export const OFFICE_KIND_HINT_KEYS = {
    doc: "kindHints.doc",
    sheet: "kindHints.sheet",
    slides: "kindHints.slides",
    diagram: "kindHints.diagram",
    comparison: "kindHints.comparison"
} as const satisfies Record<core.OfficeKind, NamespaceKey<"office">>;

/** What each role lets somebody do, in the reader's language. */
export const ROLE_KEYS = {
    viewer: "roles.viewer",
    commenter: "roles.commenter",
    editor: "roles.editor"
} as const satisfies Record<core.OfficeRole, NamespaceKey<"office">>;
