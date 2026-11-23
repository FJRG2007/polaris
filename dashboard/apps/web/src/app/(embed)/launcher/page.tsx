import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ToastProvider, KeyNamesProvider, ShortcutsProvider } from "@polaris/ui";
import { accessFor, guardedUser } from "@/lib/session";
import { getLocale, getTranslations } from "@/lib/i18n/request";
import { Messages } from "@/components/i18n/messages";
import { DisplayFormatProvider } from "@/components/display-format";
import { SessionScopeProvider } from "@/components/session-scope";
import { resolveDisplayPreferencesFor } from "@/lib/display-prefs-service";
import { getShortcutOverrides } from "@/lib/shortcuts-service";
import { NO_SHORTCUT_OVERRIDES } from "@polaris/core";
import { heldSectionPermissions, installedSectionApps, reachableAppNav } from "@/lib/app-access";
import { LauncherSearch } from "./launcher-search";

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations("components");
    return { title: t("search.label") };
}

/**
 * Polaris Desktop's Alt+Space window: the dashboard's own search, alone on a
 * clear page, so the window shows the very palette the header opens - the same
 * recents, results, logos and commands - over any app.
 *
 * Outside the `(app)` group so there is no frame and no redirect. Without a
 * session it is a 404, which is also what a host from before this page
 * answers: the desktop draws its own panel for both.
 */
export default async function LauncherPage() {
    const user = await guardedUser();
    if (!user) notFound();
    const access = accessFor(user);
    const locale = await getLocale();
    const tk = await getTranslations("shortcuts");
    const [apps, held, installed, display, shortcuts] = await Promise.all([
        reachableAppNav(access),
        heldSectionPermissions(access),
        installedSectionApps(access),
        resolveDisplayPreferencesFor(user.id, locale),
        getShortcutOverrides(user.id).catch(() => NO_SHORTCUT_OVERRIDES)
    ]);
    const keyNames = {
        delete: tk("keys.delete"),
        backspace: tk("keys.backspace"),
        enter: tk("keys.enter"),
        escape: tk("keys.escape"),
        space: tk("keys.space")
    };
    return (
        <Messages namespaces={["nav", "chat", "shortcuts", "tours"]}>
            {/* The window is transparent: only the palette shows. */}
            <style>{"html,body{background:transparent!important}"}</style>
            <DisplayFormatProvider preferences={display}>
                <SessionScopeProvider userId={user.id}>
                    <ToastProvider>
                        <ShortcutsProvider overrides={shortcuts}>
                            <KeyNamesProvider names={keyNames}>
                                <LauncherSearch
                                    isAdmin={user.isAdmin}
                                    appIds={apps.ids}
                                    held={held}
                                    installed={installed}
                                />
                            </KeyNamesProvider>
                        </ShortcutsProvider>
                    </ToastProvider>
                </SessionScopeProvider>
            </DisplayFormatProvider>
        </Messages>
    );
}
