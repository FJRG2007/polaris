"use client";

/**
 * The connector marketplace: the official servers in `catalog.ts`, searchable,
 * each with its vendor's mark, and a Connect dialog that asks only what that
 * entry needs before it goes through the same create path as a custom
 * connector (and on to OAuth where the entry signs in that way).
 *
 * An entry the administrator's host list refuses is shown as unavailable with
 * that reason; the server refuses it again whatever the page says.
 */

import { useState, type FormEvent } from "react";
import { ExternalLink, Plug, Plus } from "lucide-react";
import {
    Badge,
    Button,
    Card,
    CardBody,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Input,
    SegmentedControl
} from "@polaris/ui";
import { hostAllowed } from "@/lib/polar/connectors/shared";
import { useTranslations } from "@/components/i18n/i18n-provider";
import type { ConnectorView } from "@/lib/polar/connectors/store";
import { ConnectorLogo } from "@/components/polar/connector-marks";
import {
    CONNECTOR_CATALOG,
    catalogUrl,
    entryForUrl,
    shopDomainSchema,
    type AvailableEntry,
    type CatalogEntry
} from "@/lib/polar/connectors/catalog";

type Method = "oauth" | "key";

/** Why an entry cannot be connected here, or null when it can. */
function blockedReason(entry: CatalogEntry, hosts: readonly string[]): "host" | null {
    if (entry.field) return null;
    return hostAllowed(entry.endpoint, hosts) ? null : "host";
}

export function ConnectorCatalog({
    rows,
    hosts,
    send,
    errorText,
    onAdded,
    onCustom
}: {
    rows: readonly ConnectorView[];
    hosts: readonly string[];
    send: (path: string, init: RequestInit) => Promise<{ ok: boolean; body: any }>;
    errorText: (code: unknown) => string;
    onAdded: (view: ConnectorView) => void;
    onCustom: () => void;
}) {
    const t = useTranslations("polar");
    const [query, setQuery] = useState("");
    const [connecting, setConnecting] = useState<AvailableEntry | null>(null);
    const wanted = query.trim().toLowerCase();
    const shown = CONNECTOR_CATALOG.filter((entry) =>
        `${entry.name} ${entry.vendor} ${entry.category}`.toLowerCase().includes(wanted)
    );
    const connected = new Set(
        rows.map((row) => entryForUrl(row.url)?.id).filter((id): id is string => Boolean(id))
    );

    return (
        <section className="flex flex-col gap-3">
            <div className="min-w-0">
                <h2 className="text-sm font-semibold">{t("settings.connectorCatalog.title")}</h2>
                <p className="text-sm text-muted-foreground">
                    {t("settings.connectorCatalog.intro")}
                </p>
            </div>
            <Input
                type="search"
                value={query}
                aria-label={t("settings.connectorCatalog.search")}
                placeholder={t("settings.connectorCatalog.search")}
                onChange={(event) => setQuery(event.target.value)}
            />
            <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {shown.map((entry) => {
                    const blocked = blockedReason(entry, hosts);
                    const isConnected = connected.has(entry.id);
                    return (
                        <li key={entry.id} className="min-w-0">
                            <Card className="h-full">
                                <CardBody className="flex h-full flex-col gap-3">
                                    <div className="flex min-w-0 items-start gap-3">
                                        <ConnectorLogo
                                            logo={entry.logo}
                                            name={entry.vendor}
                                            className="mt-0.5 size-6"
                                        />
                                        <div className="min-w-0 flex-1">
                                            <p
                                                className="truncate text-sm font-medium"
                                                title={entry.name}
                                            >
                                                {entry.name}
                                            </p>
                                            <p className="truncate text-xs text-foreground-subtle">
                                                {entry.vendor}
                                            </p>
                                        </div>
                                    </div>
                                    <p className="flex-1 text-xs text-muted-foreground">
                                        {t(`settings.connectorCatalog.entries.${entry.id}` as never)}
                                    </p>
                                    {blocked === "host" ? (
                                        <p className="text-xs text-warning-ink">
                                            {t("settings.connectorCatalog.hostBlocked")}
                                        </p>
                                    ) : null}
                                    <div className="flex flex-wrap items-center gap-2">
                                        {isConnected ? (
                                            <Badge variant="success">
                                                {t("settings.connectorCatalog.connected")}
                                            </Badge>
                                        ) : blocked ? (
                                            <Badge variant="neutral">
                                                {t("settings.connectorCatalog.unavailable")}
                                            </Badge>
                                        ) : (
                                            <Button
                                                type="button"
                                                size="sm"
                                                onClick={() => setConnecting(entry)}
                                            >
                                                <Plug className="h-3.5 w-3.5 shrink-0" />
                                                {t("settings.connectorCatalog.connect")}
                                            </Button>
                                        )}
                                        <a
                                                href={entry.docs}
                                                target="_blank"
                                                rel="noopener noreferrer"
                                                className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                                            >
                                                {t("settings.connectorCatalog.docs")}
                                                <ExternalLink className="size-3 shrink-0" />
                                            </a>
                                    </div>
                                </CardBody>
                            </Card>
                        </li>
                    );
                })}
                {/* Any server by its address, whatever the search. */}
                    <li className="min-w-0">
                        <Card className="h-full">
                            <CardBody className="flex h-full flex-col gap-3">
                                <div className="min-w-0 flex-1">
                                    <p className="text-sm font-medium">
                                        {t("settings.connectorCatalog.custom")}
                                    </p>
                                    <p className="text-xs text-muted-foreground">
                                        {t("settings.connectorCatalog.customHint")}
                                    </p>
                                </div>
                                <Button
                                    type="button"
                                    size="sm"
                                    variant="outline"
                                    className="self-start"
                                    onClick={onCustom}
                                >
                                    <Plus className="h-3.5 w-3.5 shrink-0" />
                                    {t("settings.connectorCatalog.connect")}
                                </Button>
                            </CardBody>
                        </Card>
                    </li>
                
            </ul>
            <ConnectDialog
                entry={connecting}
                hosts={hosts}
                send={send}
                errorText={errorText}
                onClose={() => setConnecting(null)}
                onAdded={(view) => {
                    setConnecting(null);
                    onAdded(view);
                }}
            />
        </section>
    );
}

function ConnectDialog({
    entry,
    hosts,
    send,
    errorText,
    onClose,
    onAdded
}: {
    entry: AvailableEntry | null;
    hosts: readonly string[];
    send: (path: string, init: RequestInit) => Promise<{ ok: boolean; body: any }>;
    errorText: (code: unknown) => string;
    onClose: () => void;
    onAdded: (view: ConnectorView) => void;
}) {
    const t = useTranslations("polar");
    const [shop, setShop] = useState("");
    const [method, setMethod] = useState<Method>("oauth");
    const [token, setToken] = useState("");
    const [headers, setHeaders] = useState<Record<string, string>>({});
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // Closing starts over: a key typed into a dialog that was put away does
    // not wait in the page for the next one.
    function close() {
        if (pending) return;
        setShop("");
        setMethod("oauth");
        setToken("");
        setHeaders({});
        setError(null);
        onClose();
    }

    if (!entry) return <Dialog open={false} />;

    const url = catalogUrl(entry, shop);
    const shopBad = Boolean(entry.field) && shop.trim() !== "" && !shopDomainSchema.safeParse(shop).success;
    const hostBlocked = url !== null && !hostAllowed(url, hosts);
    const headerBad = (name: string) => {
        const field = entry.headers?.find((header) => header.name === name);
        const value = (headers[name] ?? "").trim();
        return Boolean(field?.pattern && value && !field.pattern.test(value));
    };
    const usesKey = entry.auth === "oauth_or_bearer" && method === "key";
    const complete =
        url !== null &&
        !hostBlocked &&
        (!usesKey || token.trim() !== "") &&
        (entry.auth !== "headers" ||
            (entry.headers ?? []).every(
                (header) => (headers[header.name] ?? "").trim() !== "" && !headerBad(header.name)
            ));

    async function submit(event: FormEvent) {
        event.preventDefault();
        if (!entry || !complete || pending || !url) return;
        setPending(true);
        setError(null);
        const auth =
            entry.auth === "headers"
                ? "headers"
                : entry.auth === "none"
                  ? "none"
                  : usesKey
                    ? "bearer"
                    : "oauth";
        const answer = await send("/api/polar/connectors", {
            method: "POST",
            body: JSON.stringify({
                name: entry.name,
                url,
                auth,
                catalogId: entry.id,
                ...(auth === "bearer" ? { token } : {}),
                ...(auth === "headers"
                    ? {
                          headers: (entry.headers ?? []).map((header) => ({
                              name: header.name,
                              value: headers[header.name] ?? ""
                          }))
                      }
                    : {})
            })
        });
        setPending(false);
        if (answer.ok) {
            setShop("");
            setToken("");
            setHeaders({});
            onAdded(answer.body.connector);
            return;
        }
        setError(errorText(answer.body.error));
    }

    return (
        <Dialog open onOpenChange={(next) => !next && close()}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle className="flex min-w-0 items-center gap-2">
                        <ConnectorLogo logo={entry.logo} name={entry.vendor} className="size-5" />
                        <span className="min-w-0 truncate">
                            {t("settings.connectorCatalog.dialogTitle", { name: entry.name })}
                        </span>
                    </DialogTitle>
                    <DialogDescription>
                        {entry.auth === "headers"
                            ? t("settings.connectorCatalog.fields.partnerHint")
                            : entry.auth === "none"
                              ? t("settings.connectorCatalog.dialogNone")
                              : t("settings.connectorCatalog.dialogOauth", {
                                    vendor: entry.vendor
                                })}
                    </DialogDescription>
                </DialogHeader>
                <form className="flex flex-col gap-3" onSubmit={(event) => void submit(event)}>
                    {entry.field ? (
                        <label className="flex flex-col gap-1 text-sm">
                            <span>{t("settings.connectorCatalog.fields.shop")} *</span>
                            <Input
                                value={shop}
                                maxLength={253}
                                autoFocus
                                inputMode="url"
                                autoComplete="off"
                                aria-invalid={shopBad || undefined}
                                placeholder="name.myshopify.com"
                                onChange={(event) => setShop(event.target.value)}
                            />
                            <span
                                className={shopBad ? "text-xs text-danger" : "text-xs text-muted-foreground"}
                            >
                                {shopBad
                                    ? t("settings.connectorCatalog.fields.shopInvalid")
                                    : t("settings.connectorCatalog.fields.shopHint")}
                            </span>
                        </label>
                    ) : null}
                    {entry.auth === "oauth_or_bearer" ? (
                        <div className="flex flex-col gap-1 text-sm">
                            <span>{t("settings.connectorCatalog.method")}</span>
                            <SegmentedControl<Method>
                                size="sm"
                                value={method}
                                aria-label={t("settings.connectorCatalog.method")}
                                options={[
                                    { value: "oauth", label: t("settings.connectorCatalog.methodOauth") },
                                    { value: "key", label: t("settings.connectorCatalog.methodKey") }
                                ]}
                                onValueChange={setMethod}
                            />
                        </div>
                    ) : null}
                    {usesKey ? (
                        <label className="flex flex-col gap-1 text-sm">
                            <span>{t("settings.connectorCatalog.apiKey")} *</span>
                            <Input
                                type="password"
                                autoComplete="off"
                                value={token}
                                maxLength={4096}
                                onChange={(event) => setToken(event.target.value)}
                            />
                        </label>
                    ) : null}
                    {(entry.headers ?? []).map((header, index) => (
                        <label key={header.name} className="flex flex-col gap-1 text-sm">
                            <span>{t(`settings.connectorCatalog.fields.${header.label}` as never)} *</span>
                            <Input
                                type={header.secret ? "password" : "text"}
                                inputMode={header.pattern ? "numeric" : undefined}
                                autoComplete="off"
                                autoFocus={index === 0}
                                value={headers[header.name] ?? ""}
                                maxLength={2048}
                                aria-invalid={headerBad(header.name) || undefined}
                                onChange={(event) =>
                                    setHeaders((current) => ({
                                        ...current,
                                        [header.name]: event.target.value
                                    }))
                                }
                            />
                            {headerBad(header.name) ? (
                                <span className="text-xs text-danger">
                                    {t(`settings.connectorCatalog.fields.${header.label}Invalid` as never)}
                                </span>
                            ) : null}
                        </label>
                    ))}
                    {hostBlocked ? (
                        <p className="text-xs text-warning-ink">
                            {t("settings.connectorCatalog.hostBlocked")}
                        </p>
                    ) : null}
                    {error ? (
                        <p role="alert" className="text-sm text-danger">
                            {error}
                        </p>
                    ) : null}
                    <DialogFooter>
                        <Button type="button" variant="ghost" disabled={pending} onClick={close}>
                            {t("settings.connectorCatalog.cancel")}
                        </Button>
                        <Button type="submit" aria-disabled={!complete || pending} disabled={pending}>
                            {t("settings.connectorCatalog.connect")}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
