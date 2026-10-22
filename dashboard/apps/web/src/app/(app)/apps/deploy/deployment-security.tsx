"use client";

/**
 * What the deploy vulnerability check said about one release, on its row and
 * in its detail: a chip, the finding that matters (the advisory opens, the
 * package and fixed version are named), and for a release the check held back,
 * "Deploy anyway" - asked in a dialog, since it puts the vulnerable image live,
 * and recorded on the new deployment by the server.
 */

import * as deployActions from "./actions";
import { useState, useTransition } from "react";
import { Badge, Button, cn } from "@polaris/ui";
import { useProjectCan } from "./access-context";
import { useConfirm } from "@/components/confirm-dialog";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { ExternalLink, Loader2, ShieldAlert } from "lucide-react";

type DeploymentSecurity = Awaited<
    ReturnType<typeof deployActions.listDeploymentsAction>
>[number];

/** The chip beside the state badge; nothing when the check found nothing. */
export function SecurityChip({ deployment }: { deployment: DeploymentSecurity }) {
    const t = useTranslations("deployService");
    const found = deployment.security;
    if (!found) return null;
    const held = deployment.canDeployAnyway;
    return (
        <Badge
            variant={held ? "danger" : "warning"}
            className="shrink-0 gap-1"
            title={t("security.chipTitle", { count: found.count })}
        >
            <ShieldAlert className="size-3 shrink-0" aria-hidden />
            {held ? t("security.chipHeld") : t("security.chip")}
        </Badge>
    );
}

/**
 * The finding under the row's subtitle, and the way past a refusal. Clicks are
 * kept off the row, which opens the deployment's log.
 */
export function SecurityNote({
    deployment,
    onDeployStarted,
    className
}: {
    deployment: DeploymentSecurity;
    /** The new deployment "Deploy anyway" started; the caller follows it. */
    onDeployStarted: (deploymentId: string) => void;
    className?: string;
}) {
    const t = useTranslations("deployService");
    const can = useProjectCan();
    const [confirm, confirmation] = useConfirm();
    const [pending, startTransition] = useTransition();
    const [error, setError] = useState<string | null>(null);
    const found = deployment.security;
    if (!found) return null;

    async function deployAnyway() {
        const ok = await confirm({
            title: t("security.confirmTitle"),
            description: t("security.confirmBody"),
            confirmLabel: t("security.deployAnyway"),
            danger: true
        });
        if (!ok) return;
        setError(null);
        startTransition(async () => {
            const result = await deployActions
                .deployAnywayAction(deployment.id)
                .catch(() => ({ error: t("security.failed"), deploymentId: undefined }));
            if (result.error) setError(result.error);
            if (result.deploymentId) onDeployStarted(result.deploymentId);
        });
    }

    const held = deployment.canDeployAnyway;
    return (
        <div
            className={cn("flex min-w-0 flex-col gap-1 text-xs", className)}
            onClick={(event) => event.stopPropagation()}
        >
            <p className={cn("flex min-w-0 flex-wrap items-center gap-x-1", held ? "text-danger-ink" : "text-warning-ink")}>
                <ShieldAlert className="size-3.5 shrink-0" aria-hidden />
                <span>{t("security.found", { count: found.count })}</span>
                {found.url ? (
                    <a
                        href={found.url}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-0.5 font-mono underline-offset-2 hover:underline"
                    >
                        {found.id}
                        <ExternalLink className="size-3 shrink-0" aria-hidden />
                    </a>
                ) : (
                    <span className="font-mono">{found.id}</span>
                )}
                <span className="min-w-0 truncate" title={found.package}>
                    {t("security.where", { package: found.package, fixedIn: found.fixedIn })}
                </span>
            </p>
            {held && <p className="text-muted-foreground">{t("security.refused")}</p>}
            {deployment.securityOverrideAt && (
                <p className="text-muted-foreground">{t("security.overridden")}</p>
            )}
            {held && can("deploy.run") && (
                <div className="flex flex-wrap items-center gap-2">
                    <Button
                        variant="outline"
                        size="sm"
                        disabled={pending}
                        onClick={() => void deployAnyway()}
                    >
                        {pending && <Loader2 className="size-4 animate-spin" aria-hidden />}
                        {t("security.deployAnyway")}
                    </Button>
                    {error && <span className="text-danger-ink">{error}</span>}
                </div>
            )}
            {confirmation}
        </div>
    );
}
