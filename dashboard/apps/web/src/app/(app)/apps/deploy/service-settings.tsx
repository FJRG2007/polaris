"use client";

/**
 * A service's Settings tab, in the service panel: networking, source and
 * deploys, scaling, the rarer machine-level choices, and removal - each a
 * section of cards with a Save of its own, under a navigator that follows the
 * scroll (see settings-kit.tsx for the pieces).
 */

import Link from "next/link";
import * as deployActions from "./actions";
import { DomainCdnButton } from "./domain-cdn";
import { EdgeSettings } from "./edge-settings";
import * as publicNet from "./public-networking";
import { useProjectCan } from "./access-context";
import { ScalingSection } from "./scaling-section";
import type { ProjectApp } from "./deploy-view";
import { ownDomains } from "./domain-rank";
import { useConfirm } from "@/components/confirm-dialog";
import { useParams, useRouter } from "next/navigation";
import { UploadedSourceSection } from "./upload-source";
import { stageServiceDeleteAction } from "./project-actions";
import { BuildMachineSection } from "./build-machine-section";
import { DeployBehaviourSection } from "./deploy-behaviour-section";
import { isTunnelHostname, runtimeVersionSchema } from "@polaris/core";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { MoveOutDialog } from "@/app/(app)/apps/deploy/move-dialogs";
import { CloudflareMark, NgrokMark } from "@/components/brand-icons";
import type { NamespaceKey, NamespaceTranslator } from "@/lib/i18n/types";
import { PrivateNetworkPanel, privateNetworkAnchor } from "./private-network-panel";
import { Fragment, useEffect, useRef, useState, useTransition, type ReactNode } from "react";
import { addTcpProxyAction, setDomainPortByHostnameAction } from "./public-networking-actions";
import {
    SaveBar,
    SettingsCard,
    SettingsLayout,
    SettingsSection,
    useCardForm,
    useSavedFlash,
    type SettingsSectionLink
} from "./settings-kit";
import {
    Badge,
    Button,
    Checkbox,
    cn,
    ConfirmDeleteDialog,
    CopyButton,
    Dialog,
    DialogContent,
    DialogTitle,
    DnsRecordTable,
    Input,
    SegmentedControl,
    Select,
    Switch,
    Textarea
} from "@polaris/ui";
import {
    ArrowUpRight,
    CheckCircle2,
    Gauge,
    GitBranch,
    Globe,
    Loader2,
    MapPin,
    Network,
    Plus,
    ShieldCheck,
    SlidersHorizontal,
    Trash2,
    TriangleAlert,
    X
} from "lucide-react";

type ServiceT = NamespaceTranslator<"deployService">;

/** How a tunnel's state reads as a chip: live is information, trouble is a warning. */
type ExposureTone = "neutral" | "primary" | "success" | "warning" | "danger";

/** One active exposure in the Public access list: a link + optional badge, an
 *  enable/disable switch, and an optional remove control, so tunnels read and behave
 *  like the domain rows above them. */
function ExposureRow({
    icon,
    label,
    href,
    badge,
    tone = "neutral",
    enabled,
    pending,
    onToggle,
    onRemove,
    removeLabel
}: {
    icon: ReactNode;
    label: string;
    href: string | null;
    badge?: string;
    tone?: ExposureTone;
    enabled: boolean;
    pending: boolean;
    onToggle: (next: boolean) => void;
    onRemove?: () => void;
    removeLabel?: string;
}) {
    const t = useTranslations("deployService");
    const reveal = "md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100";
    return (
        <li className="group flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 rounded-md px-2 py-1.5 hover:bg-card-hover">
            <span className="flex size-3.5 shrink-0 items-center justify-center" aria-hidden>
                {icon}
            </span>
            {href && enabled ? (
                <a
                    href={href}
                    target="_blank"
                    rel="noreferrer"
                    title={label}
                    className="min-w-0 flex-1 basis-40 truncate font-mono text-xs text-foreground hover:text-primary hover:underline"
                >
                    {label}
                </a>
            ) : (
                <span
                    title={label}
                    className={cn(
                        "min-w-0 flex-1 basis-40 truncate font-mono text-xs",
                        enabled ? "text-muted-foreground" : "text-foreground-subtle line-through"
                    )}
                >
                    {label}
                </span>
            )}
            {/* Beside the name when there is room, on a line of their own when not. */}
            <div className="ml-auto flex shrink-0 items-center gap-1.5">
                {href && (
                    <CopyButton
                        value={href.replace(/^https?:\/\//, "")}
                        className={cn("shrink-0 rounded p-1", reveal)}
                    />
                )}
                {badge && (
                    <Badge variant={tone} className="shrink-0">
                        {badge}
                    </Badge>
                )}
                <Switch
                    checked={enabled}
                    onChange={onToggle}
                    disabled={pending}
                    aria-label={t(enabled ? "kit.disableNamed" : "kit.enableNamed", {
                        name: label
                    })}
                />
                {/* Remove sits to the right of the switch, in a fixed-width slot so the
                switches still line up across every row whether or not a row has one. */}
                <span className="flex w-6 shrink-0 items-center justify-center">
                    {onRemove && (
                        <button
                            type="button"
                            title={removeLabel ?? t("menu.remove")}
                            aria-label={`${removeLabel ?? t("menu.remove")}: ${label}`}
                            onClick={onRemove}
                            disabled={pending}
                            className={cn(
                                "rounded p-1 text-muted-foreground transition-colors hover:text-danger-ink disabled:opacity-50",
                                reveal
                            )}
                        >
                            {pending ? (
                                <Loader2 className="size-3.5 animate-spin" aria-hidden />
                            ) : (
                                <X className="size-3.5" aria-hidden />
                            )}
                        </button>
                    )}
                </span>
            </div>
        </li>
    );
}

/** The app's Cloudflare quick tunnel, shown when running. Refetches on `nonce` change. */
function QuickTunnelRow({
    appId,
    nonce,
    onChanged,
    onHostname
}: {
    appId: string;
    nonce: number;
    onChanged: () => void;
    /** The hostname it holds now, or null, so the list can draw it once. */
    onHostname: (hostname: string | null) => void;
}) {
    const [status, setStatus] = useState<Awaited<
        ReturnType<typeof deployActions.quickTunnelStatusAction>
    > | null>(null);
    const t = useTranslations("deployService");
    const [pending, startTransition] = useTransition();
    useEffect(() => {
        void deployActions
            .quickTunnelStatusAction(appId)
            .then((result) => {
                setStatus(result);
                const held = result.running && result.url ? result.url : null;
                onHostname(held ? held.replace(/^https?:\/\//, "").toLowerCase() : null);
            })
            .catch(() => undefined);
    }, [appId, nonce]);
    if (!status?.running) return null;
    return (
        <ExposureRow
            icon={<CloudflareMark className="size-3.5" />}
            label={status.url ? status.url.replace(/^https?:\/\//, "") : t("tunnels.starting")}
            href={status.url}
            // The sidecar can be up with a hostname that no longer answers, so say
            // which it is instead of presenting every running tunnel as a live link.
            badge={
                !status.url
                    ? t("tunnels.starting")
                    : status.reachable
                      ? t("tunnels.quickLink")
                      : t("tunnels.notAnswering")
            }
            tone={!status.url ? "neutral" : status.reachable ? "primary" : "warning"}
            enabled
            pending={pending}
            onToggle={() =>
                startTransition(async () => {
                    await deployActions.stopQuickTunnelAction(appId).catch(() => undefined);
                    onChanged();
                })
            }
        />
    );
}

/** The app's ngrok tunnel, shown when running. */
function NgrokTunnelRow({
    appId,
    nonce,
    onChanged,
    onHostname
}: {
    appId: string;
    nonce: number;
    onChanged: () => void;
    /** The hostname it holds now, or null, so the list can draw it once. */
    onHostname: (hostname: string | null) => void;
}) {
    const [status, setStatus] = useState<Awaited<
        ReturnType<typeof deployActions.ngrokTunnelStatusAction>
    > | null>(null);
    const t = useTranslations("deployService");
    const [pending, startTransition] = useTransition();
    useEffect(() => {
        void deployActions
            .ngrokTunnelStatusAction(appId)
            .then((result) => {
                setStatus(result);
                const held = result.running && result.url ? result.url : null;
                onHostname(held ? held.replace(/^https?:\/\//, "").toLowerCase() : null);
            })
            .catch(() => undefined);
    }, [appId, nonce]);
    if (!status?.running) return null;
    return (
        <ExposureRow
            icon={<NgrokMark className="size-3.5" />}
            label={status.url ? status.url.replace(/^https?:\/\//, "") : t("tunnels.starting")}
            href={status.url}
            // i18n-ignore: a brand name
            badge="ngrok"
            enabled
            pending={pending}
            onToggle={() =>
                startTransition(async () => {
                    await deployActions.stopNgrokTunnelAction(appId).catch(() => undefined);
                    onChanged();
                })
            }
        />
    );
}

/** The app's Cloudflare named tunnel (stable hostname), shown when configured. */
function NamedTunnelRow({
    appId,
    nonce,
    onChanged,
    onHostname
}: {
    appId: string;
    nonce: number;
    onChanged: () => void;
    /** The hostname it holds now, or null, so the list can draw it once. */
    onHostname: (hostname: string | null) => void;
}) {
    const [status, setStatus] = useState<Awaited<
        ReturnType<typeof deployActions.namedTunnelStatusAction>
    > | null>(null);
    const t = useTranslations("deployService");
    const [pending, startTransition] = useTransition();
    useEffect(() => {
        void deployActions
            .namedTunnelStatusAction(appId)
            .then((result) => {
                setStatus(result);
                const held = result.configured && result.hostname ? result.hostname : null;
                onHostname(held ? held.replace(/^https?:\/\//, "").toLowerCase() : null);
            })
            .catch(() => undefined);
    }, [appId, nonce]);
    if (!status?.configured || !status.hostname) return null;
    const enabled = status.enabled;
    return (
        <ExposureRow
            icon={<CloudflareMark className="size-3.5" />}
            label={status.hostname}
            href={`https://${status.hostname}`}
            badge={
                !enabled
                    ? t("tunnels.disabled")
                    : status.managed
                      ? t("tunnels.auto")
                      : status.running
                        ? t("tunnels.tunnel")
                        : t("tunnels.notRunning")
            }
            tone={!enabled ? "neutral" : status.managed || status.running ? "primary" : "warning"}
            enabled={enabled}
            pending={pending}
            onToggle={(next) =>
                startTransition(async () => {
                    await deployActions
                        .setNamedTunnelEnabledAction({ applicationId: appId, enabled: next })
                        .catch(() => undefined);
                    onChanged();
                })
            }
            onRemove={() =>
                startTransition(async () => {
                    await deployActions.stopNamedTunnelAction(appId).catch(() => undefined);
                    onChanged();
                })
            }
            removeLabel={t("tunnels.remove")}
        />
    );
}

/** Every way to expose a service, unified into the one Public access selector. */
type ExposureKind =
    | "zone"
    | "subdomain"
    | "local"
    | "le"
    | "duckdns"
    | "proxy"
    | "cf-named"
    | "cf-quick"
    | "ngrok"
    | "tcp";

const EXPOSURE_OPTIONS: {
    value: ExposureKind;
    label: NamespaceKey<"deployService">;
    icon: ReactNode;
}[] = [
    {
        value: "zone",
        label: "exposure.zone",
        icon: <Globe className="size-4 text-primary" />
    },
    {
        value: "subdomain",
        label: "exposure.subdomain",
        icon: <Globe className="size-4 text-muted-foreground" />
    },
    {
        value: "local",
        label: "exposure.local",
        icon: <MapPin className="size-4 text-muted-foreground" />
    },
    {
        value: "le",
        label: "exposure.custom",
        icon: <Globe className="size-4 text-muted-foreground" />
    },
    {
        value: "cf-named",
        label: "exposure.cfNamed",
        icon: <CloudflareMark className="size-4" />
    },
    {
        value: "cf-quick",
        label: "exposure.cfQuick",
        icon: <CloudflareMark className="size-4" />
    },
    { value: "ngrok", label: "exposure.ngrok", icon: <NgrokMark className="size-4" /> },
    {
        value: "duckdns",
        label: "exposure.duckdns",
        icon: <img src="/logos/duckdns.webp" alt="" className="size-4 shrink-0" />
    },
    {
        value: "proxy",
        label: "exposure.proxy",
        icon: <Globe className="size-4 text-muted-foreground" />
    },
    {
        value: "tcp",
        label: "exposure.tcp",
        icon: <Network className="size-4 text-muted-foreground" />
    }
];

/** Stands in for the base-domain zone, whose label is empty - Radix rejects an
 *  empty select value, and "@" is how a DNS zone's own record is written anyway. */
const ZONE_ROOT = "@";

/** One entry in the zone picker, as the server describes it. */
type DeployZone = Awaited<ReturnType<typeof deployActions.deployZonesAction>>["zones"][number];

/** How a zone reads in the picker. The base domain is called out because it is the
 *  one entry that needs a DNS record per name rather than riding a wildcard, and a
 *  domain somebody brought is called out because it and one of this Polaris's own
 *  look identical otherwise - which of the two a service answers on is the whole
 *  decision being made here. */
function zoneOptionLabel(zone: DeployZone, t: ServiceT): string {
    if (zone.kind === "base") return t("domains.zoneBase", { host: zone.host });
    return zone.kind === "owned" ? t("domains.zoneOwned", { host: zone.host }) : `*.${zone.host}`;
}

/** What the server says about the subdomain in the field: the name, the hostname it
 *  makes, and whether anything already answers on it. */
type ZoneSubdomainCheck = Awaited<ReturnType<typeof deployActions.zoneSubdomainAction>>;

/** A URL-safe label from the app name, the default for a local/DuckDNS subdomain. */
function defaultLabel(name: string): string {
    return (
        name
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "") || "app"
    );
}

/** What the server did about a custom hostname's DNS, when it did anything. */
type AddDomainDns = Awaited<ReturnType<typeof deployActions.addDomainAction>>["dns"];

/** What is left to do about a custom hostname's DNS, in one line, and the record to
 *  create when there is one to create by hand. Null when the name already answers
 *  here, which is the case that needs saying nothing. */
function dnsAdvice(
    dns: AddDomainDns,
    hostname: string,
    t: ServiceT
): { text: string; record?: { name: string; ip: string; conflict: boolean } } | null {
    if (!dns || dns.status === "unchanged") return null;
    if (dns.status === "created")
        return { text: t("domains.dnsCreated", { hostname, ip: dns.ip ?? "" }) };
    const record = dns.ip
        ? { name: hostname, ip: dns.ip, conflict: dns.status === "conflict" }
        : undefined;
    if (dns.status === "conflict") {
        return {
            text: t("domains.dnsConflict", {
                hostname,
                content: dns.content ?? "",
                ip: dns.ip ?? ""
            }),
            record
        };
    }
    const text = dns.ip
        ? dns.detail
            ? t("domains.dnsPointAtDetail", { hostname, ip: dns.ip, detail: dns.detail })
            : t("domains.dnsPointAt", { hostname, ip: dns.ip })
        : dns.detail
          ? t("domains.dnsPointDetail", { hostname, detail: dns.detail })
          : t("domains.dnsPoint", { hostname });
    return { text, record };
}

/**
 * Put an operator's own certificate on one domain.
 *
 * Behind a dialog rather than in the row: it is two long PEM blocks and it is not what
 * anybody came to this list to do. The icon carries the state, so a domain already
 * serving a supplied certificate says so without being opened.
 */
function DomainCertificateButton({
    domainId,
    hostname,
    supplied,
    onChanged
}: {
    domainId: string;
    hostname: string;
    supplied: boolean;
    onChanged: () => void;
}) {
    const [open, setOpen] = useState(false);
    const [certPem, setCertPem] = useState("");
    const [keyPem, setKeyPem] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [warning, setWarning] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();
    const t = useTranslations("deployService");

    function save(input: { certPem: string; keyPem: string } | null) {
        startTransition(async () => {
            const result = await deployActions
                .setDomainCertificateAction(domainId, input)
                .catch((): { error?: string; warning?: string } => ({
                    error: t("errors.notThrough")
                }));
            if (result?.error) {
                setError(result.error);
                return;
            }
            setError(null);
            setWarning(result?.warning ?? null);
            setCertPem("");
            setKeyPem("");
            if (!result?.warning) setOpen(false);
            onChanged();
        });
    }

    return (
        <>
            <button
                type="button"
                onClick={() => setOpen(true)}
                aria-label={
                    supplied
                        ? t("certificate.replaceOn", { hostname })
                        : t("certificate.useOn", { hostname })
                }
                title={supplied ? t("certificate.serving") : t("certificate.use")}
                className={cn(
                    "shrink-0 rounded p-1 transition-colors hover:bg-muted hover:text-foreground",
                    supplied
                        ? "text-primary"
                        : "text-muted-foreground md:opacity-0 md:group-hover:opacity-100"
                )}
            >
                <ShieldCheck className="size-3.5" />
            </button>
            <Dialog open={open} onOpenChange={setOpen}>
                <DialogContent>
                    <DialogTitle>{t("certificate.title", { hostname })}</DialogTitle>
                    <div className="flex flex-col gap-3 text-sm">
                        <p className="text-xs text-muted-foreground">
                            {t("certificate.intro", { hostname })}
                        </p>
                        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                            {t("certificate.chain")}
                            <Textarea
                                rows={5}
                                value={certPem}
                                onChange={(event) => setCertPem(event.target.value)}
                                placeholder={t("certificate.chainPlaceholder")}
                                className="font-mono text-xs"
                            />
                        </label>
                        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                            {t("certificate.key")}
                            <Textarea
                                rows={4}
                                value={keyPem}
                                onChange={(event) => setKeyPem(event.target.value)}
                                placeholder={t("certificate.keyPlaceholder")}
                                className="font-mono text-xs"
                            />
                        </label>
                        {error && <p className="text-xs text-danger">{error}</p>}
                        {warning && <p className="text-xs text-warning">{warning}</p>}
                        <div className="flex items-center gap-2">
                            <Button
                                size="sm"
                                disabled={pending || !certPem.trim() || !keyPem.trim()}
                                onClick={() => save({ certPem, keyPem })}
                            >
                                {pending ? (
                                    <Loader2 className="size-4 animate-spin" />
                                ) : (
                                    t("certificate.save")
                                )}
                            </Button>
                            {supplied && (
                                <Button
                                    size="sm"
                                    variant="outline"
                                    disabled={pending}
                                    onClick={() => save(null)}
                                >
                                    {t("certificate.backToManaged")}
                                </Button>
                            )}
                        </div>
                    </div>
                </DialogContent>
            </Dialog>
        </>
    );
}

/** One domain's probe result, as the panel overlays it onto what was rendered. */
type DomainHealth = {
    healthStatus?: string | null;
    healthCode?: number | null;
    healthDetail?: string | null;
};

/**
 * Keep the status dots current while the panel is open.
 *
 * The health of a domain is the one thing here that changes without anybody doing
 * something: the poller probes on its own minute, so a domain added a moment ago has no
 * result yet, and the render that put it on screen never asks again - which left a
 * working domain showing "not checked yet" until the page was reloaded.
 *
 * It asks only while there is an answer worth waiting for - a domain not yet probed, or
 * one currently failing, which is exactly when somebody is watching for it to recover -
 * and gives up after a few minutes so an app left open overnight is not polling forever.
 */
function useDomainHealth(
    applicationId: string,
    domains: readonly { id: string; enabled: boolean; healthStatus?: string }[]
): Map<string, DomainHealth> {
    const [health, setHealth] = useState<Map<string, DomainHealth>>(new Map());
    const [rounds, setRounds] = useState(0);
    const settled = domains
        .filter((domain) => domain.enabled)
        .every((domain) => {
            const status = health.get(domain.id)?.healthStatus ?? domain.healthStatus;
            return status === "up" || status === "stopped";
        });

    useEffect(() => {
        if (settled || rounds > 30) return;
        const timer = setTimeout(() => {
            void deployActions
                .domainHealthAction(applicationId)
                .then((rows) => setHealth(new Map(rows.map((row) => [row.id, row]))))
                .catch(() => undefined)
                .finally(() => setRounds((count) => count + 1));
        }, 10_000);
        return () => clearTimeout(timer);
    }, [applicationId, settled, rounds]);

    return health;
}

/**
 * The service's Settings tab: five sections - where it answers, where its code
 * comes from and how it ships, how it scales, the rarer machine-level choices,
 * and removing it - each a stack of cards with a Save of its own, under a
 * navigator that follows the scroll.
 *
 * Each section is drawn only when the reader may use something in it, and a
 * card the reader cannot change is not drawn at all, as before.
 */
export function SettingsTab({
    app,
    isGit,
    staged,
    onChanged
}: {
    app: ProjectApp;
    isGit: boolean;
    staged: boolean;
    onChanged: () => void;
}) {
    const t = useTranslations("deployService");
    const can = useProjectCan();
    const configure = can("service.configure");
    const domains = can("domains.manage");

    const sections: (SettingsSectionLink & { intro: string; shown: boolean })[] = [
        {
            id: `settings-networking-${app.id}`,
            label: t("settings.networking"),
            intro: t("kit.networkingIntro"),
            icon: Network,
            // The private network is shown, read-only, to anybody on the tab.
            shown: true
        },
        {
            id: `settings-source-${app.id}`,
            label: t("kit.source"),
            intro: t("kit.sourceIntro"),
            icon: GitBranch,
            // The deploy behaviour is shown, read-only, to anybody on the tab.
            shown: true
        },
        {
            id: `settings-scaling-${app.id}`,
            label: t("scaling.title"),
            intro: t("kit.scalingIntro"),
            icon: Gauge,
            shown: configure
        },
        {
            id: `settings-advanced-${app.id}`,
            label: t("kit.advanced"),
            intro: t("kit.advancedIntro"),
            icon: SlidersHorizontal,
            shown: configure
        },
        {
            id: `settings-danger-${app.id}`,
            label: t("kit.danger"),
            intro: t("kit.dangerIntro"),
            icon: TriangleAlert,
            danger: true,
            shown: can("service.delete")
        }
    ];
    const shown = sections.filter((section) => section.shown);
    const section = (index: number) => sections[index]!;
    const head = (index: number) => ({
        id: section(index).id,
        icon: section(index).icon,
        title: section(index).label,
        intro: section(index).intro
    });

    return (
        <SettingsLayout sections={shown}>
            <SettingsSection {...head(0)}>
                {domains && <PublicNetworking app={app} onChanged={onChanged} />}
                <PrivateNetworkPanel kind="application" id={app.id} embedded />
                {configure && <ContainerPortCard app={app} onChanged={onChanged} />}
                {(configure || domains) && (
                    <EdgeSettings
                        applicationId={app.id}
                        canEdit={domains}
                        canConfigure={configure}
                        onChanged={onChanged}
                    />
                )}
            </SettingsSection>

            <SettingsSection {...head(1)}>
                {configure && <SourceCards app={app} isGit={isGit} onChanged={onChanged} />}
                {configure && (
                    <UploadedSourceSection applicationId={app.id} onChanged={onChanged} />
                )}
                <DeployBehaviourSection applicationId={app.id} canConfigure={configure} />
            </SettingsSection>

            {section(2).shown && (
                <SettingsSection {...head(2)}>
                    <ScalingSection applicationId={app.id} onChanged={onChanged} />
                </SettingsSection>
            )}

            {section(3).shown && (
                <SettingsSection {...head(3)}>
                    <ServerSection app={app} onChanged={onChanged} />
                    <BuildMachineSection applicationId={app.id} />
                    {can("service.create") && <MoveOutSection app={app} />}
                </SettingsSection>
            )}

            {section(4).shown && (
                <SettingsSection {...head(4)} danger>
                    <DangerSection app={app} staged={staged} onChanged={onChanged} />
                </SettingsSection>
            )}
        </SettingsLayout>
    );
}

/**
 * The port the app listens on inside its container. Empty in the stored config
 * means "detect it from the image"; once one is pinned it can be changed but not
 * cleared from here, so an emptied field is a value to fix rather than a save.
 */
function ContainerPortCard({ app, onChanged }: { app: ProjectApp; onChanged: () => void }) {
    const t = useTranslations("deployService");
    const form = useCardForm({ port: app.port != null ? String(app.port) : "" });
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();
    const typed = form.draft.port.trim();
    const value = publicNet.portValue(typed);
    const invalid = value === null ? t("settings.portInvalid") : null;

    function save() {
        if (value === null) return;
        setError(null);
        startTransition(async () => {
            const result = await deployActions.setAppPortAction(app.id, value);
            if (result.error) {
                setError(result.error);
                return;
            }
            form.commit({ port: String(value) });
            onChanged();
        });
    }

    return (
        <SettingsCard
            title={t("settings.containerPort")}
            description={t("settings.containerPortShort")}
            learnMore={t("settings.containerPortHint")}
            footer={
                <SaveBar
                    dirty={form.dirty()}
                    pending={pending}
                    justSaved={form.justSaved()}
                    invalid={invalid}
                    error={error}
                    onSave={save}
                    onDiscard={() => form.discard()}
                />
            }
        >
            <Input
                value={form.draft.port}
                onChange={(event) => form.patch({ port: event.target.value })}
                placeholder={t("settings.containerPortPlaceholder")}
                inputMode="numeric"
                aria-label={t("settings.containerPort")}
                aria-invalid={form.dirty() && invalid !== null}
                className="w-40"
            />
            {app.ipUrl && (
                <div className="flex min-w-0 items-center gap-1.5 text-xs">
                    <span className="shrink-0 text-foreground-subtle">
                        {t("kit.directAddress")}
                    </span>
                    <a
                        href={app.ipUrl}
                        target="_blank"
                        rel="noreferrer"
                        title={app.ipUrl}
                        className="inline-flex min-w-0 items-center gap-1 truncate font-mono text-primary hover:underline"
                    >
                        <Globe className="size-3 shrink-0" aria-hidden />
                        <span className="truncate">{app.ipUrl.replace(/^https?:\/\//, "")}</span>
                    </a>
                    <CopyButton value={app.ipUrl} className="shrink-0" />
                </div>
            )}
        </SettingsCard>
    );
}

/** What a git service's source and build cards edit, as the panel holds it. */
function sourceFieldsOf(app: ProjectApp) {
    return {
        rootDirectory: app.rootDirectory ?? "",
        dockerfilePath: app.dockerfilePath ?? "",
        installCommand: app.installCommand ?? "",
        buildCommand: app.buildCommand ?? "",
        startCommand: app.startCommand ?? "",
        runtimeVersion: app.runtimeVersion ?? "",
        outputDirectory: app.outputDirectory ?? "",
        autoDeploy: app.autoDeploy,
        branch: app.deployBranch ?? "",
        filter: app.commitFilter ?? "",
        watchPaths: app.watchPaths ?? "",
        keepReleases: app.keepReleases
    };
}

type SourceFields = ReturnType<typeof sourceFieldsOf>;

const SOURCE_KEYS = [
    "rootDirectory",
    "dockerfilePath"
] as const satisfies readonly (keyof SourceFields)[];
const BUILD_KEYS = [
    "installCommand",
    "buildCommand",
    "startCommand",
    "runtimeVersion",
    "outputDirectory"
] as const satisfies readonly (keyof SourceFields)[];
const AUTO_DEPLOY_KEYS = [
    "autoDeploy",
    "branch",
    "filter",
    "watchPaths"
] as const satisfies readonly (keyof SourceFields)[];
const RELEASE_KEYS = ["keepReleases"] as const satisfies readonly (keyof SourceFields)[];

/**
 * Source, build, auto-deploy and releases. Two server writes sit behind four
 * cards (the repository paths and build commands are one, the deploy triggers and
 * releases the other), so each card saves its own fields over what is stored for
 * the rest - a pending edit in the card next to it is neither sent nor lost.
 */
function SourceCards({
    app,
    isGit,
    onChanged
}: {
    app: ProjectApp;
    isGit: boolean;
    onChanged: () => void;
}) {
    const t = useTranslations("deployService");
    const form = useCardForm(sourceFieldsOf(app));
    const [errors, setErrors] = useState<Record<string, string | null>>({});
    const [pendingCard, setPendingCard] = useState<string | null>(null);
    const [, startTransition] = useTransition();
    const draft = form.draft;
    // Checked as it is typed, against the schema the server applies.
    const runtimeVersionProblem = draft.runtimeVersion.trim()
        ? (runtimeVersionSchema.safeParse(draft.runtimeVersion).error?.issues[0]?.message ?? null)
        : null;

    function savePaths(card: string, keys: readonly (keyof SourceFields)[]) {
        if (pendingCard !== null) return;
        const next = form.next(keys);
        setErrors((current) => ({ ...current, [card]: null }));
        setPendingCard(card);
        startTransition(async () => {
            const result = await deployActions.setAppSourcePathsAction({
                applicationId: app.id,
                rootDirectory: next.rootDirectory.trim(),
                dockerfilePath: next.dockerfilePath.trim(),
                installCommand: next.installCommand.trim(),
                buildCommand: next.buildCommand.trim(),
                startCommand: next.startCommand.trim(),
                runtimeVersion: next.runtimeVersion.trim(),
                outputDirectory: next.outputDirectory.trim()
            });
            setPendingCard(null);
            if (result.error) {
                setErrors((current) => ({ ...current, [card]: result.error ?? null }));
                return;
            }
            form.commit(next, card);
            onChanged();
        });
    }

    function saveDeploys(card: string, keys: readonly (keyof SourceFields)[]) {
        if (pendingCard !== null) return;
        const next = form.next(keys);
        setErrors((current) => ({ ...current, [card]: null }));
        setPendingCard(card);
        startTransition(async () => {
            const result = await deployActions.setAutoDeployAction({
                applicationId: app.id,
                autoDeploy: next.autoDeploy,
                deployBranch: next.branch.trim() || undefined,
                commitFilter: next.filter.trim() || undefined,
                watchPaths: next.watchPaths.trim() || undefined,
                keepReleases: next.keepReleases
            });
            setPendingCard(null);
            if (result.error) {
                setErrors((current) => ({ ...current, [card]: result.error ?? null }));
                return;
            }
            form.commit(next, card);
            onChanged();
        });
    }

    const bar = (
        card: string,
        keys: readonly (keyof SourceFields)[],
        onSave: () => void,
        invalid?: string | null
    ) => (
        <SaveBar
            dirty={form.dirty(keys)}
            pending={pendingCard === card}
            busy={pendingCard !== null}
            justSaved={form.justSaved(card)}
            invalid={invalid}
            error={errors[card]}
            onSave={onSave}
            onDiscard={() => form.discard(keys)}
        />
    );
    const plain = { autoCapitalize: "none", autoCorrect: "off", spellCheck: false } as const;

    return (
        <>
            {isGit && (
                <SettingsCard
                    title={t("settings.source")}
                    description={t("settings.sourceShort")}
                    learnMore={t("settings.rootDirectoryHint")}
                    footer={bar("source", SOURCE_KEYS, () => savePaths("source", SOURCE_KEYS))}
                >
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                        <label className="flex min-w-0 flex-col gap-1 text-xs text-muted-foreground">
                            {t("settings.rootDirectory")}
                            <Input
                                value={draft.rootDirectory}
                                onChange={(event) =>
                                    form.patch({ rootDirectory: event.target.value })
                                }
                                placeholder="apps/web"
                                {...plain}
                            />
                        </label>
                        <label className="flex min-w-0 flex-col gap-1 text-xs text-muted-foreground">
                            {t("settings.dockerfilePath")}
                            <Input
                                value={draft.dockerfilePath}
                                onChange={(event) =>
                                    form.patch({ dockerfilePath: event.target.value })
                                }
                                // i18n-ignore: a file name
                                placeholder="Dockerfile"
                                {...plain}
                            />
                            <span className="text-foreground-subtle">
                                {draft.rootDirectory.trim()
                                    ? t("settings.relativeTo", {
                                          directory: draft.rootDirectory.trim()
                                      })
                                    : t("settings.relativeToRoot")}
                            </span>
                        </label>
                    </div>
                </SettingsCard>
            )}

            {app.sourceType === "nixpacks" && (
                <SettingsCard
                    title={t("settings.build")}
                    description={t("settings.buildShort")}
                    learnMore={t("settings.buildIntro")}
                    footer={bar(
                        "build",
                        BUILD_KEYS,
                        () => savePaths("build", BUILD_KEYS),
                        runtimeVersionProblem
                    )}
                >
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                        <label className="flex min-w-0 flex-col gap-1 text-xs text-muted-foreground">
                            {t("settings.installCommand")}
                            <Input
                                value={draft.installCommand}
                                onChange={(event) =>
                                    form.patch({ installCommand: event.target.value })
                                }
                                // i18n-ignore: an example command
                                placeholder="pnpm install --frozen-lockfile"
                                className="font-mono"
                                {...plain}
                            />
                        </label>
                        <label className="flex min-w-0 flex-col gap-1 text-xs text-muted-foreground">
                            {t("settings.buildCommand")}
                            <Input
                                value={draft.buildCommand}
                                onChange={(event) =>
                                    form.patch({ buildCommand: event.target.value })
                                }
                                // i18n-ignore: an example command
                                placeholder="pnpm run build"
                                className="font-mono"
                                {...plain}
                            />
                        </label>
                        <label className="flex min-w-0 flex-col gap-1 text-xs text-muted-foreground">
                            {t("settings.startCommand")}
                            <Input
                                value={draft.startCommand}
                                onChange={(event) =>
                                    form.patch({ startCommand: event.target.value })
                                }
                                // i18n-ignore: an example command
                                placeholder="next start"
                                className="font-mono"
                                {...plain}
                            />
                        </label>
                    </div>
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                        <label className="flex min-w-0 flex-col gap-1 text-xs text-muted-foreground">
                            {t("settings.runtimeVersion")}
                            <Input
                                value={draft.runtimeVersion}
                                onChange={(event) =>
                                    form.patch({ runtimeVersion: event.target.value })
                                }
                                placeholder="22, 3.12, 1.23"
                                aria-invalid={runtimeVersionProblem !== null}
                                {...plain}
                            />
                            <span
                                className={
                                    runtimeVersionProblem
                                        ? "text-danger-ink"
                                        : "text-foreground-subtle"
                                }
                            >
                                {runtimeVersionProblem ?? t("settings.runtimeVersionHint")}
                            </span>
                        </label>
                        <label className="flex min-w-0 flex-col gap-1 text-xs text-muted-foreground">
                            {t("settings.outputDirectory")}
                            <Input
                                value={draft.outputDirectory}
                                onChange={(event) =>
                                    form.patch({ outputDirectory: event.target.value })
                                }
                                placeholder="dist"
                                {...plain}
                            />
                            <span className="text-foreground-subtle">
                                {t("settings.outputDirectoryHint")}
                            </span>
                        </label>
                    </div>
                </SettingsCard>
            )}

            {isGit && (
                <SettingsCard
                    title={t("settings.autoDeploy")}
                    description={t("settings.autoDeployShort")}
                    badge={
                        <Badge variant={form.saved.autoDeploy ? "success" : "neutral"}>
                            {form.saved.autoDeploy ? t("kit.on") : t("kit.off")}
                        </Badge>
                    }
                    actions={
                        <Switch
                            checked={draft.autoDeploy}
                            onChange={(next) => form.patch({ autoDeploy: next })}
                            aria-label={t("settings.deployOnPush")}
                        />
                    }
                    footer={bar("autoDeploy", AUTO_DEPLOY_KEYS, () =>
                        saveDeploys("autoDeploy", AUTO_DEPLOY_KEYS)
                    )}
                >
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                        <label className="flex min-w-0 flex-col gap-1 text-xs text-muted-foreground">
                            {t("settings.branch")}
                            <Input
                                value={draft.branch}
                                onChange={(event) => form.patch({ branch: event.target.value })}
                                placeholder="main"
                                {...plain}
                            />
                        </label>
                        <label className="flex min-w-0 flex-col gap-1 text-xs text-muted-foreground">
                            {t("settings.commitFilter")}
                            <Input
                                value={draft.filter}
                                onChange={(event) => form.patch({ filter: event.target.value })}
                                placeholder="build:"
                                {...plain}
                            />
                        </label>
                    </div>
                    <label className="flex min-w-0 flex-col gap-1 text-xs text-muted-foreground">
                        {t("settings.watchPaths")}
                        <Textarea
                            value={draft.watchPaths}
                            onChange={(event) => form.patch({ watchPaths: event.target.value })}
                            // i18n-ignore: example globs
                            placeholder={"apps/web/**\npackages/ui/**\n!**/*.md"}
                            rows={3}
                            className="font-mono"
                            {...plain}
                        />
                        <span className="text-foreground-subtle">
                            {t("settings.watchPathsShort")}
                        </span>
                    </label>
                </SettingsCard>
            )}

            <SettingsCard
                title={t("settings.keepReleases")}
                description={t("settings.keepReleasesShort")}
                learnMore={t("settings.keepReleasesHint")}
                actions={
                    <Switch
                        checked={draft.keepReleases}
                        onChange={(next) => form.patch({ keepReleases: next })}
                        aria-label={t("settings.keepReleases")}
                    />
                }
                footer={bar("releases", RELEASE_KEYS, () => saveDeploys("releases", RELEASE_KEYS))}
            />
        </>
    );
}

/**
 * Where the service answers on the internet: the addresses it has (its domains,
 * its tunnels and its TCP proxies, each once), and the form that adds another.
 */
function PublicNetworking({ app, onChanged }: { app: ProjectApp; onChanged: () => void }) {
    const t = useTranslations("deployService");
    const can = useProjectCan();
    // Each tunnel's live hostname, by kind. A domain row for the same name - one
    // added by hand before such names were refused - stays listed so it can still
    // be removed, marked as the tunnel's name; the tunnel's row has the true state.
    const [tunnelHosts, setTunnelHosts] = useState<Record<string, string | null>>({});
    const reportHost = (kind: string) => (hostname: string | null) =>
        setTunnelHosts((current) =>
            current[kind] === hostname ? current : { ...current, [kind]: hostname }
        );
    const live = new Set(
        Object.values(tunnelHosts).filter((host): host is string => host !== null)
    );
    const [tcpProxies, setTcpProxies] = useState(0);
    // The project page merges a live tunnel's hostname into the domains, for the
    // canvas and the cards. Here each tunnel has a row of its own with its real
    // state, so drawing the merged entry as well listed the same name twice.
    const own = ownDomains(app.domains);
    const [hostname, setHostname] = useState("");
    const [label, setLabel] = useState("");
    const [connectorToken, setConnectorToken] = useState("");
    const [port, setPort] = useState(app.port != null ? String(app.port) : "");
    const [exposure, setExposure] = useState<ExposureKind>("subdomain");
    // Set as soon as the operator picks a method, so the async zone default below
    // never overrides a deliberate choice.
    const exposureTouched = useRef(false);
    const [cfConnected, setCfConnected] = useState(false);
    const [duckSub, setDuckSub] = useState<string | null>(null);
    const [zones, setZones] = useState<DeployZone[]>([]);
    // Where "Add a domain" goes: the account's own domains, or the organization's
    // when that is the shelf this project is on.
    const [domainsHref, setDomainsHref] = useState("/account/domains");
    // The operator's own domain, offered as the suggested custom hostname so a name
    // straight on it (app.example.com) is as obvious a choice as one in a zone.
    const [baseDomain, setBaseDomain] = useState("");
    const [zoneLabel, setZoneLabel] = useState<string | null>(null);
    const [randomName, setRandomName] = useState(false);
    // The subdomain the zone hostname takes. Empty means "not chosen yet": the server
    // then proposes the service's own name, or a free variant of it, and the field
    // adopts what it answers so what is shown is what will be created.
    const [subdomain, setSubdomain] = useState("");
    const [subdomainCheck, setSubdomainCheck] = useState<ZoneSubdomainCheck | null>(null);
    const [checkingSubdomain, setCheckingSubdomain] = useState(false);
    /** Zone + name the check already answered for, so adopting its answer or
     *  re-rendering does not ask again for a name nothing changed about. */
    const checkedSubdomain = useRef<string | null>(null);
    const [tunnelNonce, setTunnelNonce] = useState(0);
    const [tcpNonce, setTcpNonce] = useState(0);
    const health = useDomainHealth(app.id, own);
    // The ports the service listens on, for the target-port picker, and what each
    // domain's DNS and certificate say - both read once the panel is open.
    const ports = publicNet.useServicePorts(app.id);
    const readings = publicNet.useDomainReadings(
        app.id,
        own.map((domain) => `${domain.id}:${domain.hostname}:${domain.enabled}`).join(",")
    ).readings;
    const addForm = useRef<HTMLDivElement>(null);
    // The picker starts on the port the service's own domains follow, once known.
    useEffect(() => {
        if (ports && port === "") setPort(String(ports.servicePort));
    }, [ports]);
    const [error, setError] = useState<string | null>(null);
    // Kept after a successful add: a custom domain works only once its DNS points here,
    // and whether Polaris managed that itself is the one thing the operator has to know.
    const [dnsNote, setDnsNote] = useState<ReturnType<typeof dnsAdvice>>(null);
    const [pending, startTransition] = useTransition();
    const [rowPending, startRowTransition] = useTransition();
    const [added, markAdded] = useSavedFlash();

    useEffect(() => {
        void deployActions
            .cloudflareAccountStatusAction()
            .then((status) => setCfConnected(status.connected))
            .catch(() => undefined);
        void deployActions
            .duckdnsSubdomainAction()
            .then((result) => setDuckSub(result.subdomain))
            .catch(() => undefined);
        // The zones belong to the Polaris host: their wildcard points here, so an app
        // on a remote server would be offered a hostname that resolves to the wrong
        // machine (and the server would ignore it anyway). Those keep their own
        // server's domain instead.
        if (app.serverId !== "local") return;
        void deployActions
            .deployZonesAction()
            .then(({ baseDomain: base, zones: result, manageHref }) => {
                setZones(result);
                setBaseDomain(base);
                setDomainsHref(manageHref);
                // A configured domain is the best default: it is the only option that
                // yields a stable, public hostname without a third party in the path.
                // The layout's own default zone wins, not merely the first stored one.
                // Only while the operator has not chosen yet, though - this resolves
                // after a round trip, and replacing a choice made in the meantime would
                // add a different kind of domain than the one they pressed for.
                // The base domain is offered but never the default: it is the one
                // entry with no wildcard behind it, so a name taken there resolves
                // nowhere until a record for it exists. Defaulting to a name that
                // may not work is worse than defaulting to the free subdomain,
                // which always does.
                const wildcards = result.filter((zone) => zone.kind !== "base");
                if (wildcards.length > 0 && !exposureTouched.current) {
                    setExposure("zone");
                    setZoneLabel(
                        (wildcards.find((zone) => zone.primary) ?? wildcards[0])?.label ?? ""
                    );
                }
            })
            .catch(() => undefined);
    }, [app.serverId]);

    // Resolve the subdomain field: with nothing typed the server proposes a free name,
    // and with something typed it says whether that one is still free. Debounced only
    // once there is something typed - the first proposal should not make the field
    // sit empty for half a second.
    const zoneKey = zoneLabel ?? zones[0]?.label ?? "";
    useEffect(() => {
        if (exposure !== "zone" || randomName || zones.length === 0) return;
        const typed = subdomain.trim();
        const key = `${zoneKey}|${typed}`;
        if (checkedSubdomain.current === key) return;
        let active = true;
        setCheckingSubdomain(true);
        const timer = setTimeout(
            () => {
                void deployActions
                    .zoneSubdomainAction({
                        applicationId: app.id,
                        zoneLabel: zoneKey,
                        subdomain: typed || undefined
                    })
                    .then((result) => {
                        if (!active) return;
                        checkedSubdomain.current = `${zoneKey}|${result.subdomain}`;
                        setCheckingSubdomain(false);
                        setSubdomainCheck(result);
                        if (!typed && result.subdomain) setSubdomain(result.subdomain);
                    })
                    .catch(() => {
                        if (active) setCheckingSubdomain(false);
                    });
            },
            typed ? 400 : 0
        );
        return () => {
            active = false;
            clearTimeout(timer);
        };
    }, [app.id, exposure, randomName, subdomain, zoneKey, zones.length]);

    // Domain kinds serve on standard 80/443 (the port is a target detail, hidden under
    // Advanced). "local"/"duckdns" ask for just a label; "le"/"proxy"/"cf-named" a full
    // hostname; "subdomain"/tunnels need nothing.
    const isDomainExposure =
        exposure === "zone" ||
        exposure === "subdomain" ||
        exposure === "local" ||
        exposure === "le" ||
        exposure === "duckdns" ||
        exposure === "proxy";
    const usesLabel = exposure === "local" || exposure === "duckdns";
    const needsHostname = exposure === "le" || exposure === "proxy" || exposure === "cf-named";
    const labelSuffix =
        exposure === "local"
            ? ".plr.local"
            : exposure === "duckdns" && duckSub
              ? `.${duckSub}.duckdns.org`
              : "";
    // Suggest a name straight on the operator's own domain, since that is the one
    // people reach for first and the zone picker cannot offer it. Any other domain is
    // just as valid - the field takes whatever is typed.
    const hostnameHint = baseDomain ? `${defaultLabel(app.name)}.${baseDomain}` : "app.example.com";
    const duckMissing = exposure === "duckdns" && !duckSub;
    // A tunnel URL is already exposed by its tunnel; adding it as a domain only makes a
    // duplicate, dead route. Flag it as the user types (the server rejects it too).
    const hostnameIsTunnel =
        (exposure === "le" || exposure === "proxy") && isTunnelHostname(hostname.trim());

    // The target port the route stores: the Advanced override, else the app's known
    // port, else a sensible default. Routing serves on 80/443 regardless.
    function targetPort(): number {
        return (
            publicNet.portValue(port.trim()) ??
            ports?.servicePort ??
            app.port ??
            (app.sourceType === "image" ? 80 : 3000)
        );
    }

    /** Jump to the add form with one method chosen: the three buttons Railway puts
     *  at the top of the panel, here as shortcuts into the one selector. */
    function choose(kind: ExposureKind): void {
        exposureTouched.current = true;
        setExposure(kind);
        setDnsNote(null);
        setError(null);
        addForm.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }

    // One action for every exposure: domains go through deployActions.addDomainAction, the three
    // tunnel kinds through their own start/provision actions. Tunnel results show up
    // in the list above via the row components once the nonce bumps.
    function submitExposure() {
        setError(null);
        setDnsNote(null);
        const labelValue = label.trim() || defaultLabel(app.name);
        startTransition(async () => {
            let result: { error?: string; hostname?: string | null; dns?: AddDomainDns } = {};
            if (exposure === "zone") {
                result = await deployActions.addDomainAction({
                    applicationId: app.id,
                    targetPort: targetPort(),
                    zoneLabel: zoneKey,
                    random: randomName,
                    subdomain: randomName ? undefined : subdomain.trim() || undefined
                });
            } else if (exposure === "subdomain") {
                // Auto = always reachable: a universally-resolvable sslip.io LAN name,
                // plus a free Cloudflare quick tunnel for public access when behind NAT.
                result = await deployActions.autoExposeAction({
                    applicationId: app.id,
                    targetPort: targetPort()
                });
            } else if (exposure === "local") {
                result = await deployActions.addDomainAction({
                    applicationId: app.id,
                    hostname: `${labelValue}.plr.local`,
                    targetPort: targetPort(),
                    cert: "internal"
                });
            } else if (exposure === "duckdns") {
                if (!duckSub) {
                    setError(t("settings.duckdnsFirst"));
                    return;
                }
                result = await deployActions.addDomainAction({
                    applicationId: app.id,
                    hostname: `${labelValue}.${duckSub}.duckdns.org`,
                    targetPort: targetPort(),
                    cert: "le"
                });
            } else if (exposure === "le") {
                result = await deployActions.addDomainAction({
                    applicationId: app.id,
                    hostname: hostname.trim() || undefined,
                    targetPort: targetPort(),
                    cert: "le"
                });
            } else if (exposure === "proxy") {
                result = await deployActions.addDomainAction({
                    applicationId: app.id,
                    hostname: hostname.trim() || undefined,
                    targetPort: targetPort(),
                    cert: "none"
                });
            } else if (exposure === "cf-named") {
                result = cfConnected
                    ? await deployActions.provisionNamedTunnelAction({
                          applicationId: app.id,
                          hostname
                      })
                    : await deployActions.startNamedTunnelAction({
                          applicationId: app.id,
                          token: connectorToken,
                          hostname
                      });
            } else if (exposure === "cf-quick") {
                result = await deployActions.startQuickTunnelAction(app.id);
            } else if (exposure === "ngrok") {
                result = await deployActions.startNgrokTunnelAction(app.id);
            } else if (exposure === "tcp") {
                result = await addTcpProxyAction({ applicationId: app.id, port: targetPort() });
            }
            // A port other than the service's own is pinned on the new address, so
            // the edge dials it there whatever the service's port later becomes.
            if (
                !result.error &&
                isDomainExposure &&
                result.hostname &&
                ports &&
                targetPort() !== ports.servicePort
            ) {
                const pinned = await setDomainPortByHostnameAction({
                    applicationId: app.id,
                    hostname: result.hostname,
                    port: targetPort()
                });
                if (pinned.error) result = { ...result, error: pinned.error };
            }
            if (result.error) setError(result.error);
            else {
                setDnsNote(dnsAdvice(result.dns, result.hostname ?? hostname.trim(), t));
                // Reset the add-a-domain form to a clean state after a successful add.
                setHostname("");
                setLabel("");
                // The name just created is taken now, so the next proposal has to be
                // asked for again rather than kept from before.
                setSubdomain("");
                setSubdomainCheck(null);
                checkedSubdomain.current = null;
                setConnectorToken("");
                setPort(
                    ports ? String(ports.servicePort) : app.port != null ? String(app.port) : ""
                );
                setTunnelNonce((nonce) => nonce + 1);
                if (exposure === "tcp") setTcpNonce((nonce) => nonce + 1);
                markAdded();
                onChanged();
            }
        });
    }

    const submitLabel =
        exposure === "tcp"
            ? t("publicNet.tcpAdd")
            : exposure === "cf-quick" || exposure === "ngrok"
              ? t("settings.expose")
              : exposure === "cf-named"
                ? cfConnected
                    ? t("settings.setUp")
                    : t("settings.connect")
                : t("settings.addDomain");
    // The zone the name goes in, for the suffix beside the field.
    const zone = zones.find((entry) => entry.label === zoneKey) ?? zones[0];
    const zoneHost = zone?.host ?? "";
    // Only a checked answer about the name itself blocks the add: while a check is in
    // flight the operator is still typing, and a zone that cannot mint at all is the
    // add's error to report, not something to blame the typed name for.
    const subdomainTaken =
        exposure === "zone" &&
        !randomName &&
        !checkingSubdomain &&
        !subdomainCheck?.error &&
        subdomainCheck?.available === false;
    const submitBlocked =
        pending ||
        ((isDomainExposure || exposure === "tcp") &&
            publicNet.portValue(port.trim()) === null &&
            port.trim() !== "") ||
        duckMissing ||
        hostnameIsTunnel ||
        subdomainTaken ||
        (needsHostname && !hostname.trim()) ||
        (exposure === "cf-named" && !cfConnected && !connectorToken.trim());
    const revealOnHover =
        "md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100";

    return (
        <>
            <SettingsCard
                title={t("publicNet.title")}
                description={t("publicNet.intro")}
                actions={
                    <>
                        <Button
                            size="sm"
                            variant="outline"
                            onClick={() =>
                                choose(
                                    zones.some((entry) => entry.kind !== "base")
                                        ? "zone"
                                        : "subdomain"
                                )
                            }
                        >
                            <Globe aria-hidden /> {t("publicNet.generate")}
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => choose("le")}>
                            <Plus aria-hidden /> {t("publicNet.custom")}
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => choose("tcp")}>
                            <Network aria-hidden /> {t("publicNet.tcp")}
                        </Button>
                    </>
                }
            >
                <ServedByChoice app={app} onChanged={onChanged} />
                {own.length === 0 && live.size === 0 && tcpProxies === 0 && (
                    <p className="text-xs text-foreground-subtle">{t("deployments.noDomain")}</p>
                )}
                <ul className="-mx-2 flex flex-col">
                    {own.map((rendered) => {
                        const domain = { ...rendered, ...(health.get(rendered.id) ?? {}) };
                        const local =
                            domain.kind === "lan" || domain.hostname.endsWith(".plr.local");
                        const tunneled = live.has(domain.hostname.toLowerCase());
                        return (
                            <Fragment key={domain.id}>
                                <li className="group flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 rounded-md px-2 py-1.5 hover:bg-card-hover">
                                    <span
                                        role="img"
                                        aria-label={domainHealthLabel(domain, t)}
                                        title={domainHealthLabel(domain, t)}
                                        className={cn(
                                            "size-2 shrink-0 rounded-full",
                                            !domain.enabled && "bg-muted-foreground/30",
                                            domain.enabled &&
                                                domain.healthStatus === "up" &&
                                                "bg-success-solid",
                                            domain.enabled &&
                                                domain.healthStatus === "down" &&
                                                "bg-danger-solid",
                                            domain.enabled &&
                                                domain.healthStatus !== "up" &&
                                                domain.healthStatus !== "down" &&
                                                "animate-pulse bg-muted-foreground/40"
                                        )}
                                    />
                                    {domain.enabled ? (
                                        <a
                                            href={`https://${domain.hostname}`}
                                            target="_blank"
                                            rel="noreferrer"
                                            title={domain.hostname}
                                            className="min-w-0 flex-1 basis-40 truncate font-mono text-xs text-foreground hover:text-primary hover:underline"
                                        >
                                            {domain.hostname}
                                        </a>
                                    ) : (
                                        <span
                                            title={`${domain.hostname} - ${t("settings.domainDisabled")}`}
                                            className="min-w-0 flex-1 basis-40 truncate font-mono text-xs text-foreground-subtle line-through"
                                        >
                                            {domain.hostname}
                                        </span>
                                    )}
                                    <div className="ml-auto flex shrink-0 items-center gap-1.5">
                                        <CopyButton
                                            value={domain.hostname}
                                            className={cn("shrink-0 rounded p-1", revealOnHover)}
                                        />
                                        {domain.enabled && domain.healthStatus === "down" && (
                                            <Badge
                                                variant="danger"
                                                className="hidden shrink-0 sm:inline-flex"
                                            >
                                                {t("kit.down")}
                                            </Badge>
                                        )}
                                        {local && (
                                            <Badge variant="neutral" className="shrink-0">
                                                {t("settings.local")}
                                            </Badge>
                                        )}
                                        {tunneled && (
                                            <Badge
                                                variant="warning"
                                                className="shrink-0"
                                                title={t("publicNet.alsoTunnelHint")}
                                            >
                                                {t("publicNet.alsoTunnel")}
                                            </Badge>
                                        )}
                                        {domain.targetPort !== undefined && (
                                            <Badge
                                                variant="neutral"
                                                className="hidden shrink-0 font-mono sm:inline-flex"
                                                title={t("publicNet.dialsPort", {
                                                    port: domain.targetPort
                                                })}
                                            >
                                                :{domain.targetPort}
                                            </Badge>
                                        )}
                                        {domain.targetPort !== undefined && (
                                            <publicNet.EditDomainButton
                                                domain={domain}
                                                applicationId={app.id}
                                                ports={ports}
                                                onChanged={onChanged}
                                            />
                                        )}
                                        <DomainCertificateButton
                                            domainId={domain.id}
                                            hostname={domain.hostname}
                                            supplied={domain.hasCertificate === true}
                                            onChanged={onChanged}
                                        />
                                        {domain.cdn !== undefined && !local && (
                                            <DomainCdnButton
                                                domainId={domain.id}
                                                hostname={domain.hostname}
                                                enabled={domain.cdn}
                                                onChanged={onChanged}
                                            />
                                        )}
                                        <Switch
                                            checked={domain.enabled}
                                            disabled={rowPending}
                                            onChange={(next) =>
                                                startRowTransition(async () => {
                                                    await deployActions.setDomainEnabledAction(
                                                        domain.id,
                                                        next
                                                    );
                                                    onChanged();
                                                })
                                            }
                                            aria-label={
                                                domain.enabled
                                                    ? t("settings.disableDomainNamed", {
                                                          hostname: domain.hostname
                                                      })
                                                    : t("settings.enableDomainNamed", {
                                                          hostname: domain.hostname
                                                      })
                                            }
                                        />
                                        <span className="flex w-6 shrink-0 items-center justify-center">
                                            <RemoveDomainButton
                                                hostname={domain.hostname}
                                                className={revealOnHover}
                                                onRemove={async () => {
                                                    await deployActions.removeDomainAction(
                                                        domain.id
                                                    );
                                                    onChanged();
                                                }}
                                            />
                                        </span>
                                    </div>
                                </li>
                                {domain.enabled && readings.has(domain.id) && (
                                    <li className="empty:hidden px-2 pb-1.5">
                                        <publicNet.DomainReadingView
                                            reading={readings.get(domain.id)}
                                        />
                                    </li>
                                )}
                            </Fragment>
                        );
                    })}
                    <NamedTunnelRow
                        appId={app.id}
                        nonce={tunnelNonce}
                        onHostname={reportHost("named")}
                        onChanged={() => setTunnelNonce((nonce) => nonce + 1)}
                    />
                    <QuickTunnelRow
                        appId={app.id}
                        nonce={tunnelNonce}
                        onHostname={reportHost("quick")}
                        onChanged={() => setTunnelNonce((nonce) => nonce + 1)}
                    />
                    <NgrokTunnelRow
                        appId={app.id}
                        nonce={tunnelNonce}
                        onHostname={reportHost("ngrok")}
                        onChanged={() => setTunnelNonce((nonce) => nonce + 1)}
                    />
                    <publicNet.TcpProxyList
                        applicationId={app.id}
                        nonce={tcpNonce}
                        canEdit={can("domains.manage")}
                        onChanged={onChanged}
                        onCount={setTcpProxies}
                    />
                </ul>
                <publicNet.PrivateNetworkingLink targetId={privateNetworkAnchor(app.id)} />
            </SettingsCard>

            <div ref={addForm} className="scroll-mt-16">
                <SettingsCard
                    title={t("settings.addADomain")}
                    description={t("kit.addADomainShort")}
                    learnMore={t("settings.addADomainIntro")}
                    footer={
                        <>
                            <p className="mr-auto min-w-0 text-xs" role="status" aria-live="polite">
                                {error ? (
                                    <span className="text-danger-ink">{error}</span>
                                ) : added ? (
                                    <span className="inline-flex items-center gap-1 text-success-ink">
                                        <CheckCircle2 className="size-3.5 shrink-0" aria-hidden />{" "}
                                        {t("kit.added")}
                                    </span>
                                ) : null}
                            </p>
                            <Button
                                size="sm"
                                onClick={() => {
                                    if (!submitBlocked) submitExposure();
                                }}
                                aria-disabled={submitBlocked}
                                className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
                            >
                                {pending && <Loader2 className="animate-spin" aria-hidden />}
                                {submitLabel}
                            </Button>
                        </>
                    }
                >
                    <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                        {t("settings.exposure")}
                        <Select
                            value={exposure}
                            onValueChange={(value) => {
                                exposureTouched.current = true;
                                setExposure(value as ExposureKind);
                                setDnsNote(null);
                                setError(null);
                            }}
                            options={EXPOSURE_OPTIONS.filter(
                                (option) => option.value !== "zone" || zones.length > 0
                            ).map((option) => ({ ...option, label: t(option.label) }))}
                            aria-label={t("settings.exposureMethod")}
                        />
                    </label>
                    {exposure === "zone" && zones.length > 0 && (
                        <div className="flex flex-col gap-2">
                            <div className="flex flex-wrap items-center gap-2">
                                <div className="min-w-0 flex-1 basis-52">
                                    <Select
                                        value={(zoneLabel ?? zones[0]?.label) || ZONE_ROOT}
                                        onValueChange={(value) => {
                                            setZoneLabel(value === ZONE_ROOT ? "" : value);
                                            setSubdomainCheck(null);
                                        }}
                                        options={zones.map((entry) => ({
                                            value: entry.label || ZONE_ROOT,
                                            label: zoneOptionLabel(entry, t)
                                        }))}
                                        aria-label={t("settings.zone")}
                                    />
                                </div>
                                <Link
                                    href={domainsHref}
                                    className="inline-flex shrink-0 items-center gap-1 text-xs text-primary hover:underline"
                                >
                                    <Plus className="size-3.5" aria-hidden />
                                    {t("kit.manageDomains")}
                                </Link>
                            </div>
                            {!randomName && (
                                <div className="flex flex-col gap-1">
                                    <div className="flex min-w-0 items-center gap-2">
                                        <Input
                                            value={subdomain}
                                            onChange={(event) => setSubdomain(event.target.value)}
                                            placeholder={defaultLabel(app.name)}
                                            autoComplete="off"
                                            autoCapitalize="none"
                                            autoCorrect="off"
                                            spellCheck={false}
                                            aria-invalid={subdomainTaken}
                                            aria-label={t("settings.subdomain")}
                                            className="min-w-0 flex-1"
                                        />
                                        <span
                                            className="max-w-[45%] shrink-0 truncate font-mono text-xs text-muted-foreground"
                                            title={`.${zoneHost}`}
                                        >
                                            .{zoneHost}
                                        </span>
                                    </div>
                                    {subdomainTaken && (
                                        <p className="text-xs text-danger-ink">
                                            {subdomainCheck?.invalid
                                                ? t("settings.subdomainInvalid")
                                                : t("settings.subdomainTaken")}
                                        </p>
                                    )}
                                </div>
                            )}
                            <label className="flex items-center gap-2 text-xs text-muted-foreground">
                                <Checkbox
                                    checked={randomName}
                                    onChange={(event) => setRandomName(event.target.checked)}
                                />
                                {t("settings.randomName")}
                            </label>
                        </div>
                    )}
                    {usesLabel && !duckMissing && (
                        <div className="flex min-w-0 items-center gap-2">
                            <Input
                                value={label}
                                onChange={(event) => setLabel(event.target.value)}
                                placeholder={defaultLabel(app.name)}
                                autoComplete="off"
                                autoCapitalize="none"
                                autoCorrect="off"
                                spellCheck={false}
                                aria-label={t("settings.subdomain")}
                                className="min-w-0 flex-1"
                            />
                            <span
                                className="max-w-[45%] shrink-0 truncate font-mono text-xs text-muted-foreground"
                                title={labelSuffix}
                            >
                                {labelSuffix}
                            </span>
                        </div>
                    )}
                    {needsHostname && (
                        <Input
                            value={hostname}
                            onChange={(event) => setHostname(event.target.value)}
                            placeholder={hostnameHint}
                            aria-label={t("kit.hostname")}
                            aria-invalid={hostnameIsTunnel}
                            inputMode="url"
                            autoCapitalize="none"
                            autoCorrect="off"
                            spellCheck={false}
                        />
                    )}
                    {hostnameIsTunnel && (
                        <p className="text-xs text-danger-ink">{t("settings.tunnelUrl")}</p>
                    )}
                    {exposure === "cf-named" && !cfConnected && (
                        <Input
                            value={connectorToken}
                            onChange={(event) => setConnectorToken(event.target.value)}
                            placeholder={t("settings.connectorToken")}
                            aria-label={t("settings.connectorToken")}
                            className="font-mono"
                            autoComplete="off"
                            spellCheck={false}
                        />
                    )}
                    <p className="text-xs text-muted-foreground">
                        {exposure === "zone"
                            ? zone?.kind === "base"
                                ? t("exposureHint.zoneBase", { host: zoneHost })
                                : t("exposureHint.zone")
                            : exposure === "subdomain"
                              ? t("exposureHint.subdomain")
                              : exposure === "local"
                                ? t("exposureHint.local", { example: "<name>.plr.local" })
                                : exposure === "le"
                                  ? t("exposureHint.custom", { hostname: hostnameHint })
                                  : exposure === "duckdns"
                                    ? duckMissing
                                        ? t("exposureHint.duckdnsMissing")
                                        : t("exposureHint.duckdns")
                                    : exposure === "proxy"
                                      ? t("exposureHint.proxy")
                                      : exposure === "cf-named"
                                        ? cfConnected
                                            ? t("exposureHint.cfNamedConnected")
                                            : t("exposureHint.cfNamed")
                                        : exposure === "cf-quick"
                                          ? t("exposureHint.cfQuick")
                                          : exposure === "tcp"
                                            ? t("exposureHint.tcp")
                                            : t("exposureHint.ngrok")}
                    </p>
                    {duckMissing && (
                        <Link
                            href="/admin/integrations"
                            className="inline-flex w-fit items-center gap-1 text-xs text-primary hover:underline"
                        >
                            {t("settings.setUpDuckdns")}{" "}
                            <ArrowUpRight className="size-3" aria-hidden />
                        </Link>
                    )}
                    {(isDomainExposure || exposure === "tcp") && (
                        <publicNet.TargetPortField ports={ports} value={port} onChange={setPort} />
                    )}
                    {dnsNote && <p className="text-xs text-muted-foreground">{dnsNote.text}</p>}
                    {dnsNote?.record && (
                        <DnsRecordTable
                            records={[
                                {
                                    type: "A",
                                    name: dnsNote.record.name,
                                    value: dnsNote.record.ip,
                                    status: dnsNote.record.conflict ? "conflict" : "waiting"
                                }
                            ]}
                        />
                    )}
                </SettingsCard>
            </div>
        </>
    );
}

/** What a domain's status dot says, for its tooltip and for a screen reader. */
function domainHealthLabel(
    domain: {
        enabled: boolean;
        healthStatus?: string | null;
        healthCode?: number | null;
        healthDetail?: string | null;
    },
    t: ServiceT
): string {
    if (!domain.enabled) return t("settings.domainDisabled");
    if (domain.healthStatus === "stopped") return t("publicNet.serviceStopped");
    if (domain.healthStatus === "down") {
        return domain.healthDetail
            ? t("settings.notReachableDetail", { detail: domain.healthDetail })
            : t("settings.notReachable");
    }
    if (domain.healthStatus === "up") {
        return domain.healthCode
            ? t("settings.reachableCode", { code: domain.healthCode })
            : t("settings.reachable");
    }
    return t("settings.checking");
}

/**
 * Removing a domain from the service. Named and asked first: the address stops
 * answering at once, and a custom one is not given back by a click on Undo.
 */
function RemoveDomainButton({
    hostname,
    className,
    onRemove
}: {
    hostname: string;
    className?: string;
    onRemove: () => Promise<void>;
}) {
    const t = useTranslations("deployService");
    const [confirm, confirmDialog] = useConfirm();
    const [pending, startTransition] = useTransition();
    return (
        <>
            <button
                type="button"
                aria-label={t("settings.removeDomainNamed", { hostname })}
                title={t("settings.removeDomain")}
                disabled={pending}
                onClick={async () => {
                    const yes = await confirm({
                        title: t("kit.removeDomainTitle", { hostname }),
                        description: t("kit.removeDomainBody"),
                        confirmLabel: t("settings.removeDomain"),
                        danger: true
                    });
                    if (yes) startTransition(onRemove);
                }}
                className={cn(
                    "rounded p-1 text-muted-foreground transition-colors hover:text-danger-ink disabled:opacity-50",
                    className
                )}
            >
                {pending ? (
                    <Loader2 className="size-3.5 animate-spin" aria-hidden />
                ) : (
                    <Trash2 className="size-3.5" aria-hidden />
                )}
            </button>
            {confirmDialog}
        </>
    );
}

/**
 * Who answers this service's addresses.
 *
 * Only ever asked about a service on another machine, because on the box Polaris
 * runs on the two answers are the same edge. There it is the question that decides
 * what happens on a bad night: an address served by the machine the service runs
 * on keeps working while Polaris is off, being updated, or at the wrong end of a
 * home connection that has dropped - and one served by Polaris does not.
 *
 * The default is the server's own edge, and the other option exists for the case
 * that genuinely needs it: a machine that cannot hold a public address of its own,
 * behind a router with nothing forwarded to it. The trade is stated rather than
 * implied, because it is not obvious from the words and it is the entire content
 * of the choice.
 */
function ServedByChoice({ app, onChanged }: { app: ProjectApp; onChanged: () => void }) {
    const t = useTranslations("deployService");
    const can = useProjectCan();
    const [pending, startTransition] = useTransition();
    const [error, setError] = useState<string | null>(null);
    // Set for the whole service, so whatever its first domain says is what it is.
    const own = ownDomains(app.domains);
    const current = own.find((domain) => domain.servedBy)?.servedBy ?? "server";

    if (app.serverId === "local" || !can("domains.manage") || own.length === 0) return null;

    return (
        <div className="flex flex-col gap-1.5">
            <SegmentedControl
                size="sm"
                aria-label={t("servedBy.label")}
                value={current === "polaris" ? "polaris" : "server"}
                options={[
                    { value: "server", label: app.serverName || t("servedBy.ownServer") },
                    { value: "polaris", label: t("servedBy.polaris") }
                ]}
                onValueChange={(next) =>
                    startTransition(async () => {
                        setError(null);
                        const result = await deployActions.setServedByAction(
                            app.id,
                            next === "polaris" ? "polaris" : "server"
                        );
                        if (result.error) setError(result.error);
                        onChanged();
                    })
                }
            />
            <p className="text-xs text-muted-foreground">
                {current === "polaris"
                    ? t("servedBy.polarisHint", {
                          server: app.serverName || t("servedBy.thatServer")
                      })
                    : t("servedBy.serverHint", {
                          server: app.serverName || t("servedBy.thatServer")
                      })}
                {pending ? t("servedBy.saving") : ""}
            </p>
            {error && <p className="text-xs text-danger">{error}</p>}
        </div>
    );
}

/**
 * Sending the service to somebody else's build farm.
 *
 * Here rather than on the Elsewhere board because this is where somebody is
 * standing when they decide it: they are looking at the service that is going to
 * move, not at a list of the ones that already have. The board is where it ends
 * up, and its own rows offer the journey back.
 *
 * Hidden entirely outside a project - the Containers app draws this same panel
 * for something it reached another way, and there is no project for a move to
 * land in.
 */
function MoveOutSection({ app }: { app: ProjectApp }) {
    const params = useParams<{ projectId?: string }>();
    const projectId = params?.projectId ?? "";
    const [moving, setMoving] = useState(false);
    const router = useRouter();
    const t = useTranslations("deployService");
    if (!projectId) return null;

    return (
        <SettingsCard
            title={t("moveOut.heading")}
            description={t("kit.moveOutShort")}
            learnMore={t("moveOut.body")}
            actions={
                <Button size="sm" variant="outline" onClick={() => setMoving(true)}>
                    <ArrowUpRight aria-hidden />
                    {t("moveOut.button")}
                </Button>
            }
        >
            {moving && (
                <MoveOutDialog
                    projectId={projectId}
                    application={{ id: app.id, name: app.name, environmentId: app.environmentId }}
                    onClose={() => setMoving(false)}
                    onMoved={() => router.refresh()}
                />
            )}
        </SettingsCard>
    );
}

/**
 * Removing the service. It is queued rather than done: the changeset banner at
 * the top of the project is what actually carries it out, so there is a step
 * between the click and the container being gone.
 */
function DangerSection({
    app,
    staged,
    onChanged
}: {
    app: ProjectApp;
    staged: boolean;
    onChanged: () => void;
}) {
    const t = useTranslations("deployService");
    const [confirming, setConfirming] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();

    function remove() {
        setError(null);
        startTransition(async () => {
            const result = await stageServiceDeleteAction({ applicationId: app.id });
            if (result.error) {
                setError(result.error);
                return;
            }
            setConfirming(false);
            onChanged();
        });
    }

    return (
        <SettingsCard
            danger
            title={t("danger.deleteService")}
            description={staged ? t("danger.queued") : t("danger.hint")}
            badge={
                staged ? <Badge variant="warning">{t("panel.removalPending")}</Badge> : undefined
            }
            actions={
                <Button
                    variant="danger"
                    size="sm"
                    disabled={staged}
                    onClick={() => setConfirming(true)}
                >
                    <Trash2 aria-hidden /> {t("danger.delete")}
                </Button>
            }
        >
            {error && <p className="text-xs text-danger-ink">{error}</p>}
            <ConfirmDeleteDialog
                open={confirming}
                onOpenChange={setConfirming}
                name={app.name}
                kind="service"
                title={t("danger.deleteTitle")}
                confirmLabel={t("danger.confirm")}
                description={t("danger.description")}
                error={error}
                pending={pending}
                onConfirm={remove}
            />
        </SettingsCard>
    );
}

/** Pick which connected server this service runs on. Changing it tears the
 *  current deployment down on the old server; the service redeploys on the new. */
function ServerSection({ app, onChanged }: { app: ProjectApp; onChanged: () => void }) {
    const t = useTranslations("deployService");
    const [servers, setServers] = useState<{ id: string; name: string }[]>([]);
    const [serverId, setServerId] = useState(app.serverId);
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();

    useEffect(() => {
        void deployActions
            .listDeployServersAction(app.environmentId)
            .then((list) => setServers(list))
            .catch(() => undefined);
    }, [app.environmentId]);

    const changed = serverId !== app.serverId;
    const target = options().find((server) => server.id === serverId)?.name ?? t("server.fallback");

    function options() {
        return servers.length > 0 ? servers : [{ id: app.serverId, name: app.serverName }];
    }

    function move() {
        if (!changed) return;
        setError(null);
        startTransition(async () => {
            const result = await deployActions.setAppServerAction(app.id, serverId);
            if (result.error) setError(result.error);
            else onChanged();
        });
    }

    return (
        <SettingsCard
            title={t("server.label")}
            description={t("kit.serverShort")}
            learnMore={t("server.hint")}
            footer={
                <SaveBar
                    dirty={changed}
                    pending={pending}
                    justSaved={false}
                    error={error}
                    label={changed ? t("server.moveTo", { server: target }) : t("kit.move")}
                    onSave={move}
                    onDiscard={() => setServerId(app.serverId)}
                />
            }
        >
            <Select
                value={serverId}
                onValueChange={setServerId}
                options={options().map((server) => ({ value: server.id, label: server.name }))}
                aria-label={t("server.label")}
            />
        </SettingsCard>
    );
}
