/**
 * Posting one alert to a webhook.
 *
 * Discord and Slack each want their own JSON, so an alert sent to either arrives
 * looking native rather than as a wall of text. Anything else gets the event as
 * it is, which is the only safe assumption about somebody else's endpoint and
 * the easiest thing for a script on the other end to read.
 *
 * The URL is never logged, and a provider's response body is not surfaced past
 * the reason line: a webhook URL turns up in error text more often than anyone
 * would like, and that URL is the credential.
 */

import type { NotificationLevel, WebhookFormat } from "@polaris/core";

/** What every format renders from. */
export interface WebhookPayload {
    event: string;
    level: NotificationLevel;
    title: string;
    body: string | null;
    /** Absolute link back into Polaris, when the alert has somewhere to go. */
    url: string | null;
    at: string;
}

/** Accent colour per severity, as Discord's integer and Slack's hex. */
const COLORS: Record<NotificationLevel, number> = {
    danger: 0xdc2626,
    warning: 0xf59e0b,
    success: 0x16a34a,
    info: 0x6366f1
};

/** How long to wait on somebody else's endpoint before giving up. Alerts are
 *  best effort; a webhook that hangs must not hold a deploy's finally block. */
const TIMEOUT_MS = 8_000;

function discordBody(payload: WebhookPayload): unknown {
    return {
        embeds: [
            {
                title: payload.title.slice(0, 256),
                description: payload.body?.slice(0, 4096) ?? undefined,
                url: payload.url ?? undefined,
                color: COLORS[payload.level],
                timestamp: payload.at,
                footer: { text: "Polaris" }
            }
        ]
    };
}

function slackBody(payload: WebhookPayload): unknown {
    const blocks: unknown[] = [
        {
            type: "section",
            text: { type: "mrkdwn", text: `*${payload.title}*${payload.body ? `\n${payload.body}` : ""}` }
        }
    ];
    if (payload.url) {
        blocks.push({
            type: "context",
            elements: [{ type: "mrkdwn", text: `<${payload.url}|Open in Polaris>` }]
        });
    }
    return { text: payload.title, attachments: [{ color: `#${COLORS[payload.level].toString(16).padStart(6, "0")}`, blocks }] };
}

function bodyFor(format: WebhookFormat, payload: WebhookPayload): unknown {
    if (format === "discord") return discordBody(payload);
    if (format === "slack") return slackBody(payload);
    return payload;
}

/**
 * Send one alert. Returns the reason it did not go rather than throwing - a
 * webhook nobody maintains any more must not take the alert down with it.
 */
export async function sendWebhook(
    url: string,
    format: WebhookFormat,
    payload: WebhookPayload
): Promise<{ error?: string }> {
    let res: Response;
    try {
        res = await fetch(url, {
            method: "POST",
            cache: "no-store",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(bodyFor(format, payload)),
            signal: AbortSignal.timeout(TIMEOUT_MS)
        });
    } catch (caught) {
        const timedOut = caught instanceof Error && caught.name === "TimeoutError";
        return { error: timedOut ? "The endpoint did not answer in time." : "The endpoint could not be reached." };
    }
    if (res.ok) return {};
    if (res.status === 404) return { error: "The endpoint is gone (404). It was probably deleted." };
    if (res.status === 401 || res.status === 403) return { error: "The endpoint refused the message (unauthorized)." };
    if (res.status === 429) return { error: "The endpoint is rate limiting Polaris (429)." };
    return { error: `The endpoint answered HTTP ${res.status}.` };
}
