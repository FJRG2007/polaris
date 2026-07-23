/**
 * The Polaris app registry - what appears in the top-left switcher. Deliberately
 * small so the dashboard stays legible as it grows: Drive, the umbrella Apps
 * pillar (marketplace + everything Polaris installs and runs), and Management.
 * Everything installable lives under Apps rather than sprawling the switcher.
 */

import { Activity, HardDrive, LayoutGrid, MessagesSquare, SlidersHorizontal, type LucideIcon } from "lucide-react";

export interface AppEntry {
    id: string;
    label: string;
    description: string;
    icon: LucideIcon;
    href: string;
    locked?: boolean;
    /** Only visible to administrators (filtered out of the switcher otherwise). */
    adminOnly?: boolean;
    /** Extra path prefixes this app owns beyond `href`, so routes that live
     *  outside the app's own subtree (e.g. legacy top-level admin pages) still
     *  resolve to it for the switcher highlight and the sidebar. */
    match?: string[];
}

export const POLARIS_APPS: AppEntry[] = [
    { id: "drive", label: "Drive", description: "Files across every NAS", icon: HardDrive, href: "/drive" },
    {
        id: "apps",
        label: "Apps",
        description: "Install & run apps: deploys, servers, assistants",
        icon: LayoutGrid,
        href: "/apps/marketplace",
        // Owns the whole /apps subtree: the marketplace, installed-app dashboards,
        // and the built-in Deploy / Servers / Containers / Backups rails.
        match: ["/apps"]
    },
    {
        id: "inbox",
        label: "Inbox",
        description: "Customer conversations across every channel",
        icon: MessagesSquare,
        href: "/inbox"
    },
    {
        id: "watch",
        label: "Watch",
        description: "Alarms on app health, spikes and outages",
        icon: Activity,
        href: "/watch"
    },
    {
        id: "admin",
        label: "Management",
        description: "Users, access, domains & updates",
        icon: SlidersHorizontal,
        href: "/admin",
        adminOnly: true,
        // Admin pages that historically live at the top level, so they still
        // resolve to the Management app in the switcher and sidebar.
        match: ["/integrations", "/settings"]
    }
];

/** Whether a path belongs to an app: its own subtree, or one of its extra
 *  `match` prefixes (exact segment or a nested path under it). */
function appOwnsPath(app: AppEntry, pathname: string): boolean {
    const owns = (base: string) => pathname === base || pathname.startsWith(`${base}/`);
    return owns(app.href) || (app.match?.some(owns) ?? false);
}

/** The app the current path belongs to, defaulting to the first app (Drive). */
export function resolveActiveApp(pathname: string): AppEntry {
    // POLARIS_APPS is a non-empty literal, so [0] is always present.
    return POLARIS_APPS.find((app) => appOwnsPath(app, pathname)) ?? POLARIS_APPS[0]!;
}
