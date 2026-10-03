"use client";

/**
 * The parts of a service's Public Networking panel past adding a domain: the
 * target port each domain dials and the picker of ports the service listens on,
 * renaming a generated name in place, what a custom domain's DNS and certificate
 * say, and TCP proxies.
 *
 * Kept out of `service-detail.tsx`, which renders them inside its one "add a
 * domain" selector and its list of domains.
 */

import * as deployActions from "./actions";
import * as netActions from "./public-networking-actions";
import type { NamespaceTranslator } from "@/lib/i18n/types";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { useEffect, useRef, useState, useTransition } from "react";
import type { DomainReading, ServicePorts, TcpProxyView } from "@/lib/deploy/public-networking";
import {
    CheckCircle2,
    Cloud,
    Loader2,
    Lock,
    Network,
    Pencil,
    TriangleAlert,
    X
} from "lucide-react";
import {
    Button,
    cn,
    CopyButton,
    Dialog,
    DialogContent,
    DialogTitle,
    DnsRecordTable,
    Input,
    Select
} from "@polaris/ui";

type ServiceT = NamespaceTranslator<"deployService">;

/** "Custom" in the port picker: anything the scan did not see. */
const CUSTOM_PORT = "custom";

/** The ports a service listens on, asked once per open panel. */
export function useServicePorts(applicationId: string): ServicePorts | null {
    const [ports, setPorts] = useState<ServicePorts | null>(null);
    useEffect(() => {
        let active = true;
        void netActions
            .servicePortsAction(applicationId)
            .then((result) => {
                if (active && !("error" in result)) setPorts(result);
            })
            .catch(() => undefined);
        return () => {
            active = false;
        };
    }, [applicationId]);
    return ports;
}

/**
 * Pick the port a domain dials: one the service was seen listening on, or any
 * other typed in. With one port seen there is nothing to pick and the field says
 * which it is; Railway's "magic port" does the same.
 */
export function TargetPortField({
    ports,
    value,
    onChange,
    id
}: {
    ports: ServicePorts | null;
    value: string;
    onChange: (next: string) => void;
    id?: string;
}) {
    const t = useTranslations("deployService");
    const seen = ports?.ports ?? [];
    const [custom, setCustom] = useState(false);
    const listed = seen.map(String).includes(value);
    const showCustom = custom || (value !== "" && !listed);
    const options = [
        ...seen.map((port) => ({
            value: String(port),
            label:
                port === ports?.servicePort
                    ? t("publicNet.portService", { port })
                    : t("publicNet.portListening", { port })
        })),
        { value: CUSTOM_PORT, label: t("publicNet.portCustom") }
    ];
    return (
        <div className="flex flex-col gap-1 text-xs text-muted-foreground">
            <span>{t("publicNet.targetPort")}</span>
            <div className="flex flex-wrap items-center gap-2">
                <Select
                    id={id}
                    value={showCustom ? CUSTOM_PORT : value}
                    onValueChange={(next) => {
                        if (next === CUSTOM_PORT) {
                            setCustom(true);
                            onChange("");
                            return;
                        }
                        setCustom(false);
                        onChange(next);
                    }}
                    options={options}
                    className="w-56"
                    aria-label={t("publicNet.targetPort")}
                />
                {showCustom && (
                    <Input
                        value={value}
                        onChange={(event) =>
                            onChange(event.target.value.replace(/[^0-9]/g, "").slice(0, 5))
                        }
                        inputMode="numeric"
                        placeholder="8080"
                        aria-label={t("publicNet.portCustom")}
                        className="w-28"
                    />
                )}
            </div>
            <span>
                {ports === null
                    ? t("publicNet.portScanning")
                    : ports.source === "runtime"
                      ? t("publicNet.portSeen")
                      : t("publicNet.portConfigured")}
            </span>
        </div>
    );
}

/** A valid port from the field, or null. */
export function portValue(value: string): number | null {
    const port = Number(value);
    return Number.isInteger(port) && port >= 1 && port <= 65_535 ? port : null;
}

/**
 * Edit one domain: its subdomain, when it is a name Polaris generated in a zone,
 * and the port it dials. Railway's "Edit domain" and "Edit port" in one dialog,
 * with the subdomain checked as it is typed against the same rules a new name is.
 */
export function EditDomainButton({
    domain,
    applicationId,
    ports,
    onChanged
}: {
    domain: { id: string; hostname: string; targetPort?: number };
    applicationId: string;
    ports: ServicePorts | null;
    onChanged: () => void;
}) {
    const t = useTranslations("deployService");
    const [open, setOpen] = useState(false);
    const [zone, setZone] = useState<{
        zoneHost: string;
        subdomain: string;
        zoneLabel: string;
    } | null>(null);
    const [subdomain, setSubdomain] = useState("");
    const [port, setPort] = useState("");
    const [check, setCheck] = useState<{
        available: boolean;
        invalid?: boolean;
        hostname: string;
    } | null>(null);
    const [checking, setChecking] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();
    const asked = useRef<string | null>(null);

    const current = String(domain.targetPort ?? ports?.servicePort ?? "");

    function start(): void {
        setOpen(true);
        setError(null);
        setPort(current);
        setCheck(null);
        asked.current = null;
        void netActions
            .renameableDomainAction(domain.id)
            .then((result) => {
                setZone(result);
                setSubdomain(result?.subdomain ?? "");
            })
            .catch(() => setZone(null));
    }

    const typed = subdomain.trim().toLowerCase();
    useEffect(() => {
        if (!open || !zone || !typed || typed === zone.subdomain) {
            setCheck(null);
            setChecking(false);
            return;
        }
        const key = `${zone.zoneLabel}|${typed}`;
        if (asked.current === key) return;
        let active = true;
        setChecking(true);
        const timer = setTimeout(() => {
            void deployActions
                .zoneSubdomainAction({ applicationId, zoneLabel: zone.zoneLabel, subdomain: typed })
                .then((result) => {
                    if (!active) return;
                    asked.current = key;
                    setCheck(result);
                    setChecking(false);
                })
                .catch(() => active && setChecking(false));
        }, 350);
        return () => {
            active = false;
            clearTimeout(timer);
        };
    }, [applicationId, open, typed, zone]);

    const renamed = Boolean(zone && typed && typed !== zone.subdomain);
    const portChanged = port !== current;
    const chosenPort = portValue(port);
    const nameBlocked =
        renamed && (checking || !check || check.invalid === true || !check.available);
    const changed = renamed || portChanged;

    function save(): void {
        setError(null);
        startTransition(async () => {
            if (portChanged) {
                if (chosenPort === null) {
                    setError(t("publicNet.portInvalid"));
                    return;
                }
                const result = await netActions.setDomainPortAction({
                    domainId: domain.id,
                    port: chosenPort
                });
                if (result.error) {
                    setError(result.error);
                    return;
                }
            }
            if (renamed) {
                const result = await netActions.renameDomainAction({
                    domainId: domain.id,
                    subdomain: typed
                });
                if (result.error) {
                    setError(result.error);
                    return;
                }
            }
            setOpen(false);
            onChanged();
        });
    }

    return (
        <>
            <button
                type="button"
                onClick={start}
                aria-label={t("publicNet.editOn", { hostname: domain.hostname })}
                title={t("publicNet.edit")}
                className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground md:opacity-0 md:group-hover:opacity-100"
            >
                <Pencil className="size-3.5" />
            </button>
            <Dialog open={open} onOpenChange={setOpen}>
                <DialogContent>
                    <DialogTitle>{t("publicNet.editTitle")}</DialogTitle>
                    <div className="flex flex-col gap-4 text-sm">
                        {zone ? (
                            <div className="flex flex-col gap-1 text-xs text-muted-foreground">
                                <span>{t("publicNet.subdomain")}</span>
                                <div className="flex min-w-0 items-center gap-2">
                                    <Input
                                        value={subdomain}
                                        onChange={(event) => setSubdomain(event.target.value)}
                                        autoComplete="off"
                                        spellCheck={false}
                                        aria-invalid={
                                            renamed &&
                                            check !== null &&
                                            (!check.available || check.invalid === true)
                                        }
                                        aria-label={t("publicNet.subdomain")}
                                        className="min-w-0 flex-1"
                                    />
                                    <span className="min-w-0 truncate" title={`.${zone.zoneHost}`}>
                                        .{zone.zoneHost}
                                    </span>
                                </div>
                                {renamed && (
                                    <span
                                        className={cn(
                                            checking
                                                ? "text-muted-foreground"
                                                : check?.available && !check.invalid
                                                  ? "text-success-ink"
                                                  : "text-danger"
                                        )}
                                    >
                                        {checking || !check
                                            ? t("publicNet.checking")
                                            : check.invalid
                                              ? t("settings.subdomainInvalid")
                                              : check.available
                                                ? t("publicNet.available")
                                                : t("settings.subdomainTaken")}
                                    </span>
                                )}
                            </div>
                        ) : (
                            <p
                                className="truncate text-xs text-muted-foreground"
                                title={domain.hostname}
                            >
                                {domain.hostname}
                            </p>
                        )}
                        <TargetPortField ports={ports} value={port} onChange={setPort} />
                        {error && <p className="text-xs text-danger">{error}</p>}
                        <div className="flex justify-end gap-2">
                            <Button size="sm" variant="outline" onClick={() => setOpen(false)}>
                                {t("publicNet.cancel")}
                            </Button>
                            <Button
                                size="sm"
                                disabled={
                                    pending ||
                                    !changed ||
                                    nameBlocked ||
                                    (portChanged && chosenPort === null)
                                }
                                onClick={save}
                            >
                                {pending ? (
                                    <Loader2 className="size-4 animate-spin" />
                                ) : (
                                    t("publicNet.update")
                                )}
                            </Button>
                        </div>
                    </div>
                </DialogContent>
            </Dialog>
        </>
    );
}

/** Every domain's DNS and certificate, read when the panel opens and again on
 *  demand - the panel is where somebody waits for a record to turn green. */
export function useDomainReadings(
    applicationId: string,
    key: string
): {
    readings: Map<string, DomainReading>;
    refresh: () => void;
    loading: boolean;
} {
    const [readings, setReadings] = useState<Map<string, DomainReading>>(new Map());
    const [loading, setLoading] = useState(false);
    const [nonce, setNonce] = useState(0);
    useEffect(() => {
        let active = true;
        setLoading(true);
        void netActions
            .domainReadingsAction(applicationId)
            .then((result) => {
                if (!active || "error" in result) return;
                setReadings(new Map(result.readings.map((reading) => [reading.id, reading])));
            })
            .catch(() => undefined)
            .finally(() => active && setLoading(false));
        return () => {
            active = false;
        };
    }, [applicationId, key, nonce]);
    return { readings, refresh: () => setNonce((value) => value + 1), loading };
}

function certLine(
    cert: NonNullable<DomainReading["cert"]>,
    t: ServiceT
): { text: string; tone: "ok" | "quiet" | "wait" | "bad" } {
    if (cert.supplied) return { text: t("publicNet.certSupplied"), tone: "ok" };
    if (cert.verdict === "pending") return { text: t("publicNet.certPending"), tone: "wait" };
    if (cert.verdict === "unknown") return { text: t("publicNet.certUnknown"), tone: "quiet" };
    if (cert.verdict === "failed") return { text: t("publicNet.certFailed"), tone: "bad" };
    if (cert.verdict === "expired") return { text: t("publicNet.certExpired"), tone: "bad" };
    if (cert.verdict === "untrusted") return { text: t("publicNet.certUntrusted"), tone: "wait" };
    const days = cert.daysLeft ?? 0;
    return {
        text: cert.issuer
            ? t("publicNet.certValidIssuer", { issuer: cert.issuer, days })
            : t("publicNet.certValid", { days }),
        tone: "ok"
    };
}

/**
 * What one domain's DNS and certificate say, under its row. Silent while all is
 * well beyond one short line, and the records to create when DNS does not point
 * here yet - the CNAME first where the service has a generated name to follow,
 * then the address.
 */
export function DomainReadingView({ reading }: { reading: DomainReading | undefined }) {
    const t = useTranslations("deployService");
    if (!reading) return null;
    const dns = reading.dns;
    const line = reading.cert ? certLine(reading.cert, t) : null;
    // A generated name's certificate is only worth a line when something is wrong
    // with it; on a name somebody brought, its state is part of the setup.
    const cert = line && (dns || (line.tone !== "ok" && line.tone !== "quiet")) ? line : null;
    if (!dns && !cert) return null;
    return (
        <div className="ml-4 flex min-w-0 flex-col gap-2 pb-1 text-xs">
            {dns && (
                <p
                    className={cn(
                        "inline-flex min-w-0 items-start gap-1.5",
                        dns.verdict === "ok"
                            ? "text-success-ink"
                            : dns.verdict === "proxied"
                              ? "text-foreground"
                              : "text-warning-ink"
                    )}
                >
                    {dns.verdict === "ok" ? (
                        <CheckCircle2 className="mt-px size-3.5 shrink-0" />
                    ) : dns.verdict === "proxied" ? (
                        <Cloud className="mt-px size-3.5 shrink-0 text-[#f38020]" />
                    ) : (
                        <TriangleAlert className="mt-px size-3.5 shrink-0" />
                    )}
                    <span>
                        {dns.verdict === "ok"
                            ? t("publicNet.dnsOk")
                            : dns.verdict === "proxied"
                              ? t("publicNet.dnsProxied")
                              : dns.verdict === "missing"
                                ? t("publicNet.dnsMissing")
                                : t("publicNet.dnsElsewhere", {
                                      addresses: dns.addresses.slice(0, 3).join(", ")
                                  })}
                    </span>
                </p>
            )}
            {dns && dns.verdict !== "ok" && dns.records.length > 0 && (
                <>
                    <DnsRecordTable
                        records={dns.records.map((record, index) => ({
                            type: record.type,
                            name: record.name,
                            value: record.value,
                            status: dns.verdict === "elsewhere" ? "conflict" : "waiting",
                            note:
                                index === 0 && dns.records.length > 1
                                    ? t("publicNet.recordPreferred")
                                    : index > 0
                                      ? t("publicNet.recordOr")
                                      : undefined
                        }))}
                    />
                    <p className="text-muted-foreground">
                        {dns.wildcard
                            ? t("publicNet.wildcardHint")
                            : dns.apex
                              ? t("publicNet.apexHint")
                              : t("publicNet.propagationHint")}
                    </p>
                </>
            )}
            {dns?.verdict === "proxied" && (
                <p className="text-muted-foreground">{t("publicNet.cloudflareHint")}</p>
            )}
            {cert && (
                <p
                    className={cn(
                        "inline-flex items-center gap-1.5",
                        cert.tone === "ok" || cert.tone === "quiet"
                            ? "text-muted-foreground"
                            : cert.tone === "wait"
                              ? "text-warning-ink"
                              : "text-danger"
                    )}
                >
                    <Lock className="size-3 shrink-0" /> {cert.text}
                </p>
            )}
        </div>
    );
}

/**
 * The service's TCP proxies: a port of the container published on a public port
 * of the machine, reached as `<address>:<port>`. A change takes effect when the
 * service is next started, so the list says so and offers to do it now.
 */
export function TcpProxyList({
    applicationId,
    nonce,
    canEdit,
    onChanged,
    onCount
}: {
    applicationId: string;
    nonce: number;
    canEdit: boolean;
    onChanged: () => void;
    /** How many proxies the service has, whenever that is read or changes. */
    onCount?: (count: number) => void;
}) {
    const t = useTranslations("deployService");
    const [view, setView] = useState<TcpProxyView | null>(null);
    const [stale, setStale] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();
    const seenNonce = useRef(nonce);

    useEffect(() => {
        // A proxy added through the form arrives as a new nonce: it is not running
        // until the next start, which is what `stale` says.
        if (nonce !== seenNonce.current) {
            seenNonce.current = nonce;
            setStale(true);
        }
        let active = true;
        void netActions
            .tcpProxiesAction(applicationId)
            .then((result) => {
                if (active && !("error" in result)) setView(result);
            })
            .catch(() => undefined);
        return () => {
            active = false;
        };
    }, [applicationId, nonce]);

    const count = view?.proxies.length ?? 0;
    useEffect(() => onCount?.(count), [count]);

    if (!view || (view.proxies.length === 0 && !stale && !error)) return null;
    const host = view.publicHost ?? view.lanHost;

    function remove(port: number): void {
        startTransition(async () => {
            const result = await netActions.removeTcpProxyAction({ applicationId, port });
            if (result.error) {
                setError(result.error);
                return;
            }
            setStale(true);
            setView((current) =>
                current
                    ? {
                          ...current,
                          proxies: current.proxies.filter((proxy) => proxy.container !== port)
                      }
                    : current
            );
            onChanged();
        });
    }

    function apply(): void {
        startTransition(async () => {
            const result = await deployActions.deployApplicationAction(applicationId);
            if (result.error) {
                setError(result.error);
                return;
            }
            setStale(false);
            onChanged();
        });
    }

    return (
        <>
            {view.proxies.map((proxy) => {
                const address = host ? `${host}:${proxy.host}` : `:${proxy.host}`;
                return (
                    <li key={proxy.container} className="group flex min-w-0 items-center gap-2">
                        <Network className="size-3 shrink-0 text-muted-foreground" />
                        <span className="min-w-0 flex-1 truncate font-mono text-xs" title={address}>
                            {address}
                        </span>
                        <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[0.625rem] text-muted-foreground">
                            {t("publicNet.tcpTo", { port: proxy.container })}
                        </span>
                        {host && <CopyButton value={address} label={address} />}
                        <span className="flex w-5 shrink-0 items-center justify-center">
                            {canEdit && (
                                <button
                                    type="button"
                                    title={t("publicNet.tcpRemove")}
                                    aria-label={t("publicNet.tcpRemove")}
                                    onClick={() => remove(proxy.container)}
                                    disabled={pending}
                                    className="text-muted-foreground transition-opacity hover:text-danger disabled:opacity-50 md:opacity-0 md:group-hover:opacity-100"
                                >
                                    <X className="size-3.5" />
                                </button>
                            )}
                        </span>
                    </li>
                );
            })}
            {view.proxies.length > 0 && view.lanHost && view.publicHost && (
                <li className="text-xs text-muted-foreground">
                    {t("publicNet.tcpForward", {
                        ports: view.proxies.map((proxy) => proxy.host).join(", "),
                        lan: view.lanHost
                    })}
                </li>
            )}
            {stale && view.deployed && (
                <li className="flex flex-wrap items-center gap-2 text-xs text-warning-ink">
                    <span>{t("publicNet.tcpApply")}</span>
                    {canEdit && (
                        <Button size="sm" variant="outline" disabled={pending} onClick={apply}>
                            {pending && <Loader2 className="size-3.5 animate-spin" />}{" "}
                            {t("publicNet.tcpApplyNow")}
                        </Button>
                    )}
                </li>
            )}
            {error && <li className="text-xs text-danger">{error}</li>}
        </>
    );
}

/** Where private networking lives, from the public panel: the service's own
 *  Private networking panel, a little further up the same tab. */
export function PrivateNetworkingLink({ targetId }: { targetId: string }) {
    const t = useTranslations("deployService");
    return (
        <button
            type="button"
            onClick={() =>
                document.getElementById(targetId)?.scrollIntoView({ behavior: "smooth", block: "start" })
            }
            className="inline-flex w-fit items-center gap-1 text-xs text-muted-foreground hover:text-foreground hover:underline"
        >
            <Network className="size-3.5" /> {t("publicNet.privateLink")}
        </button>
    );
}
