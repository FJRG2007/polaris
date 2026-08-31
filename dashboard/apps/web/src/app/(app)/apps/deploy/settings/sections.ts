/**
 * The settings sections, as data.
 *
 * Deliberately not inside the client component that renders them: the server
 * route reads this list to decide whether a slug is real, and a value exported
 * from a "use client" module arrives there as a client reference rather than the
 * array itself - which fails at request time, not at build time.
 */

import {
    Blocks,
    Boxes,
    Flag,
    Gauge,
    KeyRound,
    SlidersHorizontal,
    TriangleAlert,
    Users,
    Variable,
    Webhook,
    type LucideIcon
} from "lucide-react";

export interface SettingsSection {
    slug: string;
    label: string;
    icon: LucideIcon;
    /** One line under the page title, saying what this section decides. */
    hint: string;
}

export const SETTINGS_SECTIONS: SettingsSection[] = [
    {
        slug: "general",
        label: "General",
        icon: SlidersHorizontal,
        hint: "Name, description, and who can see it"
    },
    { slug: "usage", label: "Usage", icon: Gauge, hint: "What the project is consuming" },
    {
        slug: "environments",
        label: "Environments",
        icon: Boxes,
        hint: "Rename, set the default, remove"
    },
    {
        slug: "variables",
        label: "Shared variables",
        icon: Variable,
        hint: "Values every service in an environment gets"
    },
    {
        slug: "webhooks",
        label: "Webhooks",
        icon: Webhook,
        hint: "Where this project reports its deploys"
    },
    { slug: "flags", label: "Feature flags", icon: Flag, hint: "How this project behaves" },
    {
        slug: "members",
        label: "Access",
        icon: Users,
        hint: "Who can reach the project, and to do what"
    },
    { slug: "tokens", label: "Tokens", icon: KeyRound, hint: "API access scoped to this project" },
    {
        slug: "integrations",
        label: "Integrations",
        icon: Blocks,
        hint: "What this project is connected to"
    },
    { slug: "danger", label: "Danger", icon: TriangleAlert, hint: "Irreversible things" }
];
