import type { ReactNode } from "react";
import { AppNav } from "@/components/app-nav";
import { appBaseUrl } from "@/lib/domain-service";
import { getCapabilities } from "@polaris/config";
import { reachableAppIds } from "@/lib/app-access";
import { AppSidebar } from "@/components/app-sidebar";
import { AppUrlProvider } from "@/components/app-url";
import { accessFor, requireUser } from "@/lib/session";
import { AccountMenu } from "@/components/account-menu";
import { DeniedNotice } from "@/components/denied-notice";
import { ViewAsBanner } from "@/components/view-as-banner";
import { AppNavDrawer } from "@/components/app-nav-drawer";
import { ScopeSwitcher } from "@/components/scope-switcher";
import { CommandPalette } from "@/components/command-palette";
import { listNotifications } from "@/lib/notification-service";
import { UpdateIndicator } from "@/components/update-indicator";
import { SessionScopeProvider } from "@/components/session-scope";
import { NotificationBell } from "@/components/notification-bell";
import { resolveScope, scopeChoices } from "@/lib/workspace-scope";
import { RouteSkeletonCapture } from "@/components/route-skeleton";
import { DisplayFormatProvider } from "@/components/display-format";
import { AppShell, CapabilityProvider, EditionBadge } from "@polaris/ui";
import { resolveDisplayPreferencesFor } from "@/lib/display-prefs-service";
import { PresenceReporter } from "@/components/notifications/presence-reporter";
import { NotificationFavicon } from "@/components/notifications/notification-favicon";
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
    const [notifications, display, baseUrl, apps, scope, organizations] = await Promise.all([
        listNotifications(user.id),
        resolveDisplayPreferencesFor(user.id),
        appBaseUrl(),
        reachableAppIds(accessFor(user)),
        resolveScope(user.id),
        scopeChoices(user.id)
    ]);

    return (
        <CapabilityProvider capabilities={capabilities}>
            <AppUrlProvider baseUrl={baseUrl}>
                <DisplayFormatProvider preferences={display}>
                    <SessionScopeProvider userId={user.id}>
                        <NotificationsProvider initial={notifications}>
                            <NotificationFavicon />
                            <PresenceReporter />
                            <AppShell
                                switcher={
                                    <>
                                        <AppNav appIds={apps} />
                                        <ScopeSwitcher
                                            personalName={user.name}
                                            organizations={organizations}
                                            current={scope.org}
                                        />
                                    </>
                                }
                                navButton={<AppNavDrawer />}
                                search={<CommandPalette isAdmin={user.isAdmin} appIds={apps} />}
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
                                        <AccountMenu id={user.id} name={user.name} email={user.email} />
                                    </>
                                }
                            >
                                <DeniedNotice />
                                <RouteSkeletonCapture>{children}</RouteSkeletonCapture>
                                {user.viewingAs ? (
                                    <ViewAsBanner
                                        mode={user.viewingAs.mode}
                                        label={user.viewingAs.label}
                                        actorName={user.viewingAs.actorName}
                                    />
                                ) : null}
                            </AppShell>
                        </NotificationsProvider>
                    </SessionScopeProvider>
                </DisplayFormatProvider>
            </AppUrlProvider>
        </CapabilityProvider>
    );
}
