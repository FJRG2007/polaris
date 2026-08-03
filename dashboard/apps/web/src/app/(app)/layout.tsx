import type { ReactNode } from "react";
import { requireUser } from "@/lib/session";
import { AppNav } from "@/components/app-nav";
import { appBaseUrl } from "@/lib/domain-service";
import { getCapabilities } from "@polaris/config";
import { AppSidebar } from "@/components/app-sidebar";
import { AppUrlProvider } from "@/components/app-url";
import { AccountMenu } from "@/components/account-menu";
import { AppNavDrawer } from "@/components/app-nav-drawer";
import { CommandPalette } from "@/components/command-palette";
import { listNotifications } from "@/lib/notification-service";
import { UpdateIndicator } from "@/components/update-indicator";
import { NotificationBell } from "@/components/notification-bell";
import { RouteSkeletonCapture } from "@/components/route-skeleton";
import { DisplayFormatProvider } from "@/components/display-format";
import { AppShell, CapabilityProvider, EditionBadge } from "@polaris/ui";
import { resolveDisplayPreferencesFor } from "@/lib/display-prefs-service";
import { NotificationsProvider } from "@/components/notifications/notifications-provider";

/**
 * Authenticated dashboard chrome. Resolves the session server-side (redirecting
 * to sign-in if absent) and hands the current capability snapshot to the client
 * provider so features degrade correctly for the running edition. The
 * notification feed is seeded here too, so the bell badge is right on the first
 * paint rather than after the live stream connects, and the user's display
 * preferences are resolved once here rather than per screen. The same goes for
 * the address Polaris is reachable at: every screen that hands out a link builds
 * it on the configured domain instead of the hostname of the tab.
 */
export default async function AppLayout({ children }: { children: ReactNode }) {
    const user = await requireUser();
    const capabilities = getCapabilities();
    const [notifications, display, baseUrl] = await Promise.all([
        listNotifications(user.id),
        resolveDisplayPreferencesFor(user.id),
        appBaseUrl()
    ]);

    return (
        <CapabilityProvider capabilities={capabilities}>
            <AppUrlProvider baseUrl={baseUrl}>
                <DisplayFormatProvider preferences={display}>
                    <NotificationsProvider initial={notifications}>
                        <AppShell
                            switcher={<AppNav isAdmin={user.isAdmin} />}
                            navButton={<AppNavDrawer />}
                            search={<CommandPalette isAdmin={user.isAdmin} />}
                            sidebar={<AppSidebar />}
                            account={
                                <>
                                    {user.isAdmin ? <UpdateIndicator /> : null}
                                    <NotificationBell />
                                    {/* The edition reads as a sentence, so it waits for a bar
                                        wide enough to carry it next to the controls. */}
                                    <span className="hidden lg:inline-flex">
                                        <EditionBadge />
                                    </span>
                                    <AccountMenu name={user.name} email={user.email} />
                                </>
                            }
                        >
                            <RouteSkeletonCapture>{children}</RouteSkeletonCapture>
                        </AppShell>
                    </NotificationsProvider>
                </DisplayFormatProvider>
            </AppUrlProvider>
        </CapabilityProvider>
    );
}
