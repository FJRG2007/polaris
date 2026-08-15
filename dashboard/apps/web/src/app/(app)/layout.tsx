import type { ReactNode } from "react";
import { AppNav } from "@/components/app-nav";
import { appBaseUrl } from "@/lib/domain-service";
import { getCapabilities } from "@polaris/config";
import { reachableAppNav } from "@/lib/app-access";
import { AppSidebar } from "@/components/app-sidebar";
import { AppUrlProvider } from "@/components/app-url";
import { accessFor, requireUser } from "@/lib/session";
import { AccountMenu } from "@/components/account-menu";
import { DeniedNotice } from "@/components/denied-notice";
import { ViewAsBanner } from "@/components/view-as-banner";
import { AppNavDrawer } from "@/components/app-nav-drawer";
import { AppShell, CapabilityProvider, ToastProvider } from "@polaris/ui";
import { ScopeSwitcher } from "@/components/scope-switcher";
import { IncomingCalls } from "@/components/incoming-calls";
import { MessageToasts } from "@/components/message-toasts";
import { CommandPalette } from "@/components/command-palette";
import { listNotifications } from "@/lib/notification-service";
import { UpdateIndicator } from "@/components/update-indicator";
import { SessionScopeProvider } from "@/components/session-scope";
import { NotificationBell } from "@/components/notification-bell";
import { resolveScope, scopeChoices } from "@/lib/workspace-scope";
import { RouteSkeletonCapture } from "@/components/route-skeleton";
import { DisplayFormatProvider } from "@/components/display-format";
import { VisitRecorder } from "@/components/overview/visit-recorder";
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
 * it on the configured domain instead of the hostname of the tab. Where the
 * reader has been is noted here as well, once for the whole shell, so a screen
 * added anywhere turns up on their Overview without doing anything.
 */
export default async function AppLayout({ children }: { children: ReactNode }) {
    const user = await requireUser();
    const capabilities = getCapabilities();
    const [notifications, display, baseUrl, apps, scope, organizations] = await Promise.all([
        listNotifications(user.id),
        resolveDisplayPreferencesFor(user.id),
        appBaseUrl(),
        reachableAppNav(accessFor(user)),
        resolveScope(user.id),
        scopeChoices(user.id)
    ]);

    return (
        <CapabilityProvider capabilities={capabilities}>
            <AppUrlProvider baseUrl={baseUrl}>
                <DisplayFormatProvider preferences={display}>
                    <SessionScopeProvider userId={user.id}>
                        <NotificationsProvider initial={notifications}>
                            <ToastProvider>
                                <NotificationFavicon />
                                <PresenceReporter />
                                <VisitRecorder />
                                {/* Out here rather than inside Chat: a call you only
                                    hear about while looking at the conversation it
                                    is in is a notice, not a call. Only for somebody
                                    who has Chat at all - the stream it listens on
                                    refuses anybody else. */}
                                {apps.ids.includes("chat") ? <IncomingCalls /> : null}
                                {/* Messages announce themselves in the corner and
                                    are then gone. Never through the bell: that is a
                                    record of things to come back to, and a chat
                                    message would bury the four that are. */}
                                {apps.ids.includes("chat") ? <MessageToasts /> : null}
                                <AppShell
                                    switcher={
                                        <>
                                            <AppNav appIds={apps.ids} guestAppIds={apps.guestIds} />
                                            <ScopeSwitcher
                                                personalName={user.name}
                                                organizations={organizations}
                                                current={scope.org}
                                            />
                                        </>
                                    }
                                    navButton={<AppNavDrawer appIds={apps.ids} />}
                                    search={<CommandPalette isAdmin={user.isAdmin} appIds={apps.ids} />}
                                    sidebar={<AppSidebar appIds={apps.ids} />}
                                    account={
                                        <>
                                            {user.isAdmin ? <UpdateIndicator /> : null}
                                            <NotificationBell />
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
                            </ToastProvider>
                        </NotificationsProvider>
                    </SessionScopeProvider>
                </DisplayFormatProvider>
            </AppUrlProvider>
        </CapabilityProvider>
    );
}
