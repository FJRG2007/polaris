"use client";

/**
 * Connecting a catalog entry: a dialog that asks only what that entry needs
 * before it goes through the same create path as a custom connector (and on
 * to OAuth where the entry signs in that way).
 *
 * The administrator's host list is checked here so the dialog can say so; the
 * server refuses it again whatever the page says.
 */

import { useState, type FormEvent } from "react";
import {
    Button,
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
import { catalogUrl, shopDomainSchema, type AvailableEntry } from "@/lib/polar/connectors/catalog";

type Method = "oauth" | "key";

export function ConnectDialog({
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
