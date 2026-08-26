"use client";

/**
 * Integrations: what this project is wired to.
 *
 * The connections themselves are instance-wide - one GitHub account, one
 * Cloudflare token, one set of registry logins - so this screen reports their
 * state and links to where they are configured rather than pretending each
 * project has its own. Saying "not connected" here and sending the reader to the
 * one place that fixes it is more useful than a second copy of the form.
 */

import Link from "next/link";
import { useEffect, useState } from "react";
import { SettingsCard } from "../project-settings";
import { CheckCircle2, CircleDashed, ExternalLink, Loader2 } from "lucide-react";
import { CloudflareMark, DockerMark, GitHubMark } from "@/components/brand-icons";
import { cloudflareAccountStatusAction, githubReposAction, listRegistryCredentialsAction } from "../actions";

interface IntegrationState {
    github: { connected: boolean; login: string | null; repos: number };
    cloudflare: { connected: boolean; account: string | null; dnsReady: boolean };
    registries: { registry: string; username: string }[];
}

export function IntegrationsSection({ projectId }: { projectId: string }) {
    const [state, setState] = useState<IntegrationState | null>(null);

    useEffect(() => {
        let active = true;
        void Promise.all([
            githubReposAction().catch(() => ({ connected: false, login: null, repos: [] })),
            cloudflareAccountStatusAction().catch(() => null),
            listRegistryCredentialsAction().catch(() => [])
        ]).then(([github, cloudflare, registries]) => {
            if (!active) return;
            setState({
                github: { connected: github.connected, login: github.login, repos: github.repos.length },
                cloudflare: {
                    connected: cloudflare?.connected ?? false,
                    account: cloudflare?.accountName ?? null,
                    dnsReady: cloudflare?.dnsReady ?? false
                },
                registries: registries.map((entry) => ({ registry: entry.registry, username: entry.username }))
            });
        });
        return () => {
            active = false;
        };
    }, [projectId]);

    if (!state) {
        return (
            <SettingsCard title="Integrations" description="What this project can reach.">
                <div className="flex justify-center py-6 text-muted-foreground">
                    <Loader2 className="size-5 animate-spin" />
                </div>
            </SettingsCard>
        );
    }

    return (
        <div className="flex flex-col gap-4">
            <SettingsCard
                title="Integrations"
                description="What this project can reach. GitHub is whichever accounts you have connected; the rest are set once for the whole instance."
            >
                <div className="flex flex-col gap-2">
                    <IntegrationRow
                        icon={<GitHubMark className="size-5" />}
                        name="GitHub"
                        connected={state.github.connected}
                        detail={
                            state.github.connected
                                ? `${state.github.login ?? "Connected"} - ${state.github.repos} ${state.github.repos === 1 ? "repository" : "repositories"} available`
                                : "Deploy from a private repository, and redeploy when a commit lands."
                        }
                        // GitHub is the one here that is not instance-wide: it is
                        // whichever accounts the reader has connected themselves.
                        href="/account/connections"
                    />
                    <IntegrationRow
                        icon={<CloudflareMark className="size-5" />}
                        name="Cloudflare"
                        connected={state.cloudflare.connected}
                        detail={
                            state.cloudflare.connected
                                ? `${state.cloudflare.account ?? "Connected"}${state.cloudflare.dnsReady ? " - DNS ready" : " - DNS not ready"}`
                                : "Give a service a stable public hostname through a tunnel, with DNS handled for you."
                        }
                        href="/admin/integrations"
                    />
                    <IntegrationRow
                        icon={<DockerMark className="size-5" />}
                        name="Container registries"
                        connected={state.registries.length > 0}
                        detail={
                            state.registries.length > 0
                                ? state.registries.map((entry) => `${entry.registry} (${entry.username})`).join(", ")
                                : "Sign in to a registry so this project can pull private images."
                        }
                        href="/apps/deploy"
                    />
                </div>
            </SettingsCard>
        </div>
    );
}

function IntegrationRow({
    icon,
    name,
    detail,
    connected,
    href
}: {
    icon: React.ReactNode;
    name: string;
    detail: string;
    connected: boolean;
    href: string;
}) {
    return (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border/60 p-3">
            <div className="flex min-w-0 items-center gap-3">
                <span className="grid size-9 shrink-0 place-items-center rounded-lg border border-border bg-surface">
                    {icon}
                </span>
                <div className="min-w-0">
                    <p className="flex items-center gap-1.5 truncate text-sm font-medium">
                        {name}
                        {connected ? (
                            <CheckCircle2 className="size-3.5 shrink-0 text-success" />
                        ) : (
                            <CircleDashed className="size-3.5 shrink-0 text-muted-foreground" />
                        )}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">{detail}</p>
                </div>
            </div>
            <Link
                href={href}
                className="inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs text-primary transition-colors hover:bg-muted"
            >
                {connected ? "Manage" : "Connect"} <ExternalLink className="size-3" />
            </Link>
        </div>
    );
}
