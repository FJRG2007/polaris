"use client";

/**
 * What Polar's chats may reach on this deployment: the web, the free models
 * for people with no key, the free stand-in, and people's own MCP servers.
 *
 * Each switch is saved the moment it changes and put back if the save is
 * refused. Who may use Polar at all is a permission, edited under Management >
 * Roles and Users, not here.
 */

import { useState } from "react";
import { runAction } from "@/lib/run-action";
import { setPolarOptionsAction } from "./actions";
import { useTranslations } from "@/components/i18n/i18n-provider";
import type { PolarConnectorPolicy, PolarOptions } from "@/lib/polar/access";
import { CONNECTOR_AUDIENCES, normalizeHostEntry } from "@/lib/polar/connectors/shared";
import { Card, CardBody, Input, SegmentedControl, Switch, useOptimisticValue } from "@polaris/ui";

export function PolarOptionsCard({ options }: { options: PolarOptions }) {
    const t = useTranslations("admin");
    const [error, setError] = useState<string | null>(null);
    const [current, save] = useOptimisticValue(
        options,
        async (next: PolarOptions) => {
            setError(null);
            return (await runAction(() => setPolarOptionsAction(next), setError)) ?? { error: true };
        },
        { onRefused: setError }
    );
    const connectors = current.connectors;
    const [hostsDraft, setHostsDraft] = useState(connectors.hosts.join(", "));

    const changeConnectors = (patch: Partial<PolarConnectorPolicy>) =>
        save((now) => ({ ...now, connectors: { ...now.connectors, ...patch } }));
    /** The typed hosts, each normalized; an entry that is no host is dropped. */
    const commitHosts = () => {
        const hosts = [
            ...new Set(
                hostsDraft
                    .split(/[\s,]+/)
                    .map(normalizeHostEntry)
                    .filter((host): host is string => Boolean(host))
            )
        ].slice(0, 100);
        setHostsDraft(hosts.join(", "));
        if (hosts.join(",") !== connectors.hosts.join(",")) changeConnectors({ hosts });
    };

    return (
        <Card>
            <CardBody className="space-y-4">
                <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0 space-y-1">
                        <p className="text-sm font-medium">{t("agents.polarAccess.web.label")}</p>
                        <p className="text-muted-foreground text-xs">
                            {t("agents.polarAccess.web.hint")}
                        </p>
                    </div>
                    <Switch
                        checked={current.web}
                        onChange={(web) => save((now) => ({ ...now, web }))}
                        aria-label={t("agents.polarAccess.web.label")}
                    />
                </div>
                <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0 space-y-1">
                        <p className="text-sm font-medium">{t("agents.polarAccess.freeModels.label")}</p>
                        <p className="text-muted-foreground text-xs">
                            {t("agents.polarAccess.freeModels.hint")}
                        </p>
                    </div>
                    <Switch
                        checked={current.freeModels}
                        onChange={(freeModels) => save((now) => ({ ...now, freeModels }))}
                        aria-label={t("agents.polarAccess.freeModels.label")}
                    />
                </div>
                <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0 space-y-1">
                        <p className="text-sm font-medium">
                            {t("agents.polarAccess.zenStandInEveryone.label")}
                        </p>
                        <p className="text-muted-foreground text-xs">
                            {t(
                                current.freeModels
                                    ? "agents.polarAccess.zenStandInEveryone.hint"
                                    : "agents.polarAccess.zenStandInEveryone.off"
                            )}
                        </p>
                    </div>
                    <Switch
                        checked={current.freeModels && current.zenStandInEveryone}
                        disabled={!current.freeModels}
                        onChange={(zenStandInEveryone) =>
                            save((now) => ({ ...now, zenStandInEveryone }))
                        }
                        aria-label={t("agents.polarAccess.zenStandInEveryone.label")}
                    />
                </div>
                <div className="space-y-2">
                    <div className="min-w-0 space-y-1">
                        <p className="text-sm font-medium">
                            {t("agents.polarAccess.connectors.label")}
                        </p>
                        <p className="text-muted-foreground text-xs">
                            {t("agents.polarAccess.connectors.hint")}
                        </p>
                    </div>
                    <SegmentedControl<PolarConnectorPolicy["who"]>
                        size="sm"
                        value={connectors.who}
                        options={CONNECTOR_AUDIENCES.map((value) => ({
                            value,
                            label: t(`agents.polarAccess.connectors.who.${value}`)
                        }))}
                        aria-label={t("agents.polarAccess.connectors.label")}
                        onValueChange={(who) => changeConnectors({ who })}
                    />
                    {connectors.who !== "off" ? (
                        <>
                            <Input
                                value={hostsDraft}
                                onChange={(event) => setHostsDraft(event.target.value)}
                                onBlur={commitHosts}
                                onKeyDown={(event) => {
                                    if (event.key === "Enter") commitHosts();
                                }}
                                placeholder={t("agents.polarAccess.connectors.hostsPlaceholder")}
                                aria-label={t("agents.polarAccess.connectors.hosts")}
                            />
                            <p className="text-muted-foreground text-xs">
                                {t("agents.polarAccess.connectors.hostsHint")}
                            </p>
                            <div className="flex items-center justify-between gap-3">
                                <p className="min-w-0 text-xs text-muted-foreground">
                                    {t("agents.polarAccess.connectors.privateNetwork")}
                                </p>
                                <Switch
                                    checked={connectors.privateNetwork}
                                    onChange={(privateNetwork) =>
                                        changeConnectors({ privateNetwork })
                                    }
                                    aria-label={t("agents.polarAccess.connectors.privateNetwork")}
                                />
                            </div>
                        </>
                    ) : null}
                </div>
                {error ? <p className="text-xs text-danger">{error}</p> : null}
            </CardBody>
        </Card>
    );
}
