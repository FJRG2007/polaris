"use client";

/**
 * The integrations marketplace grid and the per-integration configure dialog.
 * Only VirusTotal exists today, so the dialog renders its scan settings directly;
 * a second integration would branch on the slug. Toggling and saving go through
 * the admin-gated server actions.
 */

import { useState, useTransition } from "react";
import { CheckCircle2, ExternalLink, Loader2, RefreshCw, ShieldCheck } from "lucide-react";
import {
    Badge,
    Button,
    Card,
    CardBody,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    Input,
    Select,
    Switch,
    cn
} from "@polaris/ui";
import { DYMO_IP_RULES, SCAN_ACTIONS, type ScanAction } from "@/lib/integrations/registry";
import { IntegrationLogo } from "@/components/logos";
import {
    connectCloudflareAccountAction,
    connectGithubAction,
    connectGithubAppAction,
    disconnectCloudflareAccountAction,
    disconnectGithubAction,
    refreshGithubInstallationsAction,
    saveDuckdnsAction,
    saveDymoAction,
    saveTunnelAction,
    saveVirusTotalAction,
    syncDuckdnsAction,
    testDymoKeyAction,
    testVirusTotalKeyAction
} from "./actions";

export interface IntegrationCard {
    slug: string;
    name: string;
    category: string;
    summary: string;
    description: string;
    docsUrl: string;
    requiresApiKey: boolean;
    apiKeyLabel?: string;
    apiKeyHelp?: string;
    enabled: boolean;
    hasSecret: boolean;
    scanDropPoints: boolean;
    onDetection: ScanAction;
    /** Dymo: verify visitor IPs on share/drop-point access. */
    verifyAccessIp: boolean;
    /** Dymo: IP deny rules (FRAUD, PROXY, ...). */
    deny: string[];
    /** DuckDNS: the configured subdomain (empty when not set). */
    duckdnsSubdomain?: string;
    /** Cloudflare: whether an API token is connected (for automated named tunnels). */
    cloudflareApiConnected?: boolean;
    /** Cloudflare: the connected account name, when an API token is set. */
    cloudflareAccountName?: string;
    /** GitHub: how it is connected, when connected. */
    githubMethod?: "pat" | "app" | null;
    /** GitHub: the connected account login (PAT) or app name (App). */
    githubLogin?: string;
    /** GitHub App: accounts/orgs the app is installed on. */
    githubInstallations?: string[];
    /** GitHub App: the app's GitHub page, for the Install button. */
    githubHtmlUrl?: string;
}

export function IntegrationsView({ cards }: { cards: IntegrationCard[] }) {
    const [configuring, setConfiguring] = useState<IntegrationCard | null>(null);

    return (
        <>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {cards.map((card) => (
                    <Card key={card.slug}>
                        <CardBody className="flex flex-col gap-3">
                            <div className="flex items-start gap-3">
                                <div className="grid size-10 shrink-0 place-items-center rounded-md border border-border bg-surface">
                                    <IntegrationLogo slug={card.slug} className="size-6" />
                                </div>
                                <div className="min-w-0 flex-1">
                                    <div className="flex items-center gap-2">
                                        <h2 className="truncate text-sm font-medium">{card.name}</h2>
                                        <Badge variant="neutral">{card.category}</Badge>
                                    </div>
                                    <p className="mt-0.5 text-xs text-muted-foreground">{card.summary}</p>
                                </div>
                                {card.enabled ? (
                                    <Badge variant="success">On</Badge>
                                ) : card.hasSecret ? (
                                    <Badge variant="neutral">Off</Badge>
                                ) : null}
                            </div>
                            <div className="flex items-center justify-end gap-2">
                                <a
                                    href={card.docsUrl}
                                    target="_blank"
                                    rel="noreferrer noopener"
                                    className="mr-auto inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                                >
                                    Docs
                                    <ExternalLink className="size-3" />
                                </a>
                                <Button size="sm" variant="secondary" onClick={() => setConfiguring(card)}>
                                    {card.hasSecret ? "Configure" : "Set up"}
                                </Button>
                            </div>
                        </CardBody>
                    </Card>
                ))}
            </div>

            {configuring?.slug === "virustotal" ? (
                <VirusTotalDialog card={configuring} onClose={() => setConfiguring(null)} />
            ) : configuring?.slug === "dymo" ? (
                <DymoDialog card={configuring} onClose={() => setConfiguring(null)} />
            ) : configuring?.slug === "github" ? (
                <GitHubDialog card={configuring} onClose={() => setConfiguring(null)} />
            ) : configuring?.slug === "cloudflare" || configuring?.slug === "ngrok" ? (
                <TunnelDialog card={configuring} onClose={() => setConfiguring(null)} />
            ) : configuring?.slug === "duckdns" ? (
                <DuckDnsDialog card={configuring} onClose={() => setConfiguring(null)} />
            ) : null}
        </>
    );
}

function TunnelDialog({ card, onClose }: { card: IntegrationCard; onClose: () => void }) {
    const provider = card.slug as "cloudflare" | "ngrok";
    const [enabled, setEnabled] = useState(card.enabled);
    const [token, setToken] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();

    function onSave() {
        setError(null);
        startTransition(async () => {
            const result = await saveTunnelAction({ provider, enabled, token: token || undefined });
            if (result.error) setError(result.error);
            else onClose();
        });
    }

    return (
        <Dialog open onOpenChange={(open) => !open && onClose()}>
            <DialogContent className="max-w-md">
                <DialogHeader>
                    <DialogTitle className="flex items-center gap-2">
                        <IntegrationLogo slug={card.slug} className="size-5" />
                        {card.name}
                    </DialogTitle>
                    <DialogDescription>{card.description}</DialogDescription>
                </DialogHeader>
                <div className="flex flex-col gap-4">
                    <div className="flex items-center justify-between gap-3 rounded-md border border-border p-3 text-sm">
                        <span>Enabled</span>
                        <Switch checked={enabled} onChange={setEnabled} aria-label="Enabled" />
                    </div>
                    <label className="flex flex-col gap-1 text-sm">
                        {card.apiKeyLabel ?? "Token"}
                        <Input
                            type="password"
                            value={token}
                            onChange={(event) => setToken(event.target.value)}
                            placeholder={card.hasSecret ? "Saved - enter a new token to replace it" : "Paste the token"}
                            autoComplete="off"
                        />
                        {card.apiKeyHelp ? <span className="text-xs text-muted-foreground">{card.apiKeyHelp}</span> : null}
                    </label>
                    {error ? <p className="text-sm text-danger">{error}</p> : null}
                    <div className="flex justify-end gap-2">
                        <Button variant="ghost" onClick={onClose}>
                            Cancel
                        </Button>
                        <Button onClick={onSave} disabled={pending}>
                            {pending ? "Applying..." : "Save"}
                        </Button>
                    </div>

                    {provider === "cloudflare" ? <CloudflareApiTokenSection card={card} /> : null}
                </div>
            </DialogContent>
        </Dialog>
    );
}

/**
 * Connect a Cloudflare API token so per-app named tunnels can be provisioned
 * automatically (Polaris creates the tunnel + DNS; the operator only picks a
 * hostname). Separate from the connector token above, which runs a server-wide
 * tunnel and grants no API access. Handles the multi-account case by prompting
 * for which account the token should act on.
 */
function CloudflareApiTokenSection({ card }: { card: IntegrationCard }) {
    const [connected, setConnected] = useState(card.cloudflareApiConnected ?? false);
    const [accountName, setAccountName] = useState(card.cloudflareAccountName ?? "");
    const [token, setToken] = useState("");
    const [accounts, setAccounts] = useState<{ id: string; name: string }[]>([]);
    const [accountId, setAccountId] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();

    function onConnect(chosen?: string) {
        setError(null);
        startTransition(async () => {
            const result = await connectCloudflareAccountAction({ token, accountId: chosen });
            if (result.error) {
                setError(result.error);
                return;
            }
            if (result.connected) {
                setConnected(true);
                setAccountName(result.accountName ?? "");
                setAccounts([]);
                setToken("");
                return;
            }
            // Several accounts reachable - let the operator pick one, then reconnect.
            const options = result.accounts ?? [];
            setAccounts(options);
            if (options[0]) setAccountId(options[0].id);
        });
    }

    function onDisconnect() {
        setError(null);
        startTransition(async () => {
            const result = await disconnectCloudflareAccountAction();
            if (result.error) setError(result.error);
            else {
                setConnected(false);
                setAccountName("");
            }
        });
    }

    return (
        <div className="flex flex-col gap-3 border-t border-border pt-4">
            <div className="flex flex-col gap-0.5">
                <span className="text-sm font-medium">Automatic tunnels (API token)</span>
                <span className="text-xs text-muted-foreground">
                    Connect an API token and Polaris sets up each app's tunnel and DNS for you - you only pick a
                    hostname. Scopes: Account - Cloudflare Tunnel: Edit, Zone - DNS: Edit, Zone: Read.
                </span>
            </div>

            {connected ? (
                <div className="flex items-center justify-between gap-3 rounded-md border border-border bg-surface/40 p-2.5 text-sm">
                    <span className="flex items-center gap-1.5">
                        <CheckCircle2 className="size-4 text-success" />
                        Connected{accountName ? ` as ${accountName}` : ""}
                    </span>
                    <Button type="button" variant="ghost" size="sm" onClick={onDisconnect} disabled={pending}>
                        {pending ? <Loader2 className="size-4 animate-spin" /> : "Disconnect"}
                    </Button>
                </div>
            ) : (
                <div className="flex flex-col gap-2">
                    <Input
                        type="password"
                        autoComplete="off"
                        value={token}
                        onChange={(event) => setToken(event.target.value)}
                        placeholder="Paste a Cloudflare API token"
                    />
                    {accounts.length > 0 ? (
                        <div className="flex flex-col gap-1 text-xs text-muted-foreground">
                            Account
                            <Select
                                value={accountId}
                                onValueChange={setAccountId}
                                options={accounts.map((account) => ({ value: account.id, label: account.name }))}
                            />
                        </div>
                    ) : null}
                    <div className="flex items-center justify-between gap-2">
                        <a
                            href="https://dash.cloudflare.com/profile/api-tokens"
                            target="_blank"
                            rel="noreferrer noopener"
                            className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                        >
                            Create a token <ExternalLink className="size-3" />
                        </a>
                        <Button
                            type="button"
                            size="sm"
                            onClick={() => onConnect(accounts.length > 0 ? accountId : undefined)}
                            disabled={pending || !token.trim() || (accounts.length > 0 && !accountId)}
                        >
                            {pending ? <Loader2 className="size-4 animate-spin" /> : accounts.length > 0 ? "Confirm account" : "Connect"}
                        </Button>
                    </div>
                </div>
            )}

            {error ? <p className="text-sm text-danger">{error}</p> : null}
        </div>
    );
}

function DuckDnsDialog({ card, onClose }: { card: IntegrationCard; onClose: () => void }) {
    const [subdomain, setSubdomain] = useState(card.duckdnsSubdomain ?? "");
    const [token, setToken] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [synced, setSynced] = useState<string | null>(null);
    const [saving, startSave] = useTransition();
    const [syncing, startSync] = useTransition();

    function onSave() {
        setError(null);
        setSynced(null);
        startSave(async () => {
            const result = await saveDuckdnsAction({ subdomain, token: token || undefined });
            if (result.error) setError(result.error);
            else onClose();
        });
    }

    function onSync() {
        setError(null);
        setSynced(null);
        startSync(async () => {
            const result = await syncDuckdnsAction();
            if (result.ok) setSynced(result.detail);
            else setError(result.detail);
        });
    }

    return (
        <Dialog open onOpenChange={(open) => !open && onClose()}>
            <DialogContent className="max-w-md">
                <DialogHeader>
                    <DialogTitle className="flex items-center gap-2">
                        <IntegrationLogo slug="duckdns" className="size-5" />
                        DuckDNS
                    </DialogTitle>
                    <DialogDescription>{card.description}</DialogDescription>
                </DialogHeader>

                <div className="flex flex-col gap-4">
                    <label className="flex flex-col gap-1 text-sm">
                        <span className="font-medium">Subdomain</span>
                        <div className="flex items-center gap-2">
                            <Input
                                value={subdomain}
                                onChange={(event) => setSubdomain(event.target.value)}
                                placeholder="myhome"
                                autoComplete="off"
                            />
                            <span className="shrink-0 text-sm text-muted-foreground">.duckdns.org</span>
                        </div>
                    </label>

                    <label className="flex flex-col gap-1 text-sm">
                        <span className="font-medium">{card.apiKeyLabel ?? "Token"}</span>
                        <Input
                            type="password"
                            autoComplete="off"
                            value={token}
                            onChange={(event) => setToken(event.target.value)}
                            placeholder={card.hasSecret ? "Saved - enter a new token to replace it" : "Paste your DuckDNS token"}
                        />
                        {card.apiKeyHelp ? <span className="text-xs text-muted-foreground">{card.apiKeyHelp}</span> : null}
                    </label>

                    {card.hasSecret ? (
                        <div className="flex items-center justify-between gap-3 rounded-md border border-border p-2.5 text-sm">
                            <span className="text-muted-foreground">
                                Point the record at this server's current public IP now.
                            </span>
                            <Button type="button" variant="ghost" size="sm" onClick={onSync} disabled={syncing}>
                                {syncing ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
                                Sync now
                            </Button>
                        </div>
                    ) : null}

                    {synced ? (
                        <span className="flex items-center gap-1 text-xs text-success">
                            <CheckCircle2 className="size-3" />
                            {synced}
                        </span>
                    ) : null}
                    {error ? <p className="text-sm text-danger">{error}</p> : null}

                    <div className="flex justify-end gap-2">
                        <Button type="button" variant="ghost" onClick={onClose}>
                            Cancel
                        </Button>
                        <Button type="button" onClick={onSave} disabled={saving}>
                            {saving ? <Loader2 className="size-4 animate-spin" /> : "Save"}
                        </Button>
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    );
}

function DymoDialog({ card, onClose }: { card: IntegrationCard; onClose: () => void }) {
    const [enabled, setEnabled] = useState(card.enabled);
    const [verifyAccessIp, setVerifyAccessIp] = useState(card.verifyAccessIp);
    const [deny, setDeny] = useState<Set<string>>(new Set(card.deny));
    const [apiKey, setApiKey] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [tested, setTested] = useState<string | null>(null);
    const [testing, startTest] = useTransition();
    const [saving, startSave] = useTransition();

    function toggleRule(value: string) {
        setDeny((prev) => {
            const next = new Set(prev);
            if (next.has(value)) next.delete(value);
            else next.add(value);
            return next;
        });
    }

    function onTest() {
        setError(null);
        setTested(null);
        startTest(async () => {
            const result = await testDymoKeyAction(apiKey);
            if (result.ok) setTested("The key works.");
            else setError(result.error ?? "The key was rejected");
        });
    }

    function onSave() {
        setError(null);
        startSave(async () => {
            const result = await saveDymoAction({ enabled, verifyAccessIp, deny: [...deny], apiKey });
            if (result.error) setError(result.error);
            else onClose();
        });
    }

    return (
        <Dialog open onOpenChange={(open) => !open && onClose()}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle className="flex items-center gap-2">
                        <IntegrationLogo slug="dymo" className="size-5" />
                        Dymo API
                    </DialogTitle>
                    <DialogDescription>{card.description}</DialogDescription>
                </DialogHeader>

                <div className="flex flex-col gap-4">
                    <label className="flex flex-col gap-1 text-sm">
                        <span className="font-medium">{card.apiKeyLabel ?? "API key"}</span>
                        <div className="flex gap-2">
                            <Input
                                type="password"
                                autoComplete="off"
                                value={apiKey}
                                onChange={(event) => setApiKey(event.target.value)}
                                placeholder={card.hasSecret ? "Saved - enter a new key to replace it" : "Paste your key"}
                            />
                            <Button type="button" variant="ghost" onClick={onTest} disabled={testing || !apiKey.trim()}>
                                {testing ? <Loader2 className="size-4 animate-spin" /> : "Test"}
                            </Button>
                        </div>
                        {card.apiKeyHelp ? <span className="text-xs text-muted-foreground">{card.apiKeyHelp}</span> : null}
                        {tested ? (
                            <span className="flex items-center gap-1 text-xs text-success">
                                <CheckCircle2 className="size-3" />
                                {tested}
                            </span>
                        ) : null}
                    </label>

                    <div className="flex items-start justify-between gap-3 text-sm">
                        <span>
                            <span className="font-medium">Verify visitor IPs on access</span>
                            <span className="block text-xs text-muted-foreground">
                                Check the IP when someone opens a share link or drop point, and block the ones that
                                match your rules.
                            </span>
                        </span>
                        <Switch
                            checked={verifyAccessIp}
                            onChange={setVerifyAccessIp}
                            aria-label="Verify visitor IPs on access"
                        />
                    </div>

                    <div className="flex flex-col gap-1.5">
                        <span className="text-sm font-medium">Block IPs that are</span>
                        <div className="flex flex-wrap gap-1.5">
                            {DYMO_IP_RULES.map((rule) => (
                                <button
                                    key={rule.value}
                                    type="button"
                                    onClick={() => toggleRule(rule.value)}
                                    className={cn(
                                        "rounded-full border px-3 py-1 text-xs transition-colors",
                                        deny.has(rule.value)
                                            ? "border-primary bg-primary/10 text-primary"
                                            : "border-border text-muted-foreground hover:bg-muted"
                                    )}
                                >
                                    {rule.label}
                                    {rule.premium ? " (premium)" : ""}
                                </button>
                            ))}
                        </div>
                    </div>

                    <div className="flex items-center justify-between gap-3 rounded-md border border-border p-2.5 text-sm">
                        <span className="flex items-center gap-1.5 font-medium">
                            <ShieldCheck className="size-4 text-primary" />
                            Enable Dymo API
                        </span>
                        <Switch checked={enabled} onChange={setEnabled} aria-label="Enable Dymo API" />
                    </div>

                    {error ? <p className="text-sm text-danger">{error}</p> : null}

                    <div className="flex justify-end gap-2">
                        <Button type="button" variant="ghost" onClick={onClose}>
                            Cancel
                        </Button>
                        <Button type="button" onClick={onSave} disabled={saving}>
                            {saving ? <Loader2 className="size-4 animate-spin" /> : "Save"}
                        </Button>
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    );
}

function GitHubDialog({ card, onClose }: { card: IntegrationCard; onClose: () => void }) {
    const connected = Boolean(card.githubLogin);
    if (connected) return <GitHubConnected card={card} onClose={onClose} />;
    return <GitHubConnect card={card} onClose={onClose} />;
}

/** Connected state: show the account/app, installations, and disconnect. */
function GitHubConnected({ card, onClose }: { card: IntegrationCard; onClose: () => void }) {
    const [error, setError] = useState<string | null>(null);
    const [busy, startBusy] = useTransition();
    const isApp = card.githubMethod === "app";

    return (
        <Dialog open onOpenChange={(open) => !open && onClose()}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle className="flex items-center gap-2">
                        <IntegrationLogo slug="github" className="size-5" />
                        GitHub
                    </DialogTitle>
                    <DialogDescription>{card.description}</DialogDescription>
                </DialogHeader>

                <div className="flex flex-col gap-4">
                    <div className="flex items-center gap-2 rounded-md border border-border bg-surface/40 p-3 text-sm">
                        <CheckCircle2 className="size-4 text-success" />
                        Connected via {isApp ? "GitHub App" : "token"} as{" "}
                        <span className="font-medium">{card.githubLogin}</span>
                    </div>

                    {isApp ? (
                        <div className="flex flex-col gap-2 text-sm">
                            <span className="font-medium">Installations</span>
                            {card.githubInstallations && card.githubInstallations.length > 0 ? (
                                <div className="flex flex-wrap gap-1.5">
                                    {card.githubInstallations.map((login) => (
                                        <span key={login} className="rounded-full border border-border px-2 py-0.5 text-xs">
                                            {login}
                                        </span>
                                    ))}
                                </div>
                            ) : (
                                <p className="text-xs text-muted-foreground">
                                    Not installed on any account yet. Install the app to grant repository access.
                                </p>
                            )}
                            <div className="flex flex-wrap gap-2">
                                {card.githubHtmlUrl ? (
                                    <a
                                        href={`${card.githubHtmlUrl}/installations/new`}
                                        target="_blank"
                                        rel="noreferrer noopener"
                                        className="inline-flex items-center gap-1 rounded-md border border-border px-3 py-1.5 text-xs hover:bg-muted"
                                    >
                                        Install / manage <ExternalLink className="size-3" />
                                    </a>
                                ) : null}
                                <Button
                                    type="button"
                                    size="sm"
                                    variant="ghost"
                                    disabled={busy}
                                    onClick={() =>
                                        startBusy(async () => {
                                            const result = await refreshGithubInstallationsAction();
                                            if (result.error) setError(result.error);
                                        })
                                    }
                                >
                                    {busy ? <Loader2 className="size-4 animate-spin" /> : "Refresh"}
                                </Button>
                            </div>
                        </div>
                    ) : null}

                    {error ? <p className="text-sm text-danger">{error}</p> : null}

                    <div className="flex justify-end gap-2">
                        <Button type="button" variant="ghost" onClick={onClose}>
                            Close
                        </Button>
                        <Button
                            type="button"
                            variant="danger"
                            disabled={busy}
                            onClick={() =>
                                startBusy(async () => {
                                    const result = await disconnectGithubAction();
                                    if (result.error) setError(result.error);
                                    else onClose();
                                })
                            }
                        >
                            {busy ? <Loader2 className="size-4 animate-spin" /> : "Disconnect"}
                        </Button>
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    );
}

type ConnectMethod = "app" | "existing" | "token";

/** Disconnected state: choose how to connect (create an app, paste one, or a token). */
function GitHubConnect({ card, onClose }: { card: IntegrationCard; onClose: () => void }) {
    const [method, setMethod] = useState<ConnectMethod>("app");
    const [token, setToken] = useState("");
    const [appId, setAppId] = useState("");
    const [pem, setPem] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [saving, startSave] = useTransition();

    function onConnectToken() {
        setError(null);
        startSave(async () => {
            const result = await connectGithubAction(token);
            if (result.error) setError(result.error);
            else onClose();
        });
    }

    function onConnectExisting() {
        setError(null);
        startSave(async () => {
            const result = await connectGithubAppAction({ appId, pem });
            if (result.error) setError(result.error);
            else onClose();
        });
    }

    return (
        <Dialog open onOpenChange={(open) => !open && onClose()}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle className="flex items-center gap-2">
                        <IntegrationLogo slug="github" className="size-5" />
                        Connect GitHub
                    </DialogTitle>
                    <DialogDescription>{card.description}</DialogDescription>
                </DialogHeader>

                <div className="flex flex-col gap-4">
                    <div className="grid grid-cols-3 gap-1 rounded-md bg-muted p-1 text-sm">
                        {(
                            [
                                ["app", "Create app"],
                                ["existing", "Existing app"],
                                ["token", "Token"]
                            ] as const
                        ).map(([value, label]) => (
                            <button
                                key={value}
                                type="button"
                                onClick={() => setMethod(value)}
                                className={cn(
                                    "rounded px-2 py-1.5 font-medium transition-colors",
                                    method === value
                                        ? "bg-surface text-foreground shadow-sm"
                                        : "text-muted-foreground hover:text-foreground"
                                )}
                            >
                                {label}
                            </button>
                        ))}
                    </div>

                    {method === "app" ? (
                        <div className="flex flex-col gap-3 text-sm">
                            <p className="text-muted-foreground">
                                Create a GitHub App for this Polaris instance in one step. GitHub will ask you to
                                confirm, then to choose which repositories it can access.
                            </p>
                            <a
                                href="/api/integrations/github/new"
                                className="inline-flex w-fit items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
                            >
                                <IntegrationLogo slug="github" className="size-4" />
                                Create GitHub App
                            </a>
                        </div>
                    ) : method === "existing" ? (
                        <div className="flex flex-col gap-3 text-sm">
                            <label className="flex flex-col gap-1">
                                <span className="font-medium">App ID</span>
                                <Input value={appId} onChange={(event) => setAppId(event.target.value)} placeholder="123456" />
                            </label>
                            <label className="flex flex-col gap-1">
                                <span className="font-medium">Private key (PEM)</span>
                                <textarea
                                    value={pem}
                                    onChange={(event) => setPem(event.target.value)}
                                    placeholder="-----BEGIN RSA PRIVATE KEY-----"
                                    rows={4}
                                    className="rounded-md border border-input bg-surface px-3 py-2 font-mono text-xs shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                />
                            </label>
                            <div className="flex justify-end">
                                <Button type="button" onClick={onConnectExisting} disabled={saving || !appId.trim() || !pem.trim()}>
                                    {saving ? <Loader2 className="size-4 animate-spin" /> : "Connect app"}
                                </Button>
                            </div>
                        </div>
                    ) : (
                        <div className="flex flex-col gap-3 text-sm">
                            <label className="flex flex-col gap-1">
                                <span className="font-medium">{card.apiKeyLabel}</span>
                                <Input
                                    type="password"
                                    autoComplete="off"
                                    value={token}
                                    onChange={(event) => setToken(event.target.value)}
                                    placeholder="ghp_... or github_pat_..."
                                />
                                {card.apiKeyHelp ? (
                                    <span className="text-xs text-muted-foreground">{card.apiKeyHelp}</span>
                                ) : null}
                                <a
                                    href={card.docsUrl}
                                    target="_blank"
                                    rel="noreferrer noopener"
                                    className="inline-flex w-fit items-center gap-1 text-xs text-primary hover:underline"
                                >
                                    Create a token <ExternalLink className="size-3" />
                                </a>
                            </label>
                            <div className="flex justify-end">
                                <Button type="button" onClick={onConnectToken} disabled={saving || !token.trim()}>
                                    {saving ? <Loader2 className="size-4 animate-spin" /> : "Connect"}
                                </Button>
                            </div>
                        </div>
                    )}

                    {error ? <p className="text-sm text-danger">{error}</p> : null}
                </div>
            </DialogContent>
        </Dialog>
    );
}

function VirusTotalDialog({ card, onClose }: { card: IntegrationCard; onClose: () => void }) {
    const [enabled, setEnabled] = useState(card.enabled);
    const [scanDropPoints, setScanDropPoints] = useState(card.scanDropPoints);
    const [onDetection, setOnDetection] = useState<ScanAction>(card.onDetection);
    const [apiKey, setApiKey] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [tested, setTested] = useState<string | null>(null);
    const [testing, startTest] = useTransition();
    const [saving, startSave] = useTransition();

    function onTest() {
        setError(null);
        setTested(null);
        startTest(async () => {
            const result = await testVirusTotalKeyAction(apiKey);
            if (result.ok) setTested("The key works.");
            else setError(result.error ?? "The key was rejected");
        });
    }

    function onSave() {
        setError(null);
        startSave(async () => {
            const result = await saveVirusTotalAction({ enabled, scanDropPoints, onDetection, apiKey });
            if (result.error) setError(result.error);
            else onClose();
        });
    }

    return (
        <Dialog open onOpenChange={(open) => !open && onClose()}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle className="flex items-center gap-2">
                        <IntegrationLogo slug="virustotal" className="size-5" />
                        VirusTotal
                    </DialogTitle>
                    <DialogDescription>{card.description}</DialogDescription>
                </DialogHeader>

                <div className="flex flex-col gap-4">
                    <label className="flex flex-col gap-1 text-sm">
                        <span className="font-medium">{card.apiKeyLabel ?? "API key"}</span>
                        <div className="flex gap-2">
                            <Input
                                type="password"
                                autoComplete="off"
                                value={apiKey}
                                onChange={(event) => setApiKey(event.target.value)}
                                placeholder={card.hasSecret ? "Saved - enter a new key to replace it" : "Paste your key"}
                            />
                            <Button
                                type="button"
                                variant="ghost"
                                onClick={onTest}
                                disabled={testing || !apiKey.trim()}
                            >
                                {testing ? <Loader2 className="size-4 animate-spin" /> : "Test"}
                            </Button>
                        </div>
                        {card.apiKeyHelp ? <span className="text-xs text-muted-foreground">{card.apiKeyHelp}</span> : null}
                        {tested ? (
                            <span className="flex items-center gap-1 text-xs text-success">
                                <CheckCircle2 className="size-3" />
                                {tested}
                            </span>
                        ) : null}
                    </label>

                    <div className="flex items-start justify-between gap-3 text-sm">
                        <span>
                            <span className="font-medium">Scan drop-point uploads</span>
                            <span className="block text-xs text-muted-foreground">
                                Every file uploaded to a drop point is scanned before it is accepted.
                            </span>
                        </span>
                        <Switch
                            checked={scanDropPoints}
                            onChange={setScanDropPoints}
                            aria-label="Scan drop-point uploads"
                        />
                    </div>

                    <div className="flex flex-col gap-1.5">
                        <span className="text-sm font-medium">When a file is flagged</span>
                        <div className="flex flex-col gap-1.5">
                            {SCAN_ACTIONS.map((action) => (
                                <button
                                    key={action.value}
                                    type="button"
                                    onClick={() => setOnDetection(action.value)}
                                    className={cn(
                                        "flex items-start gap-2 rounded-md border p-2.5 text-left text-sm transition-colors",
                                        onDetection === action.value
                                            ? "border-primary bg-primary/5"
                                            : "border-border hover:bg-muted"
                                    )}
                                >
                                    <span
                                        className={cn(
                                            "mt-0.5 grid size-4 shrink-0 place-items-center rounded-full border",
                                            onDetection === action.value ? "border-primary" : "border-muted-foreground"
                                        )}
                                    >
                                        {onDetection === action.value ? (
                                            <span className="size-2 rounded-full bg-primary" />
                                        ) : null}
                                    </span>
                                    <span>
                                        <span className="font-medium">{action.label}</span>
                                        <span className="block text-xs text-muted-foreground">{action.help}</span>
                                    </span>
                                </button>
                            ))}
                        </div>
                    </div>

                    <div className="flex items-center justify-between gap-3 rounded-md border border-border p-2.5 text-sm">
                        <span className="flex items-center gap-1.5 font-medium">
                            <ShieldCheck className="size-4 text-primary" />
                            Enable VirusTotal
                        </span>
                        <Switch checked={enabled} onChange={setEnabled} aria-label="Enable VirusTotal" />
                    </div>

                    {error ? <p className="text-sm text-danger">{error}</p> : null}

                    <div className="flex justify-end gap-2">
                        <Button type="button" variant="ghost" onClick={onClose}>
                            Cancel
                        </Button>
                        <Button type="button" onClick={onSave} disabled={saving}>
                            {saving ? <Loader2 className="size-4 animate-spin" /> : "Save"}
                        </Button>
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    );
}
