/**
 * A delivery's outcome in the reader's words, from the code the server stored.
 * The server keeps a code rather than a sentence so the log reads in whichever
 * language the person opening it uses.
 */

import type { NamespaceTranslator } from "@/lib/i18n/types";

const CODES = [
    "refused",
    "redirect",
    "http",
    "timeout",
    "network",
    "unreadable",
    "disabled"
] as const;

export function deliveryReason(
    t: NamespaceTranslator<"accountNotifications">,
    delivery: { error: string | null; responseStatus: number | null }
): string {
    const code = CODES.find((entry) => entry === delivery.error);
    if (!code) return "";
    const status = String(delivery.responseStatus ?? "");
    return code === "redirect" || code === "http"
        ? t(`webhooks.deliveries.errors.${code}`, { status })
        : t(`webhooks.deliveries.errors.${code}`);
}
