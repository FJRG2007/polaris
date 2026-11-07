"use client";

/**
 * The services Polaris runs for this app: whether each is up, what it uses, what
 * it prints, and a restart. What Deploy offered for them before they left it.
 */

import { useRouter } from "next/navigation";
import { formatBytes } from "@polaris/core";
import { useState, useTransition } from "react";
import { LogViewer } from "@/components/log-viewer";
import { Button, Card, CardBody } from "@polaris/ui";
import { useConfirm } from "@/components/confirm-dialog";
import type { AppService } from "@/lib/apps/app-services";
import { restartAppServiceAction } from "./service-actions";
import { RefreshCw, RotateCw, ScrollText } from "lucide-react";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { StatusPill, dbTone } from "@/app/(app)/apps/deploy/status-pill";
import { useRuntimeLog } from "@/app/(app)/apps/installed/[id]/use-runtime-log";

export function AppServicesPanel({ appId, services }: { appId: string; services: AppService[] }) {
    const t = useTranslations("marketplace");
    return (
        <section className="flex min-w-0 flex-col gap-2" aria-labelledby="app-services-title">
            <div className="min-w-0">
                <h2 id="app-services-title" className="text-base font-semibold">
                    {t("services.title")}
                </h2>
                <p className="text-sm text-muted-foreground">{t("services.description")}</p>
            </div>
            {services.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t("services.empty")}</p>
            ) : (
                <div className="flex min-w-0 flex-col gap-2">
                    {services.map((service) => (
                        <ServiceRow key={service.applicationId} appId={appId} service={service} />
                    ))}
                </div>
            )}
        </section>
    );
}

function ServiceRow({ appId, service }: { appId: string; service: AppService }) {
    const t = useTranslations("marketplace");
    const router = useRouter();
    const [confirm, confirmDialog] = useConfirm();
    const [showLogs, setShowLogs] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [restarting, startRestart] = useTransition();
    const running = service.status.toLowerCase() === "running";
    const { log, refresh } = useRuntimeLog(service.applicationId, showLogs);
    const title = service.installName ?? service.name;

    async function restart(): Promise<void> {
        const ok = await confirm({
            title: t("services.restartTitle", { name: title }),
            description: t("services.restartDescription"),
            confirmLabel: t("services.restart")
        });
        if (!ok) return;
        setError(null);
        startRestart(async () => {
            const result = await restartAppServiceAction(appId, service.applicationId);
            if (result.error) setError(result.error);
            else router.refresh();
        });
    }

    return (
        <Card>
            <CardBody className="flex min-w-0 flex-col gap-3">
                <div className="flex min-w-0 flex-wrap items-center gap-3">
                    <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium" title={title}>
                            {title}
                        </p>
                        {service.installName && service.installName !== service.name ? (
                            <p className="truncate text-xs text-muted-foreground" title={service.name}>
                                {service.name}
                            </p>
                        ) : null}
                    </div>
                    <StatusPill tone={dbTone(service.status)} label={service.status} />
                    <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                        {t("services.usage", {
                            cpu: service.cpuPercent === null ? "-" : `${service.cpuPercent}%`,
                            memory:
                                service.memUsedBytes === null ? "-" : formatBytes(service.memUsedBytes)
                        })}
                    </span>
                    <div className="flex shrink-0 items-center gap-1">
                        <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setShowLogs((open) => !open)}
                            aria-expanded={showLogs}
                        >
                            <ScrollText className="size-4 shrink-0" />
                            {showLogs ? t("services.hideLogs") : t("services.logs")}
                        </Button>
                        <Button
                            size="sm"
                            variant="outline"
                            onClick={() => void restart()}
                            disabled={restarting}
                        >
                            <RotateCw
                                className={`size-4 shrink-0 ${restarting ? "animate-spin" : ""}`}
                            />
                            {restarting ? t("services.restarting") : t("services.restart")}
                        </Button>
                    </div>
                </div>
                {error ? (
                    <p role="alert" className="text-sm text-danger-ink">
                        {error}
                    </p>
                ) : null}
                {showLogs ? (
                    <div className="flex min-w-0 flex-col gap-2">
                        <div className="flex justify-end">
                            <Button size="sm" variant="ghost" onClick={() => void refresh()}>
                                <RefreshCw className="size-4 shrink-0" />
                                {t("services.refresh")}
                            </Button>
                        </div>
                        <LogViewer
                            log={log}
                            name={service.name}
                            searchable
                            emptyText={
                                running ? t("services.waitingOutput") : t("services.notRunning")
                            }
                            className="h-80"
                        />
                    </div>
                ) : null}
            </CardBody>
            {confirmDialog}
        </Card>
    );
}
