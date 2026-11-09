/**
 * Ready-made policies, in the sense of a cloud provider's managed policies: the
 * shapes of access people ask for again and again ("what somebody has in a
 * Google Drive", "can look but not touch"), written once here so an
 * administrator attaches one instead of writing JSON.
 *
 * They are kept by Polaris rather than by the administrator: each one is stored
 * as a read-only system policy and rewritten when this list changes, so an
 * update that adds a permission an app needs reaches every account the template
 * is attached to. Anything else is a copy - "Start from" fills the editor of a
 * new policy with a template's statements, and from then on it is theirs.
 *
 * A policy adds to what somebody's role gives them and an explicit deny wins
 * (see `authz.ts`), which is what makes a template like `drive-user` useful on
 * a member: it keeps the files and takes away adding a storage connection.
 * Pure data, so the client can read it to fill the editor.
 */

import type { PolicyStatement } from "./authz.js";
import { CHAT_CAPABILITIES, type Permission } from "./permissions.js";

/** The prefix a ready-made policy's stored name carries, and nothing else may. */
export const POLICY_TEMPLATE_PREFIX = "polaris:";

export const POLICY_TEMPLATE_KEYS = [
    "drive-user",
    "drive-viewer",
    "no-new-connections",
    "workspace-user",
    "read-only",
    "no-administration",
    "deploy-viewer",
    "developer",
    "game-moderator",
    "home-resident"
] as const;

export type PolicyTemplateKey = (typeof POLICY_TEMPLATE_KEYS)[number];

export interface PolicyTemplate {
    readonly key: PolicyTemplateKey;
    readonly statements: readonly PolicyStatement[];
}

const allow = (...actions: Permission[]): PolicyStatement => ({ effect: "allow", actions, resources: ["*"] });
const deny = (...actions: Permission[]): PolicyStatement => ({ effect: "deny", actions, resources: ["*"] });

/** Everything that changes something, for the templates that take it all away. */
const WRITES: readonly Permission[] = [
    "drive.write",
    "drive.delete",
    "connections.manage",
    "shares.create",
    "shares.manage",
    "requests.create",
    "requests.manage",
    "snippets.write",
    "mailserver.manage",
    "automations.secrets",
    "status.manage",
    "deploy.manage",
    "games.moderate",
    "games.console",
    "games.manage",
    "agents.manage",
    "polar.spend",
    "home.control",
    "home.manage",
    "tools.manage",
    "tasks.manage",
    "inbox.manage",
    "family.manage",
    "users.manage",
    "settings.manage",
    "system.manage"
];

export const POLICY_TEMPLATES: readonly PolicyTemplate[] = [
    {
        // What somebody has in a Google Drive: their files, sharing them and
        // asking for files - and no adding a NAS or a cloud account to Polaris.
        key: "drive-user",
        statements: [
            allow("drive.read", "drive.write", "drive.delete", "shares.create", "requests.create", "snippets.read", "snippets.write"),
            deny("connections.manage", "shares.manage", "requests.manage")
        ]
    },
    {
        key: "drive-viewer",
        statements: [
            allow("drive.read", "snippets.read"),
            deny(
                "drive.write",
                "drive.delete",
                "connections.manage",
                "shares.create",
                "shares.manage",
                "requests.create",
                "requests.manage",
                "snippets.write"
            )
        ]
    },
    {
        // Whatever else the role allows, nothing new for Polaris to connect to.
        key: "no-new-connections",
        statements: [deny("connections.manage", "home.manage", "mailserver.manage")]
    },
    {
        // The everyday office suite: mail, calendar, documents, chat, tasks, files.
        key: "workspace-user",
        statements: [
            allow(
                "mail.use",
                "calendar.use",
                "office.use",
                "notes.use",
                "chat.use",
                ...CHAT_CAPABILITIES,
                "tasks.read",
                "tasks.manage",
                "drive.read",
                "drive.write",
                "drive.delete",
                "shares.create",
                "requests.create"
            ),
            deny("connections.manage")
        ]
    },
    { key: "read-only", statements: [deny(...WRITES)] },
    { key: "no-administration", statements: [deny("users.manage", "settings.manage", "system.manage")] },
    { key: "deploy-viewer", statements: [allow("deploy.read"), deny("deploy.manage")] },
    {
        key: "developer",
        statements: [allow("deploy.read", "deploy.manage", "agents.read", "agents.manage", "automations.use")]
    },
    {
        key: "game-moderator",
        statements: [allow("games.read", "games.moderate", "games.console"), deny("games.manage")]
    },
    { key: "home-resident", statements: [allow("home.read", "home.control"), deny("home.manage")] }
];

/** The name a template is stored under. */
export function policyTemplateName(key: PolicyTemplateKey): string {
    return `${POLICY_TEMPLATE_PREFIX}${key}`;
}

/** The template a stored policy name stands for, or null for an administrator's own. */
export function policyTemplateOf(name: string): PolicyTemplate | null {
    if (!name.startsWith(POLICY_TEMPLATE_PREFIX)) return null;
    const key = name.slice(POLICY_TEMPLATE_PREFIX.length);
    return POLICY_TEMPLATES.find((template) => template.key === key) ?? null;
}

/** A template's statements as the document text a policy stores. */
export function policyTemplateDocument(template: PolicyTemplate): string {
    return JSON.stringify({ statements: template.statements });
}
