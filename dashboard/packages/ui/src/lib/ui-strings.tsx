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
    /** A dialog's close button, read out rather than drawn. */
    readonly close: string;
    /** The eye on a password field. */
    readonly showPassword: string;
    readonly hidePassword: string;
    /** A chart's reading for a moment nothing was measured, and for a range with
     *  nothing in it at all. */
    readonly noData: string;
    readonly noDataInRange: string;
    /** The hex field of a colour picker, alone and beside the caller's label. */
    readonly hexColour: string;
    readonly hexOf: (label: string) => string;
    /** The unit picker beside a size. */
    readonly unit: string;
    /** A notification's reply box and buttons, and what it says when they fail. */
    readonly reply: string;
    readonly send: string;
    readonly sent: string;
    readonly dismiss: string;
    readonly couldNotSend: string;
    readonly didNotWork: string;
    /** The phone's menu button, and the panel it opens. */
    readonly openNavigation: string;
    readonly navigation: string;
    /** A resizable panel's own menu. */
    readonly resetToDefault: string;
    readonly resetLayout: string;
    /** A table of DNS records: its columns, each record's state, and what its
     *  copy buttons copy. */
    readonly dns: {
        readonly type: string;
        readonly name: string;
        readonly content: string;
        readonly status: string;
        readonly done: string;
        readonly waiting: string;
        readonly conflict: string;
        readonly nameOf: (name: string) => string;
        readonly valueOf: (value: string) => string;
    };
}

export const ENGLISH_UI_STRINGS: UiStrings = {
    cancel: "Cancel",
    deleteTitle: (kind) => `Delete ${kind}`,
    deleteConfirm: (kind) => `Delete ${kind}`,
    deleteQuestion: (name) => <>Delete {name}?</>,
    typeToConfirm: (name) => <>Type {name} to confirm.</>,
    copy: "Copy",
    copyNamed: (label) => `Copy ${label}`,
    close: "Close",
    showPassword: "Show password",
    hidePassword: "Hide password",
    noData: "No data",
    noDataInRange: "No data in this range",
    hexColour: "Hex color",
    hexOf: (label) => `${label}: hex`,
    unit: "Unit",
    reply: "Reply",
    send: "Send",
    sent: "Sent",
    dismiss: "Dismiss",
    couldNotSend: "That could not be sent",
    didNotWork: "That did not work",
    openNavigation: "Open navigation",
    navigation: "Navigation",
    resetToDefault: "Reset to default",
    resetLayout: "Reset layout",
    dns: {
        type: "Type",
        name: "Name",
        content: "Content",
        status: "Status",
        done: "In place",
        waiting: "Not seen yet",
        conflict: "Points elsewhere",
        nameOf: (name) => `name ${name}`,
        valueOf: (value) => `value ${value}`
    }
};

const UiStringsContext = createContext<UiStrings>(ENGLISH_UI_STRINGS);

export function UiStringsProvider({ strings, children }: { strings: UiStrings; children: ReactNode }) {
    return <UiStringsContext.Provider value={strings}>{children}</UiStringsContext.Provider>;
}

export function useUiStrings(): UiStrings {
    return useContext(UiStringsContext);
}
