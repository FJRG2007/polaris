import type { ReactNode } from "react";
import { AppNav } from "@/components/app-nav";
import { appBaseUrl } from "@/lib/domain-service";
import { getCapabilities } from "@polaris/config";
import { reachableAppNav } from "@/lib/app-access";
import { AppSidebar } from "@/components/app-sidebar";
import { AppUrlProvider } from "@/components/app-url";
import { CallHolder } from "@/components/call-holder";
import { accessFor, requireUser } from "@/lib/session";
import { AccountMenu } from "@/components/account-menu";
import { DeniedNotice } from "@/components/denied-notice";
import { ownStatus, presenceChoiceOf } from "@/lib/presence-service";
import { ViewAsBanner } from "@/components/view-as-banner";
import { AppNavDrawer } from "@/components/app-nav-drawer";
import { ScopeSwitcher } from "@/components/scope-switcher";
import { IncomingCalls } from "@/components/incoming-calls";
import { CallElsewhere } from "@/app/(app)/chat/call-elsewhere";
import { MessageToasts } from "@/components/message-toasts";
import { CommandPalette } from "@/components/command-palette";
import { PresenceProvider } from "@/components/presence-store";
import { listNotifications } from "@/lib/notification-service";
import { UpdateIndicator } from "@/components/update-indicator";
import { SessionScopeProvider } from "@/components/session-scope";
import { NotificationBell } from "@/components/notification-bell";
import { resolveScope, scopeChoices } from "@/lib/workspace-scope";
import { RouteSkeletonCapture } from "@/components/route-skeleton";
import { DisplayFormatProvider } from "@/components/display-format";
import { VisitRecorder } from "@/components/overview/visit-recorder";
import { AppShell, CapabilityProvider, ToastProvider } from "@polaris/ui";
import { resolveDisplayPreferencesFor } from "@/lib/display-prefs-service";
import { PresenceReporter } from "@/components/notifications/presence-reporter";
import { unreadTotal } from "@/lib/chat/chat-service";
import { ChatUnreadProvider } from "@/components/chat-unread";
import { NotificationFavicon } from "@/components/notifications/notification-favicon";
import { buildStamp } from "@/lib/build-stamp";
import { NewBuildBanner } from "@/components/new-build-banner";
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
/** Nothing waiting. Named so the two branches below cannot drift apart. */
const NO_CHAT_UNREAD = { messages: 0, conversations: 0 };

export default async function AppLayout({ children }: { children: ReactNode }) {
    const user = await requireUser();
    const capabilities = getCapabilities();
    const [notifications, display, baseUrl, apps, scope, organizations, presence, status] =
        await Promise.all([
            listNotifications(user.id),
            resolveDisplayPreferencesFor(user.id),
            appBaseUrl(),
            reachableAppNav(accessFor(user)),
            resolveScope(user.id),
            scopeChoices(user.id),
            presenceChoiceOf(user.id),
            ownStatus(user.id)
        ]);
    // Seeded here rather than fetched by the provider, so the badge on the tab
    // icon is right on the first paint instead of appearing a second into the
    // page - which reads as a message that has just arrived when it has been
    // waiting since yesterday. Only for somebody who has Chat: the count is
    // zero for everybody else and asking would be a query per page load.
    const chatUnread = apps.ids.includes("chat")
        ? await unreadTotal({ id: user.id }).catch(() => NO_CHAT_UNREAD)
        : NO_CHAT_UNREAD;

    return (
        <CapabilityProvider capabilities={capabilities}>
            <AppUrlProvider baseUrl={baseUrl}>
                <DisplayFormatProvider preferences={display}>
                    <SessionScopeProvider userId={user.id}>
                        <ChatUnreadProvider
                            initial={chatUnread}
                            enabled={apps.ids.includes("chat")}
                        >
                            <NotificationsProvider initial={notifications}>
                                <ToastProvider>
                                    {/* Where everybody on screen is, asked once for
                                    the page rather than once per face. Above
                                    everything, because faces are drawn on every
                                    screen there is. */}
                                    <PresenceProvider>
                                        {/* The call is held above every screen rather
                                    than by the conversation that started it, so
                                    walking off to look something up shrinks it
                                    into a bar instead of hanging up. */}
                                        <CallHolder
                                            viewerId={user.id}
                                            hasChat={apps.ids.includes("chat")}
                                        >
                                            <NotificationFavicon />
                                            <PresenceReporter />
                                            <VisitRecorder />
                                            {/* The bottom corner, laid out once. Each of these
                                    used to pin itself there, so an update landing
                                    while the phone was ringing drew one card on top
                                    of the other. They stack instead, urgent nearest
                                    the corner, and the column takes no clicks of its
                                    own - only the cards in it do. */}
                                            <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex flex-col items-end gap-2">
                                                {/* An update landing under an open tab, said out
                                        loud before a click is refused by a server that
                                        no longer knows this bundle. */}
                                                <NewBuildBanner served={buildStamp()} />
                                                {/* Out here rather than inside Chat: a call you only
                                        hear about while looking at the conversation it
                                        is in is a notice, not a call. Only for somebody
                                        who has Chat at all - the stream it listens on
                                        refuses anybody else. */}
                                                {apps.ids.includes("chat") ? (
                                                    <IncomingCalls viewerId={user.id} />
                                                ) : null}
                                                {/* Beside the ringing card and never at the same
                                        time as one: a call you are already in
                                        somewhere is not a call coming in. */}
                                                {apps.ids.includes("chat") ? (
                                                    <CallElsewhere />
                                                ) : null}
                                            </div>
                                            {/* Messages announce themselves in the corner and
                                    are then gone. Never through the bell: that is a
                                    record of things to come back to, and a chat
                                    message would bury the four that are. */}
                                            {apps.ids.includes("chat") ? <MessageToasts /> : null}
                                            <AppShell
                                                switcher={
                                                    <>
                                                        <AppNav
                                                            appIds={apps.ids}
                                                            guestAppIds={apps.guestIds}
                                                        />
                                                        <ScopeSwitcher
                                                            personalName={user.name}
                                                            organizations={organizations}
                                                            current={scope.org}
                                                        />
                                                    </>
                                                }
                                                navButton={<AppNavDrawer appIds={apps.ids} />}
                                                search={
                                                    <CommandPalette
                                                        isAdmin={user.isAdmin}
                                                        appIds={apps.ids}
                                                    />
                                                }
                                                sidebar={<AppSidebar appIds={apps.ids} />}
                                                account={
                                                    <>
                                                        {user.isAdmin ? <UpdateIndicator /> : null}
                                                        <NotificationBell />
                                                        <AccountMenu
                                                            id={user.id}
                                                            name={user.name}
                                                            email={user.email}
                                                            presence={presence.choice}
                                                            presenceUntil={presence.until}
                                                            presenceScheduled={presence.scheduled}
                                                            presenceNextChange={
                                                                presence.nextChangeAt
                                                            }
                                                            status={status.text}
                                                            statusUntil={status.until}
                                                        />
                                                    </>
                                                }
                                            >
                                                <DeniedNotice />
                                                <RouteSkeletonCapture>
                                                    {children}
                                                </RouteSkeletonCapture>
                                                {user.viewingAs ? (
                                                    <ViewAsBanner
                                                        mode={user.viewingAs.mode}
                                                        label={user.viewingAs.label}
                                                        actorName={user.viewingAs.actorName}
                                                    />
                                                ) : null}
                                            </AppShell>
                                        </CallHolder>
                                    </PresenceProvider>
                                </ToastProvider>
                            </NotificationsProvider>
                        </ChatUnreadProvider>
                    </SessionScopeProvider>
                </DisplayFormatProvider>
            </AppUrlProvider>
        </CapabilityProvider>
    );
}
