/**
 * Connecting an app to this vault (/vault/clients).
 *
 * The point of implementing Bitwarden's API rather than inventing one is that
 * the apps already exist - the browser extension that fills a login, the phone
 * that has it on the lock screen, the CLI in a deploy script. This page is what
 * turns that into something somebody can actually do, which means the URL has to
 * be right and copyable, and the steps have to name what they will see.
 */

import Link from "next/link";
import { Fragment } from "react";
import { loadEnv } from "@polaris/config";
import { getVault } from "@/lib/vault/account";
import { requirePermission } from "@/lib/session";
import { sharingBaseUrl } from "@/lib/domain-service";
import { CopyButton } from "@/components/copy-button";
import { listVaultClients } from "@/lib/vault/devices";
import { BitwardenMark } from "@/components/brand-icons";
import { RelativeTime } from "@/components/relative-time";
import { getTranslations } from "@/lib/i18n/request";
import { Button, Card, CardBody, CardHeader, CardTitle } from "@polaris/ui";
import { ExternalLink, KeyRound, Terminal, TriangleAlert } from "lucide-react";

export const dynamic = "force-dynamic";

export default async function VaultClientsPage() {
    const user = await requirePermission("vault.use");
    const t = await getTranslations("vault");
    const vault = await getVault(user.id);
    // The configured sharing origin, not the tab's host: an address that only
    // works from inside the house is not one to paste into a phone.
    const base = await sharingBaseUrl();
    const clients = await listVaultClients(user.id);
    const serverUrl = `${base}/vault`;
    // i18n-ignore: a command, typed as it is
    const cliCommand = `bw config server ${serverUrl}`;
    const endpoints = [
        ["clients.api", "/api"],
        ["clients.identity", "/identity"],
        ["clients.icons", "/icons"],
        ["clients.notifications", "/notifications"]
    ] as const;
    const insecure =
        !serverUrl.startsWith("https://") && !loadEnv().POLARIS_APP_URL.includes("localhost");

    return (
        <div className="mx-auto flex max-w-3xl flex-col gap-4">
            <div>
                <h1 className="text-[1.0625rem] font-semibold tracking-tight">{t("clients.title")}</h1>
                <p className="text-sm text-muted-foreground">{t("clients.intro")}</p>
            </div>

            {!vault ? (
                <Card>
                    <CardBody className="flex flex-col items-start gap-3 p-6">
                        <p className="text-sm text-muted-foreground">{t("clients.setUpFirst")}</p>
                        <Button asChild size="sm">
                            <Link href="/vault">{t("clients.setUp")}</Link>
                        </Button>
                    </CardBody>
                </Card>
            ) : null}

            <Card>
                <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                        <BitwardenMark className="size-4" />
                        {t("clients.serverAddress")}
                    </CardTitle>
                </CardHeader>
                <CardBody className="flex flex-col gap-3">
                    <div className="flex items-center gap-2">
                        <code className="min-w-0 flex-1 truncate rounded-md border border-border bg-surface px-3 py-2 font-mono text-sm">
                            {serverUrl}
                        </code>
                        <CopyButton value={serverUrl} label={t("clients.serverAddressCopy")} />
                    </div>
                    <p className="text-sm text-muted-foreground">{t("clients.signInHint")}</p>
                    {insecure ? (
                        <div className="flex items-start gap-2 rounded-md border border-warning-edge bg-warning-soft p-3 text-sm">
                            <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" />
                            <span>{t("clients.insecure")}</span>
                        </div>
                    ) : null}
                </CardBody>
            </Card>

            <Card>
                <CardHeader>
                    <CardTitle>{t("clients.whereTitle")}</CardTitle>
                </CardHeader>
                <CardBody className="flex flex-col gap-4 text-sm">
                    <div>
                        <p className="font-medium">{t("clients.extension")}</p>
                        <p className="text-muted-foreground">{t("clients.extensionHint")}</p>
                    </div>
                    <div>
                        <p className="font-medium">{t("clients.desktop")}</p>
                        <p className="text-muted-foreground">{t("clients.desktopHint")}</p>
                    </div>
                    <div>
                        <p className="font-medium">{t("clients.cli")}</p>
                        <p className="text-muted-foreground">{t("clients.cliHint")}</p>
                        <div className="mt-2 flex items-center gap-2">
                            <code className="min-w-0 flex-1 truncate rounded-md border border-border bg-surface px-3 py-2 font-mono text-xs">
                                {cliCommand}
                            </code>
                            <CopyButton
                                value={cliCommand}
                                label={t("clients.cliCopy")}
                            />
                        </div>
                    </div>
                </CardBody>
            </Card>

            <Card>
                <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                        <KeyRound className="size-4" />
                        {t("clients.letInTitle")}
                    </CardTitle>
                </CardHeader>
                <CardBody className="flex flex-col items-start gap-3 text-sm">
                    <p className="text-muted-foreground">{t("clients.letInOne")}</p>
                    <p className="text-muted-foreground">{t("clients.letInTwo")}</p>
                    <Button asChild size="sm" variant="secondary">
                        <Link href="/vault/authorize">{t("clients.approve")}</Link>
                    </Button>
                </CardBody>
            </Card>

            <Card>
                <CardHeader>
                    <CardTitle>{t("clients.ownTitle")}</CardTitle>
                </CardHeader>
                <CardBody className="flex flex-col items-start gap-3 text-sm">
                    <p className="text-muted-foreground">{t("clients.ownOne")}</p>
                    <p className="text-muted-foreground">{t("clients.ownTwo")}</p>
                    <Button asChild size="sm" variant="secondary">
                        <Link href="/account/downloads">{t("clients.downloads")}</Link>
                    </Button>
                </CardBody>
            </Card>

            <Card>
                <CardHeader>
                    <CardTitle>{t("clients.signedInTitle")}</CardTitle>
                </CardHeader>
                <CardBody className="flex flex-col gap-3 text-sm">
                    {clients.length === 0 ? (
                        <p className="text-muted-foreground">{t("clients.noneSignedIn")}</p>
                    ) : (
                        <ul className="flex flex-col divide-y divide-border">
                            {clients.map((client) => (
                                <li
                                    key={client.id}
                                    className="flex items-center gap-3 py-2 first:pt-0 last:pb-0"
                                >
                                    <div className="min-w-0 flex-1">
                                        <p className="truncate" title={client.name}>
                                            {client.name}
                                        </p>
                                        <p className="text-xs text-muted-foreground">
                                            {t.rich("clients.lastUsed", {
                                                label: client.label,
                                                time: () => (
                                                    <RelativeTime key="time" iso={client.lastSeenAt} />
                                                )
                                            })}
                                        </p>
                                    </div>
                                    {client.kind === "extension" ? (
                                        <span className="rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground">
                                            {t("clients.extensionBadge")}
                                        </span>
                                    ) : null}
                                </li>
                            ))}
                        </ul>
                    )}
                    <p className="text-xs text-muted-foreground">{t("clients.claimNote")}</p>
                </CardBody>
            </Card>

            <Card>
                <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                        <Terminal className="size-4" />
                        {t("clients.separateTitle")}
                    </CardTitle>
                </CardHeader>
                <CardBody className="flex flex-col gap-2 text-sm">
                    <p className="text-muted-foreground">{t("clients.separateHint")}</p>
                    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 font-mono text-xs">
                        <dt className="text-muted-foreground">{t("clients.webVault")}</dt>
                        <dd className="truncate" title={serverUrl}>
                            {serverUrl}
                        </dd>
                        {endpoints.map(([label, path]) => (
                            <Fragment key={path}>
                                <dt className="text-muted-foreground">{t(label)}</dt>
                                <dd className="truncate" title={serverUrl + path}>
                                    {serverUrl + path}
                                </dd>
                            </Fragment>
                        ))}
                    </dl>
                </CardBody>
            </Card>

            <Card>
                <CardHeader>
                    <CardTitle>{t("clients.differentTitle")}</CardTitle>
                </CardHeader>
                <CardBody className="flex flex-col gap-2 text-sm text-muted-foreground">
                    <p>{t("clients.differentOne")}</p>
                    <p>{t("clients.differentTwo")}</p>
                    <p>{t("clients.differentThree")}</p>
                    <p className="flex items-center gap-1">
                        <ExternalLink className="size-3" />
                        {t("clients.trademark")}
                    </p>
                </CardBody>
            </Card>
        </div>
    );
}
