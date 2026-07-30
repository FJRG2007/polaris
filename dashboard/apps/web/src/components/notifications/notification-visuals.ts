/**
 * Presentation helpers shared by the bell and the notifications page, so a
 * notification looks and reads the same wherever it is shown.
 */

import { AlertTriangle, CheckCheck, Info, ShieldAlert, ShieldCheck, type LucideIcon } from "lucide-react";
import type { NotificationAudience, NotificationLevel } from "@/lib/notification-service";

/** Icon and accent color for a notification's severity. */
export function levelStyle(level: NotificationLevel, type: string): { Icon: LucideIcon; color: string } {
    if (level === "danger") return { Icon: ShieldAlert, color: "text-danger" };
    if (level === "warning") return { Icon: AlertTriangle, color: "text-amber-500" };
    if (level === "success") return { Icon: type.startsWith("scan") ? ShieldCheck : CheckCheck, color: "text-success" };
    return { Icon: Info, color: "text-muted-foreground" };
}

/**
 * Who the alert went to, in a form that names no one. The hint explains the
 * label on hover without ever listing the other recipients.
 */
export function describeAudience(
    audience: NotificationAudience,
    label: string | null
): { text: string; hint: string } {
    if (audience === "admins") return { text: "Admins", hint: "Sent to every administrator" };
    if (audience === "everyone") return { text: "You and others", hint: "Sent to more than one person" };
    if (audience === "group") {
        return label
            ? { text: label, hint: `Sent to the ${label} group` }
            : { text: "A group", hint: "Sent to a group you belong to" };
    }
    return { text: "You", hint: "Sent only to you" };
}
