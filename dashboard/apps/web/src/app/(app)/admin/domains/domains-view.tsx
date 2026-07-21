"use client";

/**
 * Domains admin panel. Two domains: the app domain (dashboard) and the sharing
 * domain (share links / drop points - point a throwaway free subdomain here). Plus
 * DuckDNS, whose token is stored encrypted and whose record can be synced to the
 * current public IP on demand. Each section saves independently.
 */

import { useEffect, useState, type ReactNode } from "react";
import { CheckCircle2, Globe, Link2, Loader2, Network, RefreshCw, TriangleAlert } from "lucide-react";
import { Badge, Button, Card, CardBody, CardHeader, CardTitle, Input, Select } from "@polaris/ui";
import type { DomainConfig } from "@/lib/domain-service";
import type { NetworkMode, NetworkStatus } from "@/lib/network-service";
import {
    clearDuckdnsTokenAction,
    networkStatusAction,
    saveDomainsAction,
    saveNetworkConfigAction,
    syncDuckDnsAction
} from "./actions";

export function DomainsView({
    initialConfig,
    effectiveAppUrl
}: {
    initialConfig: DomainConfig;
    effectiveAppUrl: string;
}) {
    const [config, setConfig] = useState(initialConfig);
    const [appDomain, setAppDomain] = useState(initialConfig.appDomain);
    const [sharingDomain, setSharingDomain] = useState(initialConfig.sharingDomain);
    const [duckSub, setDuckSub] = useState(initialConfig.duckdnsSubdomain);
    const [duckToken, setDuckToken] = useState("");
    const [saving, setSaving] = useState(false);
    const [saved, setSaved] = useState(false);
    const [syncing, setSyncing] = useState(false);
    const [syncResult, setSyncResult] = useState<{ ok: boolean; detail: string } | null>(null);

    async function onSave() {
        setSaving(true);
        setSaved(false);
        const result = await saveDomainsAction({
            appDomain,
            sharingDomain,
            duckdnsSubdomain: duckSub,
            duckdnsToken: duckToken || undefined
        });
        setConfig(result.config);
        setDuckToken("");
        setSaving(false);
        setSaved(true);
    }

    async function onSync() {
        setSyncing(true);
        setSyncResult(null);
        setSyncResult(await syncDuckDnsAction());
        setSyncing(false);
    }

    async function onClearToken() {
        const result = await clearDuckdnsTokenAction();
        setConfig(result.config);
    }

    return (
        <div className="flex max-w-2xl flex-col gap-4">
            <NetworkExposure />

            <Card>
                <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                        <Globe className="size-4 text-primary" />
                        Domains
                    </CardTitle>
                </CardHeader>
                <CardBody className="flex flex-col gap-4">
                    <label className="flex flex-col gap-1 text-sm">
                        App domain
                        <Input
                            value={appDomain}
                            onChange={(event) => setAppDomain(event.target.value)}
                            placeholder="polaris.example.com"
                            autoComplete="off"
                        />
                        <span className="text-xs text-muted-foreground">
                            The dashboard&apos;s stable address. Leave empty to use the deployment default (
                            {effectiveAppUrl}).
                        </span>
                    </label>

                    <label className="flex flex-col gap-1 text-sm">
                        <span className="flex items-center gap-1.5">
                            <Link2 className="size-3.5 text-muted-foreground" />
                            Sharing domain
                        </span>
                        <Input
                            value={sharingDomain}
                            onChange={(event) => setSharingDomain(event.target.value)}
                            placeholder="share.example.com"
                            autoComplete="off"
                        />
                        <span className="text-xs text-muted-foreground">
                            Used for the links Polaris hands out (share links and drop points). Point a throwaway free
                            subdomain (e.g. a dokploy / traefik.me one) here for disposable links. Falls back to the app
                            domain.
                        </span>
                    </label>
                </CardBody>
            </Card>

            <Card>
                <CardHeader>
                    <div className="flex items-center justify-between gap-2">
                        <CardTitle className="flex items-center gap-2">
                            DuckDNS
                            {config.hasDuckdnsToken ? <Badge variant="success">Configured</Badge> : null}
                        </CardTitle>
                        <Button size="sm" variant="secondary" onClick={onSync} disabled={syncing || !config.hasDuckdnsToken}>
                            <RefreshCw className={`size-4 ${syncing ? "animate-spin" : ""}`} />
                            {syncing ? "Syncing..." : "Sync IP now"}
                        </Button>
                    </div>
                </CardHeader>
                <CardBody className="flex flex-col gap-4">
                    <p className="text-xs text-muted-foreground">
                        Free dynamic DNS. Polaris keeps your DuckDNS record pointed at this host&apos;s current public IP,
                        auto-synced every few minutes. Use <code>&lt;sub&gt;.duckdns.org</code> as the wildcard base above
                        (DuckDNS resolves <code>*.&lt;sub&gt;.duckdns.org</code> too) for free public subdomains with
                        Let&apos;s Encrypt.
                    </p>
                    <label className="flex flex-col gap-1 text-sm">
                        Subdomain
                        <Input
                            value={duckSub}
                            onChange={(event) => setDuckSub(event.target.value)}
                            placeholder="mypolaris"
                            autoComplete="off"
                        />
                        <span className="text-xs text-muted-foreground">
                            The part before <code>.duckdns.org</code>.
                        </span>
                    </label>
                    <label className="flex flex-col gap-1 text-sm">
                        Token
                        <Input
                            type="password"
                            value={duckToken}
                            onChange={(event) => setDuckToken(event.target.value)}
                            placeholder={config.hasDuckdnsToken ? "Saved - enter a new token to replace it" : "DuckDNS token"}
                            autoComplete="off"
                        />
                    </label>
                    {config.hasDuckdnsToken ? (
                        <button
                            type="button"
                            onClick={onClearToken}
                            className="self-start text-xs text-muted-foreground underline-offset-2 hover:underline"
                        >
                            Remove stored token
                        </button>
                    ) : null}
                    {syncResult ? (
                        <p
                            className={`flex items-center gap-1.5 text-sm ${
                                syncResult.ok ? "text-success" : "text-danger"
                            }`}
                        >
                            {syncResult.ok ? (
                                <CheckCircle2 className="size-4" />
                            ) : (
                                <TriangleAlert className="size-4" />
                            )}
                            {syncResult.ok ? "DuckDNS updated." : syncResult.detail}
                        </p>
                    ) : null}
                </CardBody>
            </Card>

            <div className="flex items-center justify-end gap-3">
                {saved ? <span className="text-sm text-success">Saved.</span> : null}
                <Button onClick={onSave} disabled={saving}>
                    {saving ? "Saving..." : "Save"}
                </Button>
            </div>
        </div>
    );
}

const MODE_OPTIONS = [
    { value: "auto", label: "Automatic (detect)" },
    { value: "lan", label: "LAN only" },
    { value: "public", label: "Public IP (direct)" },
    { value: "wildcard", label: "Custom wildcard domain" },
    { value: "tunnel", label: "Cloudflare / ngrok tunnel" }
];

/**
 * Network topology + exposure control. Shows whether the box is publicly reachable
 * or behind NAT, lets the operator pick how auto domains are exposed, and gives
 * step-by-step setup for the public options so free subdomains that would only
 * work on the LAN are never handed out as if they worked everywhere.
 */
function NetworkExposure() {
    const [status, setStatus] = useState<NetworkStatus | null>(null);
    const [mode, setMode] = useState<NetworkMode>("auto");
    const [wildcard, setWildcard] = useState("");
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState(false);
    const [saved, setSaved] = useState(false);

    useEffect(() => {
        void networkStatusAction().then((next) => {
            setStatus(next);
            setMode(next.mode);
            setWildcard(next.wildcardDomain);
            setLoading(false);
        });
    }, []);

    async function redetect() {
        setBusy(true);
        setStatus(await networkStatusAction(true));
        setBusy(false);
    }

    async function save() {
        setBusy(true);
        setSaved(false);
        setStatus(await saveNetworkConfigAction({ mode, wildcardDomain: wildcard }));
        setBusy(false);
        setSaved(true);
    }

    if (loading || !status) {
        return (
            <Card>
                <CardBody className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="size-4 animate-spin" /> Detecting network...
                </CardBody>
            </Card>
        );
    }

    const effective = status.effectiveMode;
    const publiclyReachable = effective === "public" || effective === "wildcard";

    return (
        <Card>
            <CardHeader>
                <div className="flex items-center justify-between gap-2">
                    <CardTitle className="flex items-center gap-2">
                        <Network className="size-4 text-primary" /> Network &amp; exposure
                    </CardTitle>
                    <Button size="sm" variant="secondary" onClick={redetect} disabled={busy}>
                        <RefreshCw className={`size-4 ${busy ? "animate-spin" : ""}`} /> Re-detect
                    </Button>
                </div>
            </CardHeader>
            <CardBody className="flex flex-col gap-4">
                <div className="grid grid-cols-2 gap-x-6 gap-y-2 rounded-md border border-border/60 p-3 text-xs">
                    <StatusRow
                        label="Hosting"
                        value={status.placement === "cloud" ? "Cloud / data centre" : status.placement === "home" ? "Home / local" : "Unknown"}
                    />
                    <StatusRow label="Public IP" value={status.publicIp ?? "not detected"} />
                    <StatusRow label="Server IP" value={status.subdomainIp ?? "unknown"} />
                    <StatusRow label="Behind NAT" value={status.natted ? "Yes" : "No"} tone={status.natted ? "warn" : "ok"} />
                    <StatusRow label="Active mode" value={effective} tone={publiclyReachable ? "ok" : "warn"} />
                    <StatusRow label="DuckDNS" value={status.duckdns ? "Configured" : "Not set"} tone={status.duckdns ? "ok" : undefined} />
                </div>

                {status.natted && status.mode === "auto" && (
                    <p className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning/5 px-3 py-2 text-xs text-muted-foreground">
                        <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-warning" />
                        This looks like a server behind NAT: free subdomains point at the LAN IP ({status.subdomainIp}) and
                        only work on your network. For public access, choose a wildcard domain or a tunnel below.
                    </p>
                )}

                {status.placement === "home" && !status.duckdns && status.effectiveMode !== "wildcard" && (
                    <p className="flex items-start gap-2 rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-xs text-muted-foreground">
                        <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-primary" />
                        Recommended for a home/local server: set up <b>DuckDNS</b> below (free) and use{" "}
                        <code>&lt;sub&gt;.duckdns.org</code> as the wildcard base - Polaris then serves public subdomains
                        with Let&apos;s Encrypt and keeps the IP updated automatically.
                    </p>
                )}

                <label className="flex flex-col gap-1 text-sm">
                    Exposure mode
                    <Select value={mode} onValueChange={(value) => setMode(value as NetworkMode)} options={MODE_OPTIONS} />
                </label>

                {mode === "wildcard" && (
                    <label className="flex flex-col gap-1 text-sm">
                        Wildcard base domain
                        <Input
                            value={wildcard}
                            onChange={(event) => setWildcard(event.target.value)}
                            placeholder="apps.example.com"
                            autoComplete="off"
                        />
                    </label>
                )}

                <ExposureGuidance status={status} mode={mode} wildcard={wildcard} />

                <div className="flex items-center justify-end gap-3">
                    {saved && <span className="text-sm text-success">Saved.</span>}
                    <Button onClick={save} disabled={busy}>
                        {busy ? "Saving..." : "Save exposure"}
                    </Button>
                </div>
            </CardBody>
        </Card>
    );
}

function StatusRow({ label, value, tone }: { label: string; value: string; tone?: "ok" | "warn" }) {
    const color = tone === "ok" ? "text-success" : tone === "warn" ? "text-warning" : "text-foreground";
    return (
        <div className="flex items-center justify-between gap-2">
            <span className="text-muted-foreground">{label}</span>
            <span className={`font-mono ${color}`}>{value}</span>
        </div>
    );
}

function ExposureGuidance({ status, mode, wildcard }: { status: NetworkStatus; mode: NetworkMode; wildcard: string }) {
    const effective = mode === "auto" ? status.effectiveMode : mode;
    const base = wildcard.trim() || "apps.example.com";

    if (effective === "public") {
        return (
            <GuidanceNote ok>
                Your box is internet-reachable at {status.publicIp ?? status.subdomainIp}. Free subdomains get a real
                Let&apos;s Encrypt certificate and work from anywhere.
            </GuidanceNote>
        );
    }
    if (effective === "wildcard") {
        return (
            <GuidanceNote>
                <b>Point a wildcard at your server, then Polaris manages every subdomain:</b>
                <ol className="mt-1 list-decimal space-y-1 pl-4">
                    <li>
                        Create a DNS record <code>*.{base}</code> of type A pointing at your public IP
                        {status.publicIp ? ` (${status.publicIp})` : ""}.
                    </li>
                    <li>
                        Forward ports <code>80</code> and <code>443</code> on your router to this server
                        {status.subdomainIp ? ` (${status.subdomainIp})` : ""}.
                    </li>
                    <li>
                        Save. New services get <code>&lt;app&gt;.{base}</code> with an automatic Let&apos;s Encrypt
                        certificate.
                    </li>
                </ol>
                <p className="mt-2">
                    No domain? Use a free <b>DuckDNS</b> subdomain (<code>&lt;sub&gt;.duckdns.org</code>) as the base -
                    Polaris keeps its IP updated automatically. Set the token in the DuckDNS card below.
                </p>
            </GuidanceNote>
        );
    }
    if (effective === "tunnel") {
        return (
            <GuidanceNote>
                Public access runs through a Cloudflare/ngrok tunnel - no open ports or public IP needed. Set one up in{" "}
                <a className="text-primary hover:underline" href="/integrations">
                    Integrations
                </a>
                , or use the per-service <b>Public tunnel</b> button. Auto subdomains stay LAN-only.
            </GuidanceNote>
        );
    }
    return (
        <GuidanceNote>
            Free subdomains resolve to your LAN IP ({status.subdomainIp ?? "unknown"}) and work only on your local
            network, served with the internal CA (a one-time browser warning). Pick a wildcard domain or a tunnel to
            expose services publicly.
        </GuidanceNote>
    );
}

function GuidanceNote({ children, ok }: { children: ReactNode; ok?: boolean }) {
    return (
        <div
            className={`rounded-md border px-3 py-2 text-xs text-muted-foreground ${
                ok ? "border-success/30 bg-success/5" : "border-border/60 bg-surface/40"
            }`}
        >
            {children}
        </div>
    );
}
