/**
 * Which apps an account can actually open, and where it lands.
 *
 * The registry says what each app costs (AppEntry.permission); this resolves that
 * against one person, once per render, and everything that lists apps - the
 * switcher, the command palette, the redirect after signing in - reads the same
 * answer. An account that holds nothing is not a broken state: a role can exist
 * purely so somebody can be identified at a share link or a drop point, and for
 * them the only place that means anything is their own account.
 *
 * Takes the capability check as an argument rather than importing it, so this
 * stays usable from a role preview (where the answer is the role's, not the
 * administrator's) without knowing anything about sessions.
 */

import type { Permission } from "@polaris/core";
import { POLARIS_APPS, type AppEntry } from "@/lib/apps";

/** Where somebody with no app at all belongs. */
export const ACCOUNT_HOME = "/account";

/** The id of the landing app, which is only offered alongside something to look
 *  at. */
export const OVERVIEW_APP = "overview";

export interface AppAccessInput {
    isAdmin: boolean;
    can: (permission: Permission) => Promise<boolean>;
    /**
     * Whether a marketplace app is installed, for the entries that only exist
     * once somebody adds them (AppEntry.requiresApp).
     *
     * Optional because this is also asked on behalf of a role rather than a
     * person - the role editor previews what a role would reach - and there the
     * question is what the grants allow, not what this Polaris happens to have
     * installed today. Absent, every entry is treated as present.
     */
    isInstalled?: (catalogId: string) => Promise<boolean>;
}

/** The apps this person may open, in registry order. Hidden apps (the account
 *  section) are not included: they are reached from the account menu.
 *
 *  An admin-only app that carries a guest subject (Management carries Inbox) is
 *  returned under that subject's name and landing page for somebody who holds the
 *  permission without being an administrator, so the switcher offers them the one
 *  door they have rather than the app's own.
 *
 *  Overview is the exception to "an app with no permission is open to anyone": it
 *  is a view onto the other apps, so for an account that reaches none of them it
 *  is an empty grid offered as somewhere to be. Those accounts belong on their
 *  own account page, which is what dropping it here arranges. */
export async function reachableApps({ isAdmin, can, isInstalled }: AppAccessInput): Promise<AppEntry[]> {
    const decided = await Promise.all(
        POLARIS_APPS.map(async (app) => {
            if (app.hidden) return null;
            // Asked before the permission, because an app nobody installed is not
            // a thing anybody is being refused: there is nothing there yet.
            if (app.requiresApp && isInstalled && !(await isInstalled(app.requiresApp))) return null;
            if (app.adminOnly && !isAdmin) {
                if (!app.guest || !(await can(app.guest.permission))) return null;
                return { ...app, label: app.guest.label, description: app.guest.description, href: app.guest.href };
            }
            if (app.permission && !(await can(app.permission))) return null;
            return app;
        })
    );
    const reachable = decided.filter((app): app is AppEntry => app !== null);
    return reachable.some((app) => app.id !== OVERVIEW_APP) ? reachable : [];
}

/**
 * What the switcher needs: the ids this account may open, and which of those it
 * is only reaching through a guest subject.
 *
 * The second list exists because the switcher is a client component that holds
 * the registry itself - the icons are components and do not cross the boundary -
 * so it is told which entries to draw under their guest name rather than being
 * handed the resolved entry.
 */
export async function reachableAppNav(input: AppAccessInput): Promise<{ ids: string[]; guestIds: string[] }> {
    const apps = await reachableApps(input);
    return {
        ids: apps.map((app) => app.id),
        guestIds: apps.filter((app) => app.guest && app.href === app.guest.href).map((app) => app.id)
    };
}

/** The ids of the apps this person may open, for the client components that only
 *  need to filter a list they already hold. */
export async function reachableAppIds(input: AppAccessInput): Promise<string[]> {
    return (await reachableApps(input)).map((app) => app.id);
}

/**
 * Where this person goes when they ask for "home" - after signing in, from the
 * dashboard root, and when a screen turns them away. The first app they can open,
 * or their own account when they can open none.
 */
export async function homePathFor(input: AppAccessInput): Promise<string> {
    const apps = await reachableApps(input);
    return apps[0]?.href ?? ACCOUNT_HOME;
}
