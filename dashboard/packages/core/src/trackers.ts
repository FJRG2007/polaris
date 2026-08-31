/**
 * Issue trackers somebody else runs, brought into Tasks.
 *
 * Most teams that would use Polaris already have work written down somewhere -
 * Linear, Jira - and are not going to move it. What they want is one board that
 * shows all of it, and an agent that can be handed any of it without a person
 * copying the description across. So a tracker is not an import: it is a link
 * that keeps working, in both directions, on the two fields that actually change
 * hands - the status and the conversation.
 *
 * Pure. Everything about talking to a provider lives in the dashboard; what is
 * here is the vocabulary, the mapping between their statuses and ours, and the
 * flattening a provider's rich-text description needs before it is text.
 */

import { TASK_STATUS_TYPES, type TaskStatusType } from "./schemas/tasks.js";

/** The trackers Polaris can connect to. */
export const ISSUE_TRACKERS = ["linear", "jira"] as const;
export type IssueTracker = (typeof ISSUE_TRACKERS)[number];

export const ISSUE_TRACKER_LABELS: Record<IssueTracker, string> = {
    linear: "Linear",
    jira: "Jira"
};

/**
 * What each connection needs, in the words its own settings screen uses.
 *
 * Stated here so the form and the client cannot disagree about what a connection
 * IS. Linear is one key; Jira is a site, an account and a token, because its API
 * authenticates as a person rather than as an application.
 */
export const ISSUE_TRACKER_FIELDS: Record<
    IssueTracker,
    { readonly key: string; readonly label: string; readonly hint: string; readonly secret: boolean }[]
> = {
    linear: [
        {
            key: "apiKey",
            label: "Personal API key",
            hint: "Linear > Settings > Security & access > Personal API keys.",
            secret: true
        }
    ],
    jira: [
        {
            key: "site",
            label: "Site",
            hint: "The address you use for Jira, such as your-company.atlassian.net.",
            secret: false
        },
        { key: "email", label: "Account email", hint: "The account the token belongs to.", secret: false },
        {
            key: "apiToken",
            label: "API token",
            hint: "id.atlassian.com > Security > Create and manage API tokens.",
            secret: true
        }
    ]
};

/**
 * One issue, as Polaris sees it whichever tracker it came from.
 *
 * `key` is what a person quotes - "ENG-42", "PROJ-7" - and is the same string in
 * both providers' worlds, which is why it is what a link is looked up by rather
 * than the opaque id beside it.
 */
export interface TrackerIssue {
    readonly id: string;
    readonly key: string;
    readonly title: string;
    readonly description: string;
    readonly url: string;
    /** The status as the tracker names it, for showing. */
    readonly status: string;
    /** What that status MEANS, which is what Polaris can act on. */
    readonly statusType: TaskStatusType;
    readonly assignee: string;
    readonly updatedAt: string;
}

/**
 * A remote status category, turned into one of ours.
 *
 * Both providers group their statuses, and the group is the only part that is
 * portable: a team can call a state anything, but Linear says whether it is
 * `started` and Jira says whether it is `indeterminate`. Names are matched only
 * as a fallback, and deliberately loosely - the alternative is every connection
 * needing a mapping table before it does anything at all.
 */
export function statusTypeFromTracker(tracker: IssueTracker, category: string, name: string): TaskStatusType {
    const group = category.toLowerCase();
    if (tracker === "linear") {
        // Linear's own state types.
        if (group === "started") return "active";
        if (group === "completed") return "done";
        if (group === "canceled" || group === "cancelled") return "closed";
        if (group === "backlog" || group === "unstarted" || group === "triage") return "open";
    } else {
        // Jira's three status categories, by the key its API returns.
        if (group === "indeterminate" || group === "in progress") return "active";
        if (group === "done") return "done";
        if (group === "new" || group === "to do" || group === "undefined") return "open";
    }
    return statusTypeFromName(name);
}

/** The last resort: read the status's own name. Wrong sometimes, and better than
 *  putting everything in one column. */
export function statusTypeFromName(name: string): TaskStatusType {
    const flat = name.toLowerCase();
    if (/(cancel|won'?t|reject|dupl)/.test(flat)) return "closed";
    if (/(done|complete|closed|resolved|shipped|merged)/.test(flat)) return "done";
    if (/(block|hold|waiting|pending)/.test(flat)) return "blocked";
    if (/(progress|doing|active|review|started|develop)/.test(flat)) return "active";
    return "open";
}

/** Whether a stored value still names a tracker this build knows. */
export function isIssueTracker(value: string): value is IssueTracker {
    return (ISSUE_TRACKERS as readonly string[]).includes(value);
}

/** Whether a stored value still names a status type this build knows. */
export function isTaskStatusType(value: string): value is TaskStatusType {
    return (TASK_STATUS_TYPES as readonly string[]).includes(value);
}

/**
 * Flatten Jira's rich text into something a task description can hold.
 *
 * Jira's current API returns descriptions as a document tree rather than as
 * text, and a task in Polaris holds Markdown. This is not a conversion: it takes
 * the words, the line breaks, the list markers and the links, and drops the rest.
 * A description that came through here reads correctly and has lost its tables -
 * which is the honest trade, because the alternative is a task whose description
 * is a page of JSON.
 */
export function flattenRichText(node: unknown): string {
    if (typeof node === "string") return node;
    if (Array.isArray(node)) return node.map(flattenRichText).join("");
    if (!node || typeof node !== "object") return "";

    const record = node as Record<string, unknown>;
    const type = typeof record.type === "string" ? record.type : "";
    const content = flattenRichText(record.content);

    switch (type) {
        case "text": {
            const text = typeof record.text === "string" ? record.text : "";
            const link = linkHref(record.marks);
            return link ? `[${text}](${link})` : text;
        }
        case "hardBreak":
            return "\n";
        case "paragraph":
        case "heading":
            return `${content}\n\n`;
        case "listItem":
            return `- ${content.trim()}\n`;
        case "bulletList":
        case "orderedList":
            return `${content}\n`;
        case "codeBlock":
            return `\n\`\`\`\n${content.trim()}\n\`\`\`\n\n`;
        case "blockquote":
            return `> ${content.trim()}\n\n`;
        case "rule":
            return "\n---\n\n";
        default:
            return content;
    }
}

/** The href on a text node, when one of its marks is a link. */
function linkHref(marks: unknown): string {
    if (!Array.isArray(marks)) return "";
    for (const mark of marks) {
        if (!mark || typeof mark !== "object") continue;
        const record = mark as Record<string, unknown>;
        if (record.type !== "link") continue;
        const attrs = record.attrs as Record<string, unknown> | undefined;
        if (attrs && typeof attrs.href === "string") return attrs.href;
    }
    return "";
}

/**
 * The description a linked task is given.
 *
 * The tracker's own text, with a line saying where it came from. Kept because a
 * Polaris task that says nothing about being a mirror is a task somebody will
 * edit, wondering later why their edit went nowhere.
 */
export function linkedDescription(issue: TrackerIssue, tracker: IssueTracker): string {
    const origin = `Mirrored from [${issue.key}](${issue.url}) in ${ISSUE_TRACKER_LABELS[tracker]}.`;
    return issue.description.trim() ? `${issue.description.trim()}\n\n---\n\n${origin}` : origin;
}
