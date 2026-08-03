/**
 * Turning a task's comments and its history into one readable thread.
 *
 * Pure, and kept out of the component that draws it so the ordering rules can be
 * tested without a browser - the same reason the filter and grouping engine sits
 * in @polaris/core rather than inside a view.
 */

import type { ActivityView, CommentView } from "@/lib/tasks/task-service";

/** What the stream is showing: everything, or only what people said. */
export type ConversationFilter = "all" | "comments";

export type StreamItem =
    | { readonly kind: "comment"; readonly at: string; readonly comment: CommentView }
    | { readonly kind: "event"; readonly at: string; readonly line: ActivityView };

/** One history line in plain language. The stored values are already resolved to
 *  names, so this is a sentence rather than a second lookup. */
export function describeActivity(line: ActivityView): string {
    const who = line.authorName ?? "A rule";
    switch (line.action) {
        case "created":
            return `${who} created this task`;
        case "status":
            return line.fromValue
                ? `${who} moved it from ${line.fromValue} to ${line.toValue ?? "another status"}`
                : `${who} set the status to ${line.toValue ?? "another status"}`;
        case "priority":
            return `${who} changed the priority from ${line.fromValue} to ${line.toValue}`;
        case "due":
            return line.toValue ? `${who} set a due date` : `${who} cleared the due date`;
        case "assignee":
            return `${who} changed who is on it`;
        case "moved":
            return `${who} moved it to another list`;
        case "archived":
            return `${who} archived it`;
        case "recurred":
            return "It recurred and was rescheduled";
        case "automation":
            return `The rule "${line.toValue}" ran`;
        case "bulk":
            return `${who} changed it along with others`;
        default:
            return `${who} changed it`;
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
