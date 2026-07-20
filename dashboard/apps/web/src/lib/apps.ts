/**
 * The Polaris app registry - what appears in the top-left switcher. Drive is
 * live; the rest are declared but locked so the platform's direction is visible
 * from day one. Future phases unlock them (Docker/Kubernetes/servers/home) as
 * their apps land, most gated behind the full edition's host access.
 */

import {
    Boxes,
    Container,
    DatabaseBackup,
    HardDrive,
    Home,
    Server,
    SlidersHorizontal,
    type LucideIcon
} from "lucide-react";

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
    { id: "containers", label: "Containers", description: "Docker & Compose", icon: Container, href: "/apps/containers" },
    { id: "backups", label: "Backups", description: "Databases, Polaris & NAS", icon: DatabaseBackup, href: "/apps/backups" },
    { id: "kubernetes", label: "Kubernetes", description: "Clusters & workloads", icon: Boxes, href: "/apps/kubernetes", locked: true },
    { id: "servers", label: "Servers", description: "SSH hosts for Containers & Drive", icon: Server, href: "/apps/servers" },
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
    },
    { id: "home", label: "Home", description: "Home Assistant", icon: Home, href: "/apps/home", locked: true }
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
