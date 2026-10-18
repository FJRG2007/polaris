"use client";

/**
 * Cloud servers' section of a connections hub: the provider accounts connected
 * for the reader, or for the organization whose hub it is. Connect and Remove
 * are offered only when `canManage`, the same answer the actions reach.
 */

import Link from "next/link";
import { useState } from "react";
import { useCloudT } from "./i18n";
import { PROVIDER_NAMES } from "../lib/providers/types";
import type { AccountView } from "../lib/service";
import { ArrowRight, Cloud, Plus, Trash2 } from "lucide-react";
import { Button, EmptyState } from "@polaris/ui";
import type { CloudConnectionsProps } from "../lib/connections-slot";
import { CLOUD_PAGE } from "../lib/cloud-routes";
import { ConnectDialog, RemoveAccountDialog } from "./cloud-servers-screen";

export function CloudConnectionsSection(props: CloudConnectionsProps) {
    const t = useCloudT();
    const [accounts, setAccounts] = useState<AccountView[]>(props.accounts);
    const [connectOpen, setConnectOpen] = useState(false);
    const [removing, setRemoving] = useState<AccountView | null>(null);
    const org = props.orgName;

    return (
        <section
            id="connection-cloud-servers"
            aria-labelledby="connection-cloud-servers-title"
            className="flex scroll-mt-4 flex-col gap-2"
        >
            <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                    <h2 id="connection-cloud-servers-title" className="text-sm font-medium">
                        {t("title")}
                    </h2>
                    <p className="text-sm text-muted-foreground">
                        {org ? t("hub.orgIntro", { org }) : t("hub.intro")}
                    </p>
                    {org && !props.canManage ? (
                        <p className="text-xs text-muted-foreground">
                            {t("hub.readOnly", { org })}
                        </p>
                    ) : null}
                </div>
                <div className="flex flex-wrap gap-2">
                    {props.canManage ? (
                        <Button size="sm" variant="outline" onClick={() => setConnectOpen(true)}>
                            <Plus className="size-4" />
                            {t("accounts.connect")}
                        </Button>
                    ) : null}
                    {props.canManage && !props.returnTo ? (
                        <Button asChild size="sm" variant="ghost">
                            <Link href={CLOUD_PAGE}>
                                {t("hub.open")}
                                <ArrowRight className="size-4" />
                            </Link>
                        </Button>
                    ) : null}
                </div>
            </div>
            {accounts.length === 0 ? (
                <EmptyState
                    icon={<Cloud className="size-5" />}
                    title={t("accounts.empty")}
                    description={t("accounts.emptyHint")}
                />
            ) : (
                <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                    {accounts.map((account) => (
                        <li
                            key={account.id}
                            className="flex min-w-0 items-start justify-between gap-2 rounded-lg border border-border p-3"
                        >
                            <div className="min-w-0">
                                <p className="truncate font-medium" title={account.name}>
                                    {account.name}
                                </p>
                                <p className="text-xs text-muted-foreground">
                                    {PROVIDER_NAMES[account.provider]}
                                </p>
                                {account.lastError ? (
                                    <p className="mt-1 break-words text-xs text-danger-ink">
                                        {t("accounts.refreshError", { error: account.lastError })}
                                    </p>
                                ) : null}
                            </div>
                            {props.canManage ? (
                                <Button
                                    variant="ghost"
                                    size="icon"
                                    aria-label={t("accounts.remove")}
                                    title={t("accounts.remove")}
                                    onClick={() => setRemoving(account)}
                                >
                                    <Trash2 className="size-4" />
                                </Button>
                            ) : null}
                        </li>
                    ))}
                </ul>
            )}
            {props.canManage ? (
                <ConnectDialog
                    open={connectOpen}
                    orgId={props.orgId}
                    onOpenChange={setConnectOpen}
                    onConnected={(account) => {
                        setConnectOpen(false);
                        setAccounts((current) => [...current, account]);
                    }}
                />
            ) : null}
            {removing ? (
                <RemoveAccountDialog
                    account={removing}
                    onClose={() => setRemoving(null)}
                    onDone={() => {
                        setAccounts((current) => current.filter((a) => a.id !== removing.id));
                        setRemoving(null);
                    }}
                />
            ) : null}
        </section>
    );
}
