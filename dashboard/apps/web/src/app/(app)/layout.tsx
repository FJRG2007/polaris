import type { ReactNode } from "react";
import { getCapabilities } from "@polaris/config";
import { AppShell, CapabilityProvider, EditionBadge } from "@polaris/ui";
import { AccountMenu } from "@/components/account-menu";
import { AppNav } from "@/components/app-nav";
import { AppSidebar } from "@/components/app-sidebar";
import { DisplayFormatProvider } from "@/components/display-format";
import { NotificationBell } from "@/components/notification-bell";
import { NotificationsProvider } from "@/components/notifications/notifications-provider";
import { UpdateIndicator } from "@/components/update-indicator";
import { resolveDisplayPreferencesFor } from "@/lib/display-prefs-service";
import { listNotifications } from "@/lib/notification-service";
import { requireUser } from "@/lib/session";

/**
 * Authenticated dashboard chrome. Resolves the session server-side (redirecting
 * to sign-in if absent) and hands the current capability snapshot to the client
 * provider so features degrade correctly for the running edition. The
 * notification feed is seeded here too, so the bell badge is right on the first
 * paint rather than after the live stream connects, and the user's display
 * preferences are resolved once here rather than per screen.
 */
export default async function AppLayout({ children }: { children: ReactNode }) {
    const user = await requireUser();
    const capabilities = getCapabilities();
    const [notifications, display] = await Promise.all([
        listNotifications(user.id),
        resolveDisplayPreferencesFor(user.id)
    ]);

    return (
        <CapabilityProvider capabilities={capabilities}>
            <DisplayFormatProvider preferences={display}>
                <NotificationsProvider initial={notifications}>
                    <AppShell
                        switcher={<AppNav isAdmin={user.isAdmin} />}
                        sidebar={<AppSidebar />}
                        account={
                            <>
                                {user.isAdmin ? <UpdateIndicator /> : null}
                                <NotificationBell />
                                <EditionBadge />
                                <AccountMenu name={user.name} email={user.email} />
                            </>
                        }
                    >
                        {children}
                    </AppShell>
                </NotificationsProvider>
            </DisplayFormatProvider>
        </CapabilityProvider>
    );
}
