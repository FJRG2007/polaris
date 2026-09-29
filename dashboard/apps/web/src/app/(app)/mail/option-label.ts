/**
 * The label of one of core's mail options (a folder role, a sort, a category...)
 * in the reader's language.
 *
 * Core's `MAIL_*_LABELS` maps stay English for the API and MCP tools; screens draw
 * the same words from `mail.labels`, keyed by the value
 * (`test/i18n/tasks-mail-labels.test.ts` holds the English to core's).
 */

import type { NamespaceKey, NamespaceTranslator } from "@/lib/i18n/types";

export type MailOptionGroup =
    | "signatureAuto"
    | "category"
    | "filter"
    | "sort"
    | "folderRole"
    | "markRead"
    | "afterFiling"
    | "mailboxScope";

export function mailOptionLabel(t: NamespaceTranslator<"mail">, group: MailOptionGroup, value: string): string {
    return t(`labels.${group}.${value}` as NamespaceKey<"mail">);
}

/** What a keyboard command does, from `mail.commands` (core's
 *  `MAIL_KEY_DEFINITIONS` labels, which stay English for the API). */
export function mailCommandLabel(t: NamespaceTranslator<"mail">, command: string): string {
    return t(`commands.${command}` as NamespaceKey<"mail">);
}

/** A key as the reader's keyboard calls it: core names the arrows and Escape in
 *  English, everything else is the character on the key. */
export function mailKeyName(t: NamespaceTranslator<"mail">, label: string): string {
    if (label === "Down") return t("keys.down");
    if (label === "Up") return t("keys.up");
    if (label === "Delete") return t("keys.delete");
    if (label === "Backspace") return t("keys.backspace");
    if (label === "Enter") return t("keys.enter");
    return label;
}
