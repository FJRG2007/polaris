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
import { useCallback } from "react";
import { SettingsCard } from "../project-settings";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { useLiveRead } from "@/components/use-live-resource";
import { CheckCircle2, CircleDashed, ExternalLink, Loader2 } from "lucide-react";
import { CloudflareMark, DockerMark, GitHubMark } from "@/components/brand-icons";
import {
    cloudflareAccountStatusAction,
    githubReposAction,
    listRegistryCredentialsAction
} from "../actions";

interface IntegrationState {
    github: { connected: boolean; login: string | null; repos: number };
    cloudflare: { connected: boolean; account: string | null; dnsReady: boolean };
    registries: { registry: string; username: string }[];
}

export function IntegrationsSection({ projectId }: { projectId: string }) {
    const t = useTranslations("deploySettings");
    // Instance-wide state with nothing secret in it - whether each is connected,
    // the account names and the registry logins - so the last answer paints at
    // once and the fresh one replaces only what moved.
    const load = useCallback(
        async (): Promise<IntegrationState> => {
            const [github, cloudflare, registries] = await Promise.all([
                githubReposAction().catch(() => ({ connected: false, login: null, repos: [] })),
                cloudflareAccountStatusAction().catch(() => null),
                listRegistryCredentialsAction().catch(() => [])
            ]);
            return {
                github: {
                    connected: github.connected,
                    login: github.login,
                    repos: github.repos.length
                },
                cloudflare: {
                    connected: cloudflare?.connected ?? false,
                    account: cloudflare?.accountName ?? null,
                    dnsReady: cloudflare?.dnsReady ?? false
                },
                registries: registries.map((entry) => ({
                    registry: entry.registry,
                    username: entry.username
                }))
            };
        },
        // Asked again when the project changes, as it always was.
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [projectId]
    );
    const { data: state } = useLiveRead<IntegrationState>({
        load,
        cacheKey: "deploy.integrations"
    });

    if (!state) {
        return (
            <SettingsCard title={t("integrations.title")} description={t("integrations.loadingHint")}>
                <div className="flex justify-center py-6 text-muted-foreground">
                    <Loader2 className="size-5 animate-spin" />
                </div>
            </SettingsCard>
        );
    }

    return (
        <div className="flex flex-col gap-4">
            <SettingsCard
                title={t("integrations.title")}
                description={t("integrations.description")}
            >
                <div className="flex flex-col gap-2">
                    <IntegrationRow
                        icon={<GitHubMark className="size-5" />}
                        // i18n-ignore: a brand name
                        name="GitHub"
                        connected={state.github.connected}
                        detail={
                            state.github.connected
                                ? t("integrations.githubConnected", {
                                      login: state.github.login ?? t("integrations.connected"),
                                      count: state.github.repos
                                  })
                                : t("integrations.githubHint")
                        }
                        // GitHub is the one here that is not instance-wide: it is
                        // whichever accounts the reader has connected themselves.
                        href="/account/connections"
                    />
                    <IntegrationRow
                        icon={<CloudflareMark className="size-5" />}
                        // i18n-ignore: a brand name
                        name="Cloudflare"
                        connected={state.cloudflare.connected}
                        detail={
                            state.cloudflare.connected
                                ? (state.cloudflare.account ?? t("integrations.connected")) +
                                  (state.cloudflare.dnsReady ? t("integrations.dnsReady") : t("integrations.dnsNotReady"))
                                : t("integrations.cloudflareHint")
                        }
                        href="/admin/integrations"
                    />
                    <IntegrationRow
                        icon={<DockerMark className="size-5" />}
                        name={t("integrations.registries")}
                        connected={state.registries.length > 0}
                        detail={
                            state.registries.length > 0
                                ? state.registries
                                      .map((entry) => `${entry.registry} (${entry.username})`)
                                      .join(", ")
                                : t("integrations.registriesHint")
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
    const t = useTranslations("deploySettings");
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
                {connected ? t("integrations.manage") : t("integrations.connect")} <ExternalLink className="size-3" />
            </Link>
        </div>
    );
}
