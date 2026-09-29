"use client";

/**
 * The few words the shared components say on their own - a Cancel, a "type the
 * name to confirm", a Copy.
 *
 * This package draws but does not know the language, so those words arrive from
 * whoever renders it: in English unless an app wraps its pages in
 * `UiStringsProvider` with its own, and overridable per use where one screen
 * needs different wording (`ConfirmDeleteDialog`'s `strings`).
 */

import { createContext, useContext, type ReactNode } from "react";

export interface UiStrings {
    readonly cancel: string;
    /** The heading of a delete, when the caller does not give one. `kind` is the
     *  caller's own English word for the thing ("project"). */
    readonly deleteTitle: (kind: string) => string;
    /** The button of a delete, when the caller does not give one. */
    readonly deleteConfirm: (kind: string) => string;
    /** The plain question, with the name already drawn. */
    readonly deleteQuestion: (name: ReactNode) => ReactNode;
    /** The line above the field a name is retyped into, with the name drawn. */
    readonly typeToConfirm: (name: ReactNode) => ReactNode;
    readonly copy: string;
    /** A copy button's accessible name, for the value it copies. */
    readonly copyNamed: (label: string) => string;
}

export const ENGLISH_UI_STRINGS: UiStrings = {
    cancel: "Cancel",
    deleteTitle: (kind) => `Delete ${kind}`,
    deleteConfirm: (kind) => `Delete ${kind}`,
    deleteQuestion: (name) => <>Delete {name}?</>,
    typeToConfirm: (name) => <>Type {name} to confirm.</>,
    copy: "Copy",
    copyNamed: (label) => `Copy ${label}`
};

const UiStringsContext = createContext<UiStrings>(ENGLISH_UI_STRINGS);

export function UiStringsProvider({ strings, children }: { strings: UiStrings; children: ReactNode }) {
    return <UiStringsContext.Provider value={strings}>{children}</UiStringsContext.Provider>;
}

export function useUiStrings(): UiStrings {
    return useContext(UiStringsContext);
}
