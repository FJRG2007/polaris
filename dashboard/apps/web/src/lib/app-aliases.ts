/**
 * Names that stand for one of Polaris's own apps under another id: a commit
 * scope, a notification group, a shortcut set, an automation picker group.
 *
 * The app registry keys apps by ids that are not always what a screen calls
 * them (`home` is Places, `games` is Game servers, `apps` is where Deploy
 * lives), so every screen that drew an app's logo from a name of its own kept
 * a little table of these, and each table knew a different subset. This is the
 * one table; a name not in it is taken to be the app id itself.
 *
 * Pure and free of UI imports, so a server page can ask it too. Whether the
 * resulting app has a logo is the caller's question (`hasAppLogo`).
 */

/** Name -> the registry id of the app it stands for. */
export const APP_ALIASES: Readonly<Record<string, string>> = {
    // Agent sessions run in Polar Code, and their notices open there.
    agents: "polar",
    code: "polar",
    places: "home",
    "game-servers": "games",
    servers: "cloud-servers",
    "network-filter": "dns-blocker",
    // Deploy is the primary surface of the Apps app, as the sidebar draws it.
    deploy: "apps",
    // The network's own alerts belong to the Router app.
    network: "router",
    // Missed calls, invitations and reminders are Chat's.
    people: "chat",
    // Alerts arrive at an automation's "When an alert arrives" trigger.
    alerts: "automations",
    // The file viewer is part of Drive.
    viewer: "drive",
    updates: "admin",
    users: "admin"
};

/** The registry id of the app a name stands for: its alias, or the name itself. */
export function aliasedAppId(name: string): string {
    return Object.hasOwn(APP_ALIASES, name) ? APP_ALIASES[name]! : name;
}
