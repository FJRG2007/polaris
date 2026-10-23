"use client";

/**
 * Pointing the network at the network filter, in the menus of the router in front of
 * the operator, and whether it worked.
 *
 * The steps come from the same catalogue as the port-forwarding guide on the
 * Domains page (`lib/router-guide`), so a brand is described once. The check
 * underneath reads the engine's own query log: a device that asked the blocker
 * in the last 24 hours is a device that is using it, which is the only proof that the router
 * setting took - a saved setting looks the same whether devices picked it up or not.
 */

import type { NamespaceKey } from "@/lib/i18n/types";
import { ExternalLink, Loader2, RefreshCw } from "lucide-react";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { Button, CopyButton, Select, Skeleton } from "@polaris/ui";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import {
    likelyGateway,
    routerAdminUrl,
    routerBrandsFor,
    routerGuide,
    type RouterBrand,
    type RouterDnsSetting
} from "@/lib/router-guide";
import type { dnsClientsAction } from "./actions";
import * as polls from "./dns-blocker-polls";

const BRAND_KEY = "polaris.dnsBlocker.routerBrand";
const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

/** A brand in the picker, named in the reader's words by the page. */
export interface RouterBrandOption {
    readonly value: RouterBrand;
    readonly label: string;
}

/** What the last 24 hours of log say about who is using the blocker. */
export type DnsUse =
    | { readonly kind: "none" }
    | { readonly kind: "routerOnly"; readonly router: string }
    | { readonly kind: "devices"; readonly devices: readonly string[] };

/**
 * Reads the distinct clients of the last 24 hours of log. The blocker's own machine is left
 * out (its health checks are not a device), and a log where the only asker is the
 * router means devices reach the blocker through it - covered, but not told apart.
 */
export function dnsUse(clients: readonly string[], address: string | null): DnsUse {
    const devices = clients.filter((client) => !LOOPBACK.has(client) && client !== address);
    if (devices.length === 0) return { kind: "none" };
    const router = likelyGateway(address);
    if (router && devices.length === 1 && devices[0] === router)
        return { kind: "routerOnly", router };
    return { kind: "devices", devices };
}

function bold(chunks: ReactNode[]) {
    return (
        <b key="b" className="font-medium text-foreground">
            {chunks}
        </b>
    );
}

/** A value to type into the router, copied in one click. */
function Value({ text }: { text: string }) {
    return (
        <span className="inline-flex min-w-0 items-center gap-1 align-middle">
            <code className="truncate rounded bg-muted px-1 text-foreground" title={text}>
                {text}
            </code>
            <CopyButton value={text} />
        </span>
    );
}

function readBrand(): RouterBrand | null {
    try {
        const saved = window.localStorage.getItem(BRAND_KEY);
        return routerBrandsFor("dns").some((entry) => entry.id === saved)
            ? (saved as RouterBrand)
            : null;
    } catch {
        return null;
    }
}

function saveBrand(brand: RouterBrand): void {
    try {
        window.localStorage.setItem(BRAND_KEY, brand);
    } catch {
        // A private window: the picker simply starts on the generic steps next time.
    }
}

export function RouterDnsGuide({
    address,
    blocking,
    brands
}: {
    address: string | null;
    blocking: boolean;
    brands: RouterBrandOption[];
}) {
    const t = useTranslations("dnsBlocker");
    const [brand, setBrand] = useState<RouterBrand>("other");
    useEffect(() => {
        const saved = readBrand();
        if (saved) setBrand(saved);
    }, []);

    const guide = routerGuide(brand);
    const adminUrl = routerAdminUrl(guide, address);

    return (
        <div className="flex flex-col gap-3 text-sm">
            <div className="flex flex-wrap items-end gap-2">
                <label className="flex min-w-40 flex-1 flex-col gap-1">
                    <span className="text-muted-foreground">{t("routerGuide.brand")}</span>
                    <Select
                        value={brand}
                        onValueChange={(value) => {
                            setBrand(value as RouterBrand);
                            saveBrand(value as RouterBrand);
                        }}
                        options={brands}
                    />
                </label>
                {adminUrl ? (
                    <Button size="sm" variant="secondary" asChild>
                        <a href={adminUrl} target="_blank" rel="noreferrer noopener">
                            {t("routerGuide.open")} <ExternalLink className="size-3.5" />
                        </a>
                    </Button>
                ) : null}
            </div>

            <RouterDnsSteps brand={brand} address={address} />

            {blocking ? (
                <DnsUseCheck address={address} relay={guide.dns?.mode === "relay"} />
            ) : null}
        </div>
    );
}

/** The steps for one brand: its own menus when its docs were checked, the generic
 *  ones otherwise. */
export function RouterDnsSteps({ brand, address }: { brand: RouterBrand; address: string | null }) {
    const t = useTranslations("dnsBlocker");
    const guide = routerGuide(brand);
    const dns = guide.dns;
    const shown = address ?? t("routerGuide.thisServer");
    const note = `routerGuide.notes.${brand}` as NamespaceKey<"dnsBlocker">;

    const valueFor = (setting: RouterDnsSetting): ReactNode => {
        if (setting.value === "dhcpOption6")
            return address ? <Value text={`6,${address}`} /> : `6,${shown}`;
        if (setting.value === "addressV6") return t("routerGuide.ipv6Address");
        return address ? <Value text={address} /> : shown;
    };
    const saving = (setting: RouterDnsSetting): ReactNode =>
        setting.save ? <> {t.rich("routerGuide.save", { button: setting.save, b: bold })}</> : null;

    return dns === null ? (
        <ol className="flex list-decimal flex-col gap-1 pl-5">
            <li>{t("router.step1")}</li>
            <li>{t("router.step2", { address: address ?? "-" })}</li>
            <li>{t("router.step3")}</li>
            <li>{t("router.step4")}</li>
        </ol>
    ) : (
        <>
            <ol className="flex list-decimal flex-col gap-2 pl-5">
                <li>{t("routerGuide.signIn")}</li>
                <li>
                    {t.rich(dns.mode === "relay" ? "routerGuide.relay" : "routerGuide.lan", {
                        path: dns.lan.path,
                        field: dns.lan.field,
                        b: bold
                    })}{" "}
                    {valueFor(dns.lan)}
                    {saving(dns.lan)}
                </li>
                {dns.ipv6 ? (
                    <li>
                        {t.rich("routerGuide.ipv6", {
                            path: dns.ipv6.path,
                            field: dns.ipv6.field,
                            b: bold
                        })}{" "}
                        {valueFor(dns.ipv6)}
                        {saving(dns.ipv6)}
                    </li>
                ) : null}
                {dns.conflict ? (
                    <li>
                        {t.rich("routerGuide.conflict", {
                            path: dns.conflict.path,
                            field: dns.conflict.field,
                            b: bold
                        })}
                    </li>
                ) : null}
                <li>{t("router.step3")}</li>
                <li>{t("router.step4")}</li>
            </ol>
            {dns.mode === "relay" ? (
                <p className="text-muted-foreground">{t("routerGuide.relayNote")}</p>
            ) : null}
            {t.has(note) ? <p className="text-muted-foreground">{t(note)}</p> : null}
            <a
                href={dns.lan.source}
                target="_blank"
                rel="noreferrer noopener"
                className="inline-flex w-fit items-center gap-1 text-xs text-primary hover:underline"
            >
                {t("routerGuide.source", { brand: guide.label })}{" "}
                <ExternalLink className="size-3" />
            </a>
        </>
    );
}

/** Whether devices are actually asking the blocker, from the last 24 hours of query log. */
function DnsUseCheck({ address, relay }: { address: string | null; relay: boolean }) {
    const t = useTranslations("dnsBlocker");
    const [use, setUse] = useState<DnsUse | null>(null);
    const [logOff, setLogOff] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [checking, setChecking] = useState(true);

    const check = useCallback(
        async (fresh: boolean) => {
            setChecking(true);
            let result: Awaited<ReturnType<typeof dnsClientsAction>>;
            try {
                result = await polls.dnsClients(fresh);
            } catch {
                setError(t("routerGuide.check.failed"));
                return;
            } finally {
                setChecking(false);
            }
            if (result.error !== undefined) {
                setError(result.error);
                return;
            }
            setError(null);
            setLogOff(result.logOff);
            setUse(dnsUse(result.clients, address));
        },
        [address, t]
    );

    useEffect(() => {
        void check(false);
    }, [check]);

    let body: ReactNode;
    if (error) {
        body = (
            <p role="alert" className="text-danger">
                {error}
            </p>
        );
    } else if (!use) {
        body = <Skeleton className="h-10 w-full" />;
    } else if (logOff) {
        body = (
            <p className="rounded-md bg-warning-soft px-3 py-2 text-warning">
                {t("routerGuide.check.logOff")}
            </p>
        );
    } else if (use.kind === "none") {
        body = (
            <p className="rounded-md bg-warning-soft px-3 py-2 text-warning">
                {t("routerGuide.check.none")}
            </p>
        );
    } else if (use.kind === "routerOnly") {
        body = (
            <p
                className={`rounded-md px-3 py-2 ${relay ? "bg-success-soft text-success" : "bg-warning-soft text-warning"}`}
            >
                {t(relay ? "routerGuide.check.relayed" : "routerGuide.check.routerOnly", {
                    router: use.router
                })}
            </p>
        );
    } else {
        body = (
            <div className="flex flex-col gap-2 rounded-md bg-success-soft px-3 py-2">
                <p className="text-success">
                    {t("routerGuide.check.devices", { count: use.devices.length })}
                </p>
                <ul className="flex max-h-32 flex-wrap gap-1 overflow-y-auto overscroll-contain">
                    {use.devices.map((device) => (
                        <li key={device}>
                            <code className="rounded bg-background px-1 text-xs">{device}</code>
                        </li>
                    ))}
                </ul>
            </div>
        );
    }

    return (
        <section className="flex flex-col gap-2 border-t border-border pt-3" aria-busy={checking}>
            <div className="flex items-center justify-between gap-2">
                <h4 className="font-medium">{t("routerGuide.check.title")}</h4>
                <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => void check(true)}
                    disabled={checking}
                    aria-label={t("routerGuide.check.again")}
                    title={t("routerGuide.check.again")}
                >
                    {checking ? <Loader2 className="animate-spin" /> : <RefreshCw />}
                </Button>
            </div>
            {body}
        </section>
    );
}
