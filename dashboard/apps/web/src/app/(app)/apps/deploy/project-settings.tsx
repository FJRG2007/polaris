"use client";

/**
 * Project settings: the sections a project has beyond its services.
 *
 * The sub-rail is a list of real routes rather than tab state, so every section
 * can be linked to, reloaded, and sent to somebody. The section components live
 * in ./settings; this file is the frame and the routing table.
 */

import Link from "next/link";
import { cn, PageHeader } from "@polaris/ui";
import { SETTINGS_SECTIONS } from "./settings/sections";
import { UsageSection } from "./settings/usage-section";
import { TokensSection } from "./settings/tokens-section";
import { DangerSection } from "./settings/danger-section";
import { GeneralSection } from "./settings/general-section";
import { MembersSection } from "./settings/members-section";
import { WebhooksSection } from "./settings/webhooks-section";
import { EnvironmentsSection } from "./settings/environments-section";
import { IntegrationsSection } from "./settings/integrations-section";
import { FeatureFlagsSection } from "./settings/feature-flags-section";
import type { ProjectSettingsView } from "@/lib/deploy-project-service";
import { SharedVariablesSection } from "./settings/shared-variables-section";

export function ProjectSettings({
    settings,
    section,
    canManage,
    isOwner
}: {
    settings: ProjectSettingsView;
    section: string;
    /** Project admin. A viewer or developer sees the screens read-only. */
    canManage: boolean;
    /** Only the owner may delete or hand over the project itself. */
    isOwner: boolean;
}) {
    const base = `/apps/deploy/${settings.id}/settings`;
    const current = SETTINGS_SECTIONS.find((entry) => entry.slug === section) ?? SETTINGS_SECTIONS[0]!;

    return (
        <div className="flex w-full flex-col gap-4">
            <PageHeader title="Project settings" description={current.hint} />

            <div className="flex flex-col gap-5 md:flex-row md:gap-6">
                <nav className="md:w-48 md:shrink-0">
                    <ul className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-1 md:mx-0 md:flex-col md:overflow-visible md:px-0 md:pb-0">
                        {SETTINGS_SECTIONS.map((entry) => {
                            const href = entry.slug === "general" ? base : `${base}/${entry.slug}`;
                            const active = entry.slug === current.slug;
                            const Icon = entry.icon;
                            return (
                                <li key={entry.slug} className="shrink-0 md:shrink">
                                    <Link
                                        href={href}
                                        aria-current={active ? "page" : undefined}
                                        className={cn(
                                            "flex items-center gap-2 whitespace-nowrap rounded-md px-2.5 py-1.5 text-sm transition-colors hover:bg-muted",
                                            active
                                                ? "bg-muted font-medium text-foreground"
                                                : entry.slug === "danger"
                                                  ? "text-danger/80"
                                                  : "text-muted-foreground"
                                        )}
                                    >
                                        <Icon className="size-4 shrink-0" />
                                        {entry.label}
                                    </Link>
                                </li>
                            );
                        })}
                    </ul>
                </nav>

                <div className="min-w-0 flex-1">
                    {current.slug === "general" && <GeneralSection settings={settings} canManage={canManage} />}
                    {current.slug === "usage" && <UsageSection projectId={settings.id} />}
                    {current.slug === "environments" && (
                        <EnvironmentsSection settings={settings} canManage={canManage} />
                    )}
                    {current.slug === "variables" && <SharedVariablesSection settings={settings} canManage={canManage} />}
                    {current.slug === "webhooks" && <WebhooksSection projectId={settings.id} />}
                    {current.slug === "flags" && <FeatureFlagsSection settings={settings} canManage={canManage} />}
                    {current.slug === "members" && <MembersSection projectId={settings.id} />}
                    {current.slug === "tokens" && <TokensSection projectId={settings.id} canManage={canManage} />}
                    {current.slug === "integrations" && <IntegrationsSection projectId={settings.id} />}
                    {current.slug === "danger" && (
                        <DangerSection settings={settings} canManage={canManage} isOwner={isOwner} />
                    )}
                </div>
            </div>
        </div>
    );
}

/** Shared frame for a settings block: a title, why it matters, and the controls. */
export function SettingsCard({
    title,
    description,
    children,
    tone = "default"
}: {
    title: string;
    description?: string;
    children: React.ReactNode;
    tone?: "default" | "danger";
}) {
    return (
        <section
            className={cn(
                "flex flex-col gap-3 rounded-lg border p-4",
                tone === "danger" ? "border-danger/30 bg-danger/5" : "border-border/60"
            )}
        >
            <div>
                <h2 className={cn("text-sm font-medium", tone === "danger" && "text-danger")}>{title}</h2>
                {description && <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>}
            </div>
            {children}
        </section>
    );
}
