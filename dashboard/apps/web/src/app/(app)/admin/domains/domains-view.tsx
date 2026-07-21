"use client";

/**
 * Domains admin panel. Two domains: the app domain (dashboard) and the sharing
 * domain (share links / drop points - point a throwaway free subdomain here). Plus
 * DuckDNS, whose token is stored encrypted and whose record can be synced to the
 * current public IP on demand. Each section saves independently.
 */

import { useState } from "react";
import { CheckCircle2, Cloud, Globe, Link2, RefreshCw, TriangleAlert } from "lucide-react";
import { Badge, Button, Card, CardBody, CardHeader, CardTitle, Input, Select } from "@polaris/ui";
import type { DomainConfig } from "@/lib/domain-service";
import type { TunnelProvider, TunnelStatus } from "@/lib/tunnel-service";
import { clearDuckdnsTokenAction, saveDomainsAction, saveTunnelAction, syncDuckDnsAction } from "./actions";

export function DomainsView({
    initialConfig,
    effectiveAppUrl,
    initialTunnel
}: {
    initialConfig: DomainConfig;
    effectiveAppUrl: string;
    initialTunnel: TunnelStatus;
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
    const [tunnel, setTunnel] = useState(initialTunnel);
    const [tunnelProvider, setTunnelProvider] = useState<TunnelProvider>(initialTunnel.provider);
    const [tunnelToken, setTunnelToken] = useState("");
    const [tunnelSaving, setTunnelSaving] = useState(false);
    const [tunnelError, setTunnelError] = useState<string | null>(null);

    async function onSaveTunnel() {
        setTunnelSaving(true);
        setTunnelError(null);
        const result = await saveTunnelAction({ provider: tunnelProvider, token: tunnelToken || undefined });
        setTunnel(result.status);
        setTunnelToken("");
        setTunnelError(result.error ?? null);
        setTunnelSaving(false);
    }

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
                        Free dynamic DNS. Polaris points your DuckDNS record at this host&apos;s current public IP.
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

            <Card>
                <CardHeader>
                    <div className="flex items-center justify-between gap-2">
                        <CardTitle className="flex items-center gap-2">
                            <Cloud className="size-4 text-primary" />
                            Tunnel
                            {tunnel.running ? (
                                <Badge variant="success">Running</Badge>
                            ) : tunnel.provider !== "none" ? (
                                <Badge variant="warning">Configured</Badge>
                            ) : null}
                        </CardTitle>
                    </div>
                </CardHeader>
                <CardBody className="flex flex-col gap-4">
                    <p className="text-xs text-muted-foreground">
                        Expose deployed apps publicly with no port-forwarding: the tunnel connects out to Cloudflare or
                        ngrok and forwards traffic to this host, which routes each domain to its app. Point the
                        provider&apos;s hostname at <code>http://&lt;this-host-ip&gt;:80</code>.
                    </p>
                    <label className="flex flex-col gap-1 text-sm">
                        Provider
                        <Select
                            value={tunnelProvider}
                            onValueChange={(value) => setTunnelProvider(value as TunnelProvider)}
                            options={[
                                { value: "none", label: "None (local / port-forward)" },
                                { value: "cloudflare", label: "Cloudflare Tunnel" },
                                { value: "ngrok", label: "ngrok" }
                            ]}
                        />
                    </label>
                    {tunnelProvider !== "none" ? (
                        <label className="flex flex-col gap-1 text-sm">
                            {tunnelProvider === "cloudflare" ? "Tunnel token" : "Authtoken"}
                            <Input
                                type="password"
                                value={tunnelToken}
                                onChange={(event) => setTunnelToken(event.target.value)}
                                placeholder={tunnel.hasToken ? "Saved - enter a new token to replace it" : "Paste the token"}
                                autoComplete="off"
                            />
                            <span className="text-xs text-muted-foreground">
                                {tunnelProvider === "cloudflare"
                                    ? "Create a tunnel in the Cloudflare dashboard, add a public hostname pointing to http://<this-host-ip>:80, and paste its token here."
                                    : "Your ngrok authtoken. ngrok forwards to this host; a reserved domain is recommended for stable URLs."}
                            </span>
                        </label>
                    ) : null}
                    {tunnelError ? (
                        <p className="flex items-center gap-1.5 text-sm text-danger">
                            <TriangleAlert className="size-4" />
                            {tunnelError}
                        </p>
                    ) : null}
                    <div className="flex justify-end">
                        <Button size="sm" onClick={onSaveTunnel} disabled={tunnelSaving}>
                            {tunnelSaving ? "Applying..." : "Apply tunnel"}
                        </Button>
                    </div>
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
