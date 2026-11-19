"use client";

/**
 * The tab bar along the bottom of every screen on a phone, the way Discord,
 * Telegram and Signal move between their few places: Home, the apps this
 * account opens most, the notification centre and "You" - the account screen
 * (see AccountSheet). Below `sm` only; from there up the same places are the
 * app menu, the bell and the face in the header, and nothing changes.
 *
 * The apps are the first few of the app menu's own order (`launcherOrder`):
 * what was arranged, then the favorites, then by use. Drawn from the apps this
 * account can reach - the same list the menu is - so it never offers one that
 * would turn them away.
 *
 * A screen with tabs of its own (Chat's sections) owns the bottom of the screen
 * instead: it calls `useOwnBottomTabs()`, or renders `<OwnBottomTabs />` from a
 * server layout, and this bar steps aside for as long as it is mounted. Its own
 * bar then clears the home indicator itself (BottomTabs does), and the shell
 * stops padding for it either way (`data-shell-tabs` in AppShell).
 */

import * as nav from "@/lib/apps";
import { Bell, House } from "lucide-react";
import { Avatar } from "@/components/avatar";
import { readMenuUsage } from "@/lib/app-usage";
import { useLastPlaces } from "@/lib/last-place";
import { useAppUnread } from "@/components/app-unread";
import { BottomTabs, type BottomTab } from "@polaris/ui";
import { usePathname, useRouter } from "next/navigation";
import { useNavLabel } from "@/components/i18n/use-nav-label";
import { PolarisAppIcon } from "@/components/polaris-app-icon";
import { launcherOrder, type AppUsage } from "@/lib/app-launcher";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { useFavoriteApps } from "@/components/favorite-apps-context";
import { useNotificationFeed } from "@/components/notifications/notifications-provider";
import { setAccountSheetOpen, useAccountSheetOpen } from "@/components/account-sheet-state";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

/** How many apps get a tab of their own, between Home and the bell: five tabs
 *  in all, as many as a phone's width holds with a readable name under each. */
export const PHONE_TAB_APPS = 2;

/** Where the notification centre is; the bell goes to the same page. */
const NOTIFICATIONS_PATH = "/account/notifications";

/** Apps that already have a tab of their own: Home is the Overview, and "You"
 *  is the account. */
const OWN_TAB = new Set([nav.OVERVIEW_APP_ID, "account"]);

const PhoneTabsContext = createContext<{ owned: boolean; own: () => () => void }>({
    owned: false,
    own: () => () => undefined
});

/** Holds whether a screen has taken the bottom of the phone for its own tabs. */
export function PhoneTabsProvider({ children }: { children: ReactNode }) {
    const [owners, setOwners] = useState(0);
    const own = useCallback(() => {
        setOwners((count) => count + 1);
        return () => setOwners((count) => count - 1);
    }, []);
    const value = useMemo(() => ({ owned: owners > 0, own }), [owners, own]);
    return <PhoneTabsContext.Provider value={value}>{children}</PhoneTabsContext.Provider>;
}

/** For a screen that draws its own BottomTabs: the shell's bar steps aside
 *  while the screen is mounted. */
export function useOwnBottomTabs(): void {
    const { own } = useContext(PhoneTabsContext);
    useEffect(() => own(), [own]);
}

/** `useOwnBottomTabs` as an element, for a server layout. */
export function OwnBottomTabs(): null {
    useOwnBottomTabs();
    return null;
}

/** The tabs the bar draws, in order. Pure, so the choice can be asserted. */
export function phoneTabApps({
    appIds,
    favorites,
    arranged,
    usage,
    now
}: {
    appIds: readonly string[];
    favorites: readonly string[];
    arranged: readonly string[];
    usage: AppUsage;
    now: number;
}): string[] {
    const available = appIds.filter((id) => !OWN_TAB.has(id) && nav.POLARIS_APPS.some((app) => app.id === id));
    return launcherOrder({ available, arranged, favorites, usage, now }).slice(0, PHONE_TAB_APPS);
}

export function PhoneTabBar({
    person,
    appIds,
    guestAppIds = [],
    otherwiseAppIds = []
}: {
    person: { id: string; name: string };
    /** The apps this account can reach, as the app menu is handed them. */
    appIds: string[];
    guestAppIds?: string[];
    otherwiseAppIds?: string[];
}) {
    const { owned } = useContext(PhoneTabsContext);
    const t = useTranslations("nav");
    const label = useNavLabel();
    const router = useRouter();
    const pathname = usePathname();
    const accountOpen = useAccountSheetOpen();
    const waiting = useAppUnread();
    const { unread } = useNotificationFeed();
    const { favorites, order } = useFavoriteApps();
    const places = useLastPlaces(nav.POLARIS_APPS);
    const [usage, setUsage] = useState<{ usage: AppUsage; at: number }>({ usage: {}, at: 0 });

    // Re-read on every navigation, as the app menu does: the visit just made
    // is part of what "most used" means.
    useEffect(() => {
        setUsage(readMenuUsage());
    }, [pathname]);

    // Marked rather than left out, so the shell still knows the bottom of the
    // screen is a bar's and does not pad it a second time.
    if (owned) return <span data-shell-tabs="owned" hidden />;

    const current = nav.resolveActiveApp(pathname).id;
    const go = (href: string) => () => {
        setAccountSheetOpen(false);
        router.push(href);
    };
    const apps = phoneTabApps({ appIds, favorites, arranged: order, usage: usage.usage, now: usage.at }).flatMap(
        (id): BottomTab[] => {
            const app = nav.POLARIS_APPS.find((entry) => entry.id === id);
            if (!app) return [];
            const guest = nav.guestFace(app, guestAppIds.includes(id), otherwiseAppIds.includes(id));
            const name = label(guest ? guest.label : app.label);
            return [
                {
                    id,
                    label: name,
                    icon: <PolarisAppIcon appId={id} label={name} size={20} />,
                    active: !accountOpen && current === id,
                    badge: waiting[id] ?? 0,
                    onSelect: go(guest ? guest.href : (places[id] ?? app.href))
                }
            ];
        }
    );
    const onNotifications = pathname.startsWith(NOTIFICATIONS_PATH);
    const tabs: BottomTab[] = [
        {
            id: "home",
            label: t("phoneTabs.home"),
            icon: <House />,
            active: !accountOpen && current === nav.OVERVIEW_APP_ID,
            onSelect: go("/home")
        },
        ...apps,
        {
            id: "notifications",
            label: t("phoneTabs.notifications"),
            icon: <Bell />,
            active: !accountOpen && onNotifications,
            badge: unread,
            onSelect: go(NOTIFICATIONS_PATH)
        },
        {
            id: "you",
            label: t("phoneTabs.you"),
            icon: <Avatar person={person} size={20} status={false} className="shrink-0" />,
            active: accountOpen || (current === "account" && !onNotifications),
            onSelect: () => setAccountSheetOpen(true)
        }
    ];

    return (
        <div data-shell-tabs="global" className="contents sm:hidden">
            <BottomTabs tabs={tabs} label={t("phoneTabs.label")} />
        </div>
    );
}
