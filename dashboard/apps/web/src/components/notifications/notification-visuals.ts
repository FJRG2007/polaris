/**
 * Presentation helpers shared by the bell and the notifications page, so a
 * notification looks and reads the same wherever it is shown.
 */

import { AlertTriangle, CheckCheck, Info, ShieldAlert, ShieldCheck, type LucideIcon } from "lucide-react";
import type { NotificationAudience, NotificationLevel } from "@/lib/notification-service";
import type { NamespaceTranslator } from "@/lib/i18n/types";

/** Icon and accent color for a notification's severity. */
export function levelStyle(level: NotificationLevel, type: string): { Icon: LucideIcon; color: string } {
    if (level === "danger") return { Icon: ShieldAlert, color: "text-danger" };
    if (level === "warning") return { Icon: AlertTriangle, color: "text-warning" };
    if (level === "success") return { Icon: type.startsWith("scan") ? ShieldCheck : CheckCheck, color: "text-success" };
    return { Icon: Info, color: "text-muted-foreground" };
}

/**
 * Who the alert went to, in a form that names no one. The hint explains the
 * label on hover without ever listing the other recipients.
 */
export function describeAudience(
    audience: NotificationAudience,
    label: string | null,
    t: NamespaceTranslator<"components">
): { text: string; hint: string } {
    if (audience === "admins") return { text: t("audience.admins"), hint: t("audience.adminsHint") };
    if (audience === "everyone") return { text: t("audience.everyone"), hint: t("audience.everyoneHint") };
    if (audience === "group") {
        return label
            ? { text: label, hint: t("audience.groupNamedHint", { label }) }
            : { text: t("audience.group"), hint: t("audience.groupHint") };
    }
    return { text: t("audience.you"), hint: t("audience.youHint") };
}
