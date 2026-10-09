/**
 * The dashboard's frame around a scene: the same client components, in the same
 * order, that `components/app-chrome.tsx` puts around every screen.
 *
 * The app chrome itself is a server component - it reads the session and the
 * settings before it draws - so it cannot run in this page. What it renders is
 * client components fed with values, and those are what this file composes,
 * with the values a signed-in administrator of a small team would have. When the
 * chrome gains a provider a screen depends on, add it here in the same place.
 */

import Link from "next/link";
import type { ReactNode } from "react";
import { AppNav } from "@/components/app-nav";
import { AppSidebar } from "@/components/app-sidebar";
import { AppUrlProvider } from "@/components/app-url";
import { CallHolder } from "@/components/call-holder";
import { AccountMenu } from "@/components/account-menu";
import { AppNavDrawer } from "@/components/app-nav-drawer";
import { ScopeSwitcher } from "@/components/scope-switcher";
import { IncomingCalls } from "@/components/incoming-calls";
import { CommandPalette } from "@/components/command-palette";
import { ProvideAppHostUi } from "@/components/app-host/client";
import { ShelfScopeProvider } from "@/components/shelf-scope";
import { ChatUnreadProvider } from "@/components/chat-unread";
import { MailUnreadProvider } from "@/components/mail-unread";
import { PresenceProvider } from "@/components/presence-store";
import { AppUnreadDriftProvider } from "@/components/app-unread";
import { NotificationBell } from "@/components/notification-bell";
import { SessionScopeProvider } from "@/components/session-scope";
import { FavoriteAppsProvider } from "@/components/favorite-apps";
import { DisplayFormatProvider } from "@/components/display-format";
import { ProfileStyleProvider } from "@/components/profile-style-store";
import { DISPLAY_DEFAULTS, NO_SHORTCUT_OVERRIDES } from "@polaris/core";
import { AdminWaitingProvider, NO_ADMIN_WAITING } from "@/components/admin-waiting";
import { NotificationsProvider } from "@/components/notifications/notifications-provider";
import {
    AppShell,
    CapabilityProvider,
    KeyNamesProvider,
    PolarisMark,
    ShortcutsProvider,
    ToastProvider
} from "@polaris/ui";
import { VIEWER } from "../fixtures/people";

/** Every app a full install shows its administrator. */
export const APP_IDS = [
    "home",
    "chat",
    "tasks",
    "calendar",
    "mail",
    "drive",
    "office",
    "notes",
    "vault",
    "apps",
    "games",
    "agents",
    "runners",
    "watch",
    "crm",
    "inbox",
    "tools",
    "admin",
    "account"
];

const CAPABILITIES = {
    edition: "full",
    hostd: { present: true },
    hostFilesystem: true,
    nativeMounts: true,
    docker: true,
    deploy: true,
    privateNetworks: true,
    privateNames: true,
    kubernetes: false,
    systemd: true,
    autoUpdate: true
} as const;

export function Chrome({ children, unread }: { children: ReactNode; unread?: { chat?: number; mail?: number } }) {
    return (
        <CapabilityProvider capabilities={CAPABILITIES as never}>
            <AppUrlProvider baseUrl="https://polaris.example.com">
                <ShelfScopeProvider shelf="personal">
                    <DisplayFormatProvider preferences={DISPLAY_DEFAULTS}>
                        <SessionScopeProvider userId={VIEWER.id}>
                            <ChatUnreadProvider
                                initial={{ messages: unread?.chat ?? 0, conversations: unread?.chat ? 2 : 0 }}
                                enabled
                            >
                                <MailUnreadProvider initial={{ messages: unread?.mail ?? 0, mailboxes: 1 }} enabled>
                                    <AdminWaitingProvider initial={NO_ADMIN_WAITING} enabled>
                                        <AppUnreadDriftProvider>
                                            <NotificationsProvider initial={[]}>
                                                <ToastProvider>
                                                    <FavoriteAppsProvider initial={["chat", "tasks", "drive"]}>
                                                        <ShortcutsProvider overrides={NO_SHORTCUT_OVERRIDES}>
                                                            <KeyNamesProvider names={{}}>
                                                                <PresenceProvider>
                                                                    <ProfileStyleProvider>
                                                                        <CallHolder viewerId={VIEWER.id} hasChat>
                                                                            <Frame>{children}</Frame>
                                                                        </CallHolder>
                                                                    </ProfileStyleProvider>
                                                                </PresenceProvider>
                                                            </KeyNamesProvider>
                                                        </ShortcutsProvider>
                                                    </FavoriteAppsProvider>
                                                </ToastProvider>
                                            </NotificationsProvider>
                                        </AppUnreadDriftProvider>
                                    </AdminWaitingProvider>
                                </MailUnreadProvider>
                            </ChatUnreadProvider>
                        </SessionScopeProvider>
                    </DisplayFormatProvider>
                </ShelfScopeProvider>
            </AppUrlProvider>
        </CapabilityProvider>
    );
}

function Frame({ children }: { children: ReactNode }) {
    return (
        <>
            {/* The bottom corner the chrome lays out for cards that outlive a screen. */}
            <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex flex-col items-end gap-2">
                <IncomingCalls viewerId={VIEWER.id} />
            </div>
            <AppShell
                mark={
                    <Link href="/home" className="shrink-0 rounded-sm">
                        <span className="flex items-center gap-1.5">
                            <PolarisMark nameClassName="hidden sm:inline" />
                        </span>
                    </Link>
                }
                switcher={
                    <>
                        <AppNav appIds={APP_IDS} marketplace />
                        <ScopeSwitcher personalName={VIEWER.name} organizations={[]} current={null} />
                    </>
                }
                navButton={<AppNavDrawer appIds={APP_IDS} isAdmin />}
                search={<CommandPalette isAdmin appIds={APP_IDS} />}
                sidebar={<AppSidebar appIds={APP_IDS} held={[]} installed={[]} isAdmin />}
                account={
                    <>
                        <NotificationBell />
                        <AccountMenu
                            id={VIEWER.id}
                            name={VIEWER.name}
                            email={VIEWER.email}
                            presence="auto"
                            presenceUntil={null}
                            presenceScheduled={false}
                            presenceNextChange={null}
                            status=""
                            statusUntil={null}
                        />
                    </>
                }
            >
                {/* As the app layout does: an installable app's screens find the
                    dashboard's pieces through it. */}
                <ProvideAppHostUi />
                {children}
            </AppShell>
        </>
    );
}
