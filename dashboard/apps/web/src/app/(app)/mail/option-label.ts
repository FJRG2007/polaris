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

export function mailOptionLabel(
    t: NamespaceTranslator<"mail">,
    group: MailOptionGroup,
    value: string
): string {
    return t(`labels.${group}.${value}` as NamespaceKey<"mail">);
}
