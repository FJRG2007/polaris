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
import type { NamespaceKey } from "@/lib/i18n/types";

export interface SettingsSection {
    slug: string;
    /** Catalog key of the section's name, in the deploySettings namespace. */
    label: NamespaceKey<"deploySettings">;
    icon: LucideIcon;
    /** One line under the page title, saying what this section decides - a
     *  catalog key in the deploySettings namespace. */
    hint: NamespaceKey<"deploySettings">;
}

export const SETTINGS_SECTIONS: SettingsSection[] = [
    {
        slug: "general",
        label: "sections.general.label",
        icon: SlidersHorizontal,
        hint: "sections.general.hint"
    },
    { slug: "usage", label: "sections.usage.label", icon: Gauge, hint: "sections.usage.hint" },
    {
        slug: "environments",
        label: "sections.environments.label",
        icon: Boxes,
        hint: "sections.environments.hint"
    },
    {
        slug: "variables",
        label: "sections.variables.label",
        icon: Variable,
        hint: "sections.variables.hint"
    },
    {
        slug: "webhooks",
        label: "sections.webhooks.label",
        icon: Webhook,
        hint: "sections.webhooks.hint"
    },
    { slug: "flags", label: "sections.flags.label", icon: Flag, hint: "sections.flags.hint" },
    {
        slug: "members",
        label: "sections.members.label",
        icon: Users,
        hint: "sections.members.hint"
    },
    { slug: "tokens", label: "sections.tokens.label", icon: KeyRound, hint: "sections.tokens.hint" },
    {
        slug: "integrations",
        label: "sections.integrations.label",
        icon: Blocks,
        hint: "sections.integrations.hint"
    },
    { slug: "danger", label: "sections.danger.label", icon: TriangleAlert, hint: "sections.danger.hint" }
];
