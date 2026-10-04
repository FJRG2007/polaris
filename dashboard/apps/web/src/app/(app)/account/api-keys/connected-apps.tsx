"use client";

/**
 * Connected apps: the assistants and editors this person let act for them over
 * MCP, beside the keys they made by hand - the two credentials do the same job
 * and are revoked for the same reasons, so they are listed on one screen.
 *
 * Each row says what identifies the app (where it sends people back to, since
 * its name is its own claim), what it may do, and whether anything still uses
 * it. Disconnecting removes the row at once and puts it back if the server
 * refused.
 */

import Link from "next/link";
import { useState } from "react";
import { Bot, Unplug } from "lucide-react";
import { useRouter } from "next/navigation";
import { useConfirm } from "@/components/confirm-dialog";
import { RelativeTime } from "@/components/relative-time";
import { scopeLabelKey } from "@/lib/mcp/oauth/scope-labels";
import { disconnectAppAction } from "./connected-app-actions";
import type { ConnectedAppView } from "@/lib/mcp/oauth/grants";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { Badge, Button, Card, CardBody, CardHeader, CardTitle } from "@polaris/ui";

export function ConnectedApps({ apps: initial }: { apps: ConnectedAppView[] }) {
    const t = useTranslations("mcp");
    const router = useRouter();
    const [confirm, confirmElement] = useConfirm();
    const [apps, setApps] = useState(initial);
    const [error, setError] = useState<string | null>(null);

    async function disconnect(app: ConnectedAppView) {
        const name = app.name || t("consent.unnamed");
        const ok = await confirm({
            title: t("connectedApps.disconnectTitle", { app: name }),
            description: t("connectedApps.disconnectDescription"),
            confirmLabel: t("connectedApps.disconnect"),
            danger: true
        });
        if (!ok) return;
        setError(null);
        const before = apps;
        setApps((current) => current.filter((entry) => entry.id !== app.id));
        const result = await disconnectAppAction(app.id).catch(() => ({
            error: t("connectedApps.failed")
        }));
        if (result.error) {
            setApps(before);
            setError(result.error);
            return;
        }
        router.refresh();
    }

    return (
        <Card>
            <CardHeader>
                <CardTitle className="flex items-center gap-2">
                    <Bot className="size-4" aria-hidden />
                    {t("connectedApps.title")}
                </CardTitle>
                <p className="text-sm text-muted-foreground">{t("connectedApps.intro")}</p>
            </CardHeader>
            <CardBody className="flex flex-col gap-3 text-sm">
                {error ? (
                    <p role="alert" className="text-danger">
                        {error}
                    </p>
                ) : null}
                {apps.length === 0 ? (
                    <p className="text-muted-foreground">
                        <Link
                            href="/account/downloads"
                            className="underline-offset-2 hover:underline"
                        >
                            {t("connectedApps.empty")}
                        </Link>
                    </p>
                ) : (
                    <ul className="flex flex-col divide-y divide-border/60">
                        {apps.map((app) => (
                            <li
                                key={app.id}
                                className="flex min-w-0 items-start gap-3 py-3 first:pt-0 last:pb-0"
                            >
                                <div className="flex min-w-0 flex-1 flex-col gap-1">
                                    <p className="truncate font-medium" title={app.name}>
                                        {app.name || t("consent.unnamed")}
                                    </p>
                                    {app.redirectHost ? (
                                        <p
                                            className="truncate text-xs text-muted-foreground"
                                            title={app.redirectHost}
                                        >
                                            {t("connectedApps.returnsTo", {
                                                host: app.redirectHost
                                            })}
                                        </p>
                                    ) : null}
                                    <p className="text-xs text-muted-foreground">
                                        {t.rich("connectedApps.connected", {
                                            time: <RelativeTime key="time" iso={app.createdAt} />
                                        })}
                                        {" - "}
                                        {app.lastUsedAt
                                            ? app.lastUsedIp
                                                ? t.rich("connectedApps.lastUsedFrom", {
                                                      time: (
                                                          <RelativeTime
                                                              key="time"
                                                              iso={app.lastUsedAt}
                                                          />
                                                      ),
                                                      ip: app.lastUsedIp
                                                  })
                                                : t.rich("connectedApps.lastUsed", {
                                                      time: (
                                                          <RelativeTime
                                                              key="time"
                                                              iso={app.lastUsedAt}
                                                          />
                                                      )
                                                  })
                                            : t("connectedApps.neverUsed")}
                                    </p>
                                    <ul
                                        className="flex flex-wrap gap-1 pt-1"
                                        aria-label={t("connectedApps.scopeCount", {
                                            count: app.scopes.length
                                        })}
                                    >
                                        {app.scopes.map((scope) => (
                                            <li key={scope}>
                                                <Badge variant="neutral" title={scope}>
                                                    {t(scopeLabelKey(scope))}
                                                </Badge>
                                            </li>
                                        ))}
                                    </ul>
                                </div>
                                <Button
                                    variant="outline"
                                    size="sm"
                                    className="shrink-0"
                                    onClick={() => void disconnect(app)}
                                >
                                    <Unplug className="size-3.5" aria-hidden />
                                    {t("connectedApps.disconnect")}
                                </Button>
                            </li>
                        ))}
                    </ul>
                )}
            </CardBody>
            {confirmElement}
        </Card>
    );
}
