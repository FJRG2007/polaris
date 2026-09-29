/**
 * The label of one of core's task options (a priority, a view kind, a filter
 * operator...) in the reader's language.
 *
 * Core's `*_LABELS` maps are English and stay so - the public API and MCP tools
 * read them. The screens draw the same words from `tasks.labels`, keyed by the
 * value (`test/i18n/tasks-mail-labels.test.ts` holds the English to core's).
 */

import type { NamespaceKey, NamespaceTranslator } from "@/lib/i18n/types";

export type TaskOptionGroup =
    | "priority"
    | "statusType"
    | "statusTypeHint"
    | "customField"
    | "view"
    | "group"
    | "sort"
    | "filter"
    | "filterOperator"
    | "relativeDate"
    | "recurrence"
    | "automationTrigger"
    | "automationAction"
    | "formField"
    | "goalTarget"
    | "spaceRole"
    | "spaceRoleHint"
    | "dueBucket";

export function optionLabel(t: NamespaceTranslator<"tasks">, group: TaskOptionGroup, value: string): string {
    // An automation trigger is `task.created`; a key path would split on the dot.
    return t(`labels.${group}.${value.replace(/^task\./, "")}` as NamespaceKey<"tasks">);
}

/**
 * A group's heading in the reader's language.
 *
 * Core's `groupTasks` names the groups it makes up itself - a priority, a due
 * bucket, "Blocked", "No status", "Other" - in English. Those are drawn from the
 * catalog here; a group that is a status, a person, a tag or a list keeps the
 * name somebody gave it. `named` says whether a key is one of those, so a tag
 * that happens to be called "Other" stays as it was written.
 */
export function groupLabel(
    t: NamespaceTranslator<"tasks">,
    groupBy: string,
    group: { readonly key: string; readonly label: string },
    named: (key: string) => boolean
): string {
    if (groupBy === "none") return t("groups.all");
    if (groupBy === "priority") return optionLabel(t, "priority", group.key);
    if (groupBy === "dueDate") return optionLabel(t, "dueBucket", group.key);
    if (groupBy === "blocked") return group.key === "blocked" ? t("groups.blocked") : t("groups.notBlocked");
    if (group.key === "") {
        if (groupBy === "status") return t("groups.noStatus");
        if (groupBy === "assignee") return t("groups.unassigned");
        if (groupBy === "tag") return t("groups.noTag");
        if (groupBy === "list") return t("groups.noList");
        return t("groups.other");
    }
    return named(group.key) ? group.label : t("groups.other");
}
