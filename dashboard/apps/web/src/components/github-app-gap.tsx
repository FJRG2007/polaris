"use client";

/**
 * What keeps a linked GitHub account from a repository, with the one step that
 * fixes it: install Polaris's App on the owner, add the repository to the
 * installation, or connect an account at all. Drawn under a Polar answer and in
 * the Agents dialogs, wherever `github-app-reach.ts` found the gap.
 *
 * The step happens on github.com, in a new tab, so "Check again" is offered
 * beside it to ask once the person is back.
 */

import { Button } from "@polaris/ui";
import type { GithubAppGap } from "@/lib/github-app-reach";
import { ExternalLink, Github, RefreshCw } from "lucide-react";
import { useTranslations } from "@/components/i18n/i18n-provider";

export function GithubAppGapNotice({
    gap,
    onCheckAgain,
    checking = false
}: {
    gap: GithubAppGap;
    onCheckAgain?: () => void;
    checking?: boolean;
}) {
    const t = useTranslations("components");
    const title =
        gap.kind === "app-missing"
            ? t("githubAppGap.missingTitle", { owner: gap.owner })
            : gap.kind === "repo-not-selected"
              ? t("githubAppGap.notSelectedTitle", { repository: gap.repository })
              : t("githubAppGap.noAccountTitle");
    const body =
        gap.kind === "app-missing"
            ? t("githubAppGap.missingBody", { owner: gap.owner })
            : gap.kind === "repo-not-selected"
              ? t("githubAppGap.notSelectedBody", { owner: gap.owner })
              : t("githubAppGap.noAccountBody");
    const action =
        gap.kind === "app-missing"
            ? t("githubAppGap.install", { owner: gap.owner })
            : gap.kind === "repo-not-selected"
              ? t("githubAppGap.choose")
              : t("githubAppGap.connect");
    return (
        <div
            role="status"
            className="min-w-0 space-y-2 rounded-md border border-border bg-surface p-3 text-sm"
        >
            <p className="flex min-w-0 items-center gap-2 font-medium">
                <Github className="size-4 shrink-0" />
                <span className="min-w-0 break-words">{title}</span>
            </p>
            <p className="break-words text-muted-foreground">{body}</p>
            <div className="flex flex-wrap gap-2">
                {gap.url ? (
                    <Button asChild size="sm">
                        <a href={gap.url} target="_blank" rel="noopener noreferrer">
                            <ExternalLink className="size-4 shrink-0" />
                            <span className="min-w-0 truncate" title={action}>{action}</span>
                        </a>
                    </Button>
                ) : null}
                {onCheckAgain ? (
                    <Button
                        size="sm"
                        variant="secondary"
                        onClick={onCheckAgain}
                        disabled={checking}
                        aria-busy={checking}
                    >
                        <RefreshCw className="size-4 shrink-0" />
                        {t("githubAppGap.checkAgain")}
                    </Button>
                ) : null}
            </div>
            {gap.kind === "app-missing" && !gap.url ? (
                <p className="break-words text-xs text-muted-foreground">
                    {t("githubAppGap.noAppPage")}
                </p>
            ) : null}
        </div>
    );
}

/** Gaps found by a turn's repository reads, each owner and repository once. Pure. */
export function gapsOf(outputs: readonly unknown[]): GithubAppGap[] {
    const found = new Map<string, GithubAppGap>();
    for (const output of outputs) {
        const access = (output as { access?: unknown } | null)?.access;
        if (!isGap(access)) continue;
        const key = `${access.kind}:${access.owner.toLowerCase()}:${
            access.kind === "repo-not-selected" ? access.repository.toLowerCase() : ""
        }`;
        found.set(key, access);
    }
    return [...found.values()];
}

function isGap(value: unknown): value is GithubAppGap {
    if (!value || typeof value !== "object") return false;
    const gap = value as Record<string, unknown>;
    if (typeof gap.owner !== "string") return false;
    if (gap.url !== null && typeof gap.url !== "string") return false;
    if (gap.kind === "repo-not-selected") return typeof gap.repository === "string";
    return gap.kind === "app-missing" || gap.kind === "no-account";
}
