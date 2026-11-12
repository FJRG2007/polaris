import { chatAvatarUrl } from "@/lib/avatar-url";

/**
 * The picture a webhook message is drawn with, as an address on Polaris.
 *
 * The one the request asked for (`avatar_url`) wins, served back through
 * Polaris by the message's id so the reader's browser never contacts the
 * remote site. Otherwise the webhook's own picture, versioned by when it last
 * changed. Null draws the webhook mark: no picture of either kind, or a
 * message that did not come through a webhook.
 */
export function webhookFace(
    row: { id: string; webhookId?: string | null; authorAvatarUrl?: string | null },
    faces: ReadonlyMap<string, Date>
): string | null {
    if (!row.webhookId) return null;
    if (row.authorAvatarUrl) return `/api/chat/webhook-avatar/${row.id}`;
    const changed = faces.get(row.webhookId);
    return changed ? `${chatAvatarUrl("webhook", row.webhookId)}?v=${changed.getTime()}` : null;
}
