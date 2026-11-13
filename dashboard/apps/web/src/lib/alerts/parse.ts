/**
 * What an alert says, read from the three shapes a topic accepts.
 *
 * - ntfy (https://docs.ntfy.sh/publish/): a plain-text body with the fields as
 *   headers (`Title`/`X-Title`/`t`, `Priority`/`X-Priority`/`p`, `Tags`, `Click`,
 *   `Actions`, `Markdown`, `Icon`, `Attach`) or as the same names in the query
 *   string; or a JSON object with `topic`, `message`, `title`, `priority`,
 *   `tags`, `click`, `actions`, `markdown`, `icon`, `attach`.
 * - Gotify (https://gotify.net/api-docs): `POST /message` with `title`,
 *   `message`, `priority` (0-10) and `extras`, as JSON or a form.
 * - Polaris' JSON: the ntfy JSON fields, plus `severity` (1-5 or a name) and
 *   `dedupKey`.
 *
 * Pure: nothing here fetches, stores or trusts. Every URL is kept only when it
 * is http or https with no credentials in it; a field that is too long is
 * refused rather than cut, except the message, which is cut at ntfy's own limit
 * so a chatty monitor still gets its alert through.
 */

import { z } from "zod";
import { ALERT_LIMITS, alertPriority, gotifyPriority, type AlertPriority } from "@polaris/core";

export interface AlertAction {
    readonly label: string;
    readonly url: string;
}

export interface AlertMessage {
    readonly title: string;
    readonly message: string;
    /** Null when the sender named none: the topic's default applies. */
    readonly priority: AlertPriority | null;
    readonly tags: readonly string[];
    readonly click: string | null;
    readonly icon: string | null;
    readonly attach: string | null;
    readonly markdown: boolean;
    readonly actions: readonly AlertAction[];
    readonly dedupKey: string | null;
}

export type AlertParse =
    | { readonly ok: true; readonly alert: AlertMessage }
    | { readonly ok: false; readonly error: string };

/** A link an alert may carry: http or https, no user or password, bounded. */
export function safeAlertUrl(value: unknown): string | null {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > ALERT_LIMITS.url) return null;
    let url: URL;
    try {
        url = new URL(trimmed);
    } catch {
        return null;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username || url.password) return null;
    return url.toString();
}

const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

function clean(value: string): string {
    return value.replace(CONTROL, "").trim();
}

function truthy(value: unknown): boolean {
    if (typeof value === "boolean") return value;
    if (typeof value !== "string") return false;
    return ["1", "yes", "true", "on"].includes(value.trim().toLowerCase());
}

/** Tags from a comma list or an array: trimmed, empty ones dropped. */
function tagList(value: unknown): string[] | null {
    const raw = Array.isArray(value)
        ? value
        : typeof value === "string"
          ? value.split(",")
          : [];
    const tags = raw
        .filter((tag): tag is string => typeof tag === "string")
        .map(clean)
        .filter(Boolean);
    if (tags.length > ALERT_LIMITS.tags) return null;
    if (tags.some((tag) => tag.length > ALERT_LIMITS.tag)) return null;
    return [...new Set(tags)];
}

/**
 * ntfy's `Actions` header: `view, Label, https://url[, clear=true]` entries
 * separated by `;`. Only view actions are kept - Polaris opens links, it does
 * not make requests on a sender's behalf, so `http` and `broadcast` are dropped.
 */
export function headerActions(value: string): AlertAction[] {
    const actions: AlertAction[] = [];
    for (const entry of value.split(";")) {
        const [kind, label, url] = entry.split(",").map((part) => part.trim());
        if (kind?.replace(/^action=/, "") !== "view" || !label || !url) continue;
        const safe = safeAlertUrl(url.replace(/^url=/, ""));
        if (!safe) continue;
        actions.push({ label: label.replace(/^label=/, "").slice(0, ALERT_LIMITS.actionLabel), url: safe });
    }
    return actions;
}

function jsonActions(value: unknown): AlertAction[] {
    if (typeof value === "string") return headerActions(value);
    if (!Array.isArray(value)) return [];
    const actions: AlertAction[] = [];
    for (const entry of value) {
        if (!entry || typeof entry !== "object") continue;
        const { action, label, url } = entry as Record<string, unknown>;
        if (action !== "view" || typeof label !== "string") continue;
        const safe = safeAlertUrl(url);
        const name = clean(label).slice(0, ALERT_LIMITS.actionLabel);
        if (safe && name) actions.push({ label: name, url: safe });
    }
    return actions;
}

interface Fields {
    title?: unknown;
    message?: unknown;
    priority?: AlertPriority | null;
    tags?: unknown;
    click?: unknown;
    icon?: unknown;
    attach?: unknown;
    markdown?: unknown;
    actions?: AlertAction[];
    dedupKey?: unknown;
}

/** The checks every shape ends in. */
function finish(fields: Fields): AlertParse {
    const title = typeof fields.title === "string" ? clean(fields.title) : "";
    if (title.length > ALERT_LIMITS.title) return { ok: false, error: "Title is too long" };
    let message = typeof fields.message === "string" ? fields.message.replace(CONTROL, "").trim() : "";
    if (message.length > ALERT_LIMITS.message) message = `${message.slice(0, ALERT_LIMITS.message - 3)}...`;
    if (!message && !title) return { ok: false, error: "The message is empty" };
    const tags = tagList(fields.tags);
    if (!tags) return { ok: false, error: `At most ${ALERT_LIMITS.tags} tags of ${ALERT_LIMITS.tag} characters` };
    const dedup = typeof fields.dedupKey === "string" ? clean(fields.dedupKey) : "";
    if (dedup.length > ALERT_LIMITS.dedupKey) return { ok: false, error: "Dedup key is too long" };
    return {
        ok: true,
        alert: {
            title,
            message: message || title,
            priority: fields.priority ?? null,
            tags,
            click: safeAlertUrl(fields.click),
            icon: safeAlertUrl(fields.icon),
            attach: safeAlertUrl(fields.attach),
            markdown: truthy(fields.markdown),
            actions: (fields.actions ?? []).slice(0, ALERT_LIMITS.actions),
            dedupKey: dedup || null
        }
    };
}

/** A priority the sender gave, or an error when it gave one that means nothing. */
function priorityOf(value: unknown): AlertPriority | null | "bad" {
    if (value === undefined || value === null || value === "") return null;
    return alertPriority(value) ?? "bad";
}

/** Header (or query) lookup by any of ntfy's spellings. */
function pick(headers: Headers, query: URLSearchParams, names: readonly string[]): string | undefined {
    for (const name of names) {
        const value = headers.get(name) ?? query.get(name);
        if (value !== null) return value;
    }
    return undefined;
}

/** An ntfy publish: the body is the message, the rest is headers or query. */
export function parseNtfyText(headers: Headers, query: URLSearchParams, body: string): AlertParse {
    const priority = priorityOf(pick(headers, query, ["x-priority", "priority", "prio", "p"]));
    if (priority === "bad") return { ok: false, error: "Priority must be 1-5 or min, low, default, high, urgent" };
    const type = headers.get("content-type") ?? "";
    const message = pick(headers, query, ["x-message", "message", "m"]) ?? body;
    return finish({
        title: pick(headers, query, ["x-title", "title", "ti", "t"]),
        message,
        priority,
        tags: pick(headers, query, ["x-tags", "tags", "tag", "ta"]),
        click: pick(headers, query, ["x-click", "click"]),
        icon: pick(headers, query, ["x-icon", "icon"]),
        attach: pick(headers, query, ["x-attach", "attach", "a"]),
        markdown: pick(headers, query, ["x-markdown", "markdown", "md"]) ?? type.startsWith("text/markdown"),
        actions: headerActions(pick(headers, query, ["x-actions", "actions", "action"]) ?? ""),
        dedupKey: pick(headers, query, ["x-dedup-key", "dedup-key", "dedup"])
    });
}

const L = ALERT_LIMITS;
const str = (max: number) => z.string().max(max);
const tagsField = z.union([str(L.tags * (L.tag + 1)), z.array(str(L.tag)).max(L.tags)]);
const priorityField = z.union([z.number(), str(10)]);
const actionsField = z.union([
    str(L.actions * (L.url + L.actionLabel + 20)),
    z
        .array(
            z
                .object({
                    action: str(20),
                    label: str(L.actionLabel),
                    url: str(L.url).optional(),
                    clear: z.boolean().optional(),
                    method: str(10).optional(),
                    headers: z.record(str(500)).optional(),
                    body: str(L.message).optional(),
                    intent: str(200).optional(),
                    extras: z.record(str(500)).optional()
                })
                .strict()
        )
        .max(L.actions)
]);

/** The fields ntfy's JSON publish documents; anything else is refused. */
export const ntfyJsonSchema = z
    .object({
        topic: str(200),
        message: str(L.message * 4).optional(),
        title: str(L.title).optional(),
        tags: tagsField.optional(),
        priority: priorityField.optional(),
        actions: actionsField.optional(),
        click: str(L.url).optional(),
        attach: str(L.url).optional(),
        markdown: z.boolean().optional(),
        icon: str(L.url).optional(),
        filename: str(255).optional(),
        delay: str(50).optional(),
        email: str(320).optional(),
        call: str(50).optional()
    })
    .strict();

/** Polaris' own JSON: a fixed shape, unknown keys refused. */
export const nativeAlertSchema = z
    .object({
        message: str(L.message * 4).optional(),
        title: str(L.title).optional(),
        severity: priorityField.optional(),
        priority: priorityField.optional(),
        tags: tagsField.optional(),
        click: str(L.url).optional(),
        icon: str(L.url).optional(),
        attach: str(L.url).optional(),
        markdown: z.boolean().optional(),
        actions: actionsField.optional(),
        dedupKey: str(L.dedupKey).optional()
    })
    .strict();

/** Gotify's create-message body. */
export const gotifySchema = z
    .object({
        title: str(L.title).optional(),
        message: str(L.message * 4),
        priority: z.union([z.number(), str(3)]).optional(),
        extras: z.record(z.record(z.unknown())).optional()
    })
    .strict();

function refused(issues: z.ZodIssue[]): AlertParse {
    const issue = issues[0];
    if (issue?.code === "unrecognized_keys") return { ok: false, error: `Unknown field: ${issue.keys[0] ?? ""}`.slice(0, 80) };
    const field = issue?.path.join(".") || "body";
    return { ok: false, error: `Invalid field: ${field}`.slice(0, 80) };
}

function fromJson(data: z.infer<typeof nativeAlertSchema> | z.infer<typeof ntfyJsonSchema>): AlertParse {
    const priority = priorityOf("severity" in data && data.severity !== undefined ? data.severity : data.priority);
    if (priority === "bad") return { ok: false, error: "Priority must be 1-5 or min, low, default, high, urgent" };
    return finish({
        title: data.title,
        message: data.message,
        priority,
        tags: data.tags,
        click: data.click,
        icon: data.icon,
        attach: data.attach,
        markdown: data.markdown,
        actions: jsonActions(data.actions),
        dedupKey: "dedupKey" in data ? data.dedupKey : undefined
    });
}

/** ntfy's JSON publish. `topic` is the credential and is read by the route. */
export function parseNtfyJson(body: unknown): AlertParse {
    const parsed = ntfyJsonSchema.safeParse(body);
    return parsed.success ? fromJson(parsed.data) : refused(parsed.error.issues);
}

/** Polaris' own JSON publish. */
export function parseAlertJson(body: unknown): AlertParse {
    const parsed = nativeAlertSchema.safeParse(body);
    return parsed.success ? fromJson(parsed.data) : refused(parsed.error.issues);
}

/** Gotify's message: priority 0-10, Markdown and click through `extras`. */
export function parseGotify(body: unknown): AlertParse {
    const parsed = gotifySchema.safeParse(body);
    if (!parsed.success) return refused(parsed.error.issues);
    const data = parsed.data;
    const raw = data.priority;
    const number = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() ? Number(raw) : null;
    if (number !== null && !Number.isFinite(number)) return { ok: false, error: "Priority must be a number" };
    const extras = data.extras ?? {};
    const display = extras["client::display"] ?? {};
    const notification = extras["client::notification"] ?? {};
    const click = (notification.click ?? {}) as Record<string, unknown>;
    return finish({
        title: data.title,
        message: data.message,
        priority: number === null ? null : gotifyPriority(number),
        click: click.url,
        markdown: display.contentType === "text/markdown"
    });
}
