/**
 * Turning a task's comments and its history into one readable thread.
 *
 * Pure, and kept out of the component that draws it so the ordering rules can be
 * tested without a browser - the same reason the filter and grouping engine sits
 * in @polaris/core rather than inside a view.
 */

import type { NamespaceTranslator } from "@/lib/i18n/types";
import type { ActivityView, CommentView } from "@/lib/tasks/task-service";

/** What the stream is showing: everything, or only what people said. */
export type ConversationFilter = "all" | "comments";

export type StreamItem =
    | { readonly kind: "comment"; readonly at: string; readonly comment: CommentView }
    | { readonly kind: "event"; readonly at: string; readonly line: ActivityView };

/** One history line in plain language. The stored values are already resolved to
 *  names, so this is a sentence rather than a second lookup. */
export function describeActivity(t: NamespaceTranslator<"tasksDetail">, line: ActivityView): string {
    const who = line.authorName ?? t("activity.aRule");
    const another = t("activity.anotherStatus");
    switch (line.action) {
        case "created":
            return t("activity.created", { who });
        case "status":
            return line.fromValue
                ? t("activity.statusMoved", { who, from: line.fromValue, to: line.toValue ?? another })
                : t("activity.statusSet", { who, to: line.toValue ?? another });
        case "priority":
            return t("activity.priority", { who, from: line.fromValue ?? "", to: line.toValue ?? "" });
        case "due":
            return line.toValue ? t("activity.dueSet", { who }) : t("activity.dueCleared", { who });
        case "assignee":
            return t("activity.assignee", { who });
        case "moved":
            return t("activity.moved", { who });
        case "blocked":
            // The reason is worth repeating here: the block itself may be gone by
            // the time anybody reads back, and why it was there is the part that
            // explains the week this task did not move.
            return line.toValue
                ? t("activity.blockedWhy", { who, reason: line.toValue })
                : t("activity.blocked", { who });
        case "unblocked":
            return t("activity.unblocked", { who });
        case "archived":
            return t("activity.archived", { who });
        case "recurred":
            return t("activity.recurred");
        case "automation":
            return t("activity.automation", { rule: line.toValue ?? "" });
        case "bulk":
            return t("activity.bulk", { who });
        default:
            return t("activity.changed", { who });
    }
}

/**
 * Comments and history in one list, oldest first, so the newest line sits next
 * to the box you write in. Replies are left out: they are drawn under the
 * comment they answer, and putting them here as well would show each one twice.
 */
export function mergeConversation(
    comments: readonly CommentView[],
    activity: readonly ActivityView[],
    filter: ConversationFilter
): StreamItem[] {
    const items: StreamItem[] = comments
        .filter((comment) => !comment.parentId)
        .map((comment) => ({ kind: "comment", at: comment.createdAt, comment }) as const);
    if (filter === "all") {
        items.push(...activity.map((line) => ({ kind: "event", at: line.createdAt, line }) as const));
    }
    // Both timestamps are ISO instants, which sort correctly as strings.
    return items.sort((left, right) => left.at.localeCompare(right.at));
}
