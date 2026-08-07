/**
 * Human labels for the permission scopes an API key can carry, and the grouping
 * the key dialog reads them in: one section per resource, broadest permission
 * last, so what a key can reach is scannable rather than a flat checklist.
 *
 * Client-safe on purpose: the key dialog renders these, so this module must not
 * reach for anything that drags the database layer into the browser bundle.
 * Resolving which scopes a user may actually pick lives server-side, in
 * @polaris/auth.
 */

import type { Permission } from "@polaris/core";

export const SCOPE_LABELS: Readonly<Record<Permission, string>> = {
    "drive.read": "Read files",
    "drive.write": "Write files",
    "drive.delete": "Delete files",
    "connections.manage": "Manage storage connections",
    "shares.create": "Create share links",
    "shares.manage": "Manage all share links",
    "requests.create": "Create drop points",
    "requests.manage": "Manage all drop points",
    "deploy.read": "Read deployments",
    "deploy.manage": "Manage deployments",
    "games.read": "Read game servers",
    "games.moderate": "Moderate players",
    "games.manage": "Manage game servers",
    "agents.read": "Read agent runs",
    "agents.manage": "Manage agent repositories",
    "tasks.read": "Read tasks",
    "tasks.manage": "Manage tasks",
    "inbox.read": "Read conversations",
    "inbox.manage": "Manage conversations",
    "users.manage": "Manage users",
    "settings.manage": "Manage settings",
    "system.manage": "Manage the system"
};

/** What each scope actually lets the key do, in the terms a caller would use. */
export const SCOPE_HINTS: Readonly<Record<Permission, string>> = {
    "drive.read": "List folders and download files.",
    "drive.write": "Upload, rename, and move files.",
    "drive.delete": "Send files to the trash and empty it.",
    "connections.manage": "Add, edit, and remove storage connections.",
    "shares.create": "Share files the key can already read.",
    "shares.manage": "Edit and revoke share links from anyone.",
    "requests.create": "Open drop points for others to upload to.",
    "requests.manage": "Edit and close drop points from anyone.",
    "deploy.read": "Inspect apps, deployments, and logs.",
    "deploy.manage": "Deploy, restart, and remove apps.",
    "games.read": "See game servers, their addresses, and who is playing.",
    "games.moderate": "Op, kick, ban, and whitelist players.",
    "games.manage": "Create servers, run console commands, and change settings.",
    "agents.read": "List enabled repositories and read run history.",
    "agents.manage": "Enable repositories, change how they run, and start runs.",
    "tasks.read": "Read spaces, lists, and tasks.",
    "tasks.manage": "Create and change tasks, lists, and spaces.",
    "inbox.read": "Read conversations, contacts, and channel activity.",
    "inbox.manage": "Reply, assign, and connect or remove channels.",
    "users.manage": "Invite, edit, and remove users.",
    "settings.manage": "Change instance settings.",
    "system.manage": "Run updates and system operations."
};

export interface ScopeGroup {
    readonly title: string;
    readonly scopes: readonly Permission[];
}

/** Resource sections, in the order the dialog shows them. */
export const SCOPE_GROUPS: readonly ScopeGroup[] = [
    { title: "Files", scopes: ["drive.read", "drive.write", "drive.delete"] },
    { title: "Storage", scopes: ["connections.manage"] },
    { title: "Sharing", scopes: ["shares.create", "shares.manage", "requests.create", "requests.manage"] },
    { title: "Deployments", scopes: ["deploy.read", "deploy.manage"] },
    { title: "Game servers", scopes: ["games.read", "games.moderate", "games.manage"] },
    { title: "Tasks", scopes: ["tasks.read", "tasks.manage"] },
    { title: "Inbox", scopes: ["inbox.read", "inbox.manage"] },
    { title: "Administration", scopes: ["users.manage", "settings.manage", "system.manage"] }
];
