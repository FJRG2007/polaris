"use client";

/**
 * The integrations marketplace grid and the per-integration configure dialog.
 * Only VirusTotal exists today, so the dialog renders its scan settings directly;
 * a second integration would branch on the slug. Toggling and saving go through
 * the admin-gated server actions.
 */

import { useState, useTransition } from "react";
import { CheckCircle2, ExternalLink, Loader2, ShieldCheck } from "lucide-react";
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
    Switch,
    cn
} from "@polaris/ui";
import { DYMO_IP_RULES, SCAN_ACTIONS, type ScanAction } from "@/lib/integrations/registry";
import { IntegrationLogo } from "@/components/logos";
import {
    connectGithubAction,
    disconnectGithubAction,
    saveDymoAction,
    saveVirusTotalAction,
    testDymoKeyAction,
    testGithubTokenAction,
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
    /** GitHub: the connected account login, when connected. */
    githubLogin?: string;
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
            ) : null}
        </>
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
    const [token, setToken] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [tested, setTested] = useState<string | null>(null);
    const [testing, startTest] = useTransition();
    const [saving, startSave] = useTransition();

    function onTest() {
        setError(null);
        setTested(null);
        startTest(async () => {
            const result = await testGithubTokenAction(token);
            if (result.ok) setTested(`Authenticated as ${result.login}.`);
            else setError(result.error ?? "The token was rejected");
        });
    }

    function onConnect() {
        setError(null);
        startSave(async () => {
            const result = await connectGithubAction(token);
            if (result.error) setError(result.error);
            else onClose();
        });
    }

    function onDisconnect() {
        setError(null);
        startSave(async () => {
            const result = await disconnectGithubAction();
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
                        GitHub
                    </DialogTitle>
                    <DialogDescription>{card.description}</DialogDescription>
                </DialogHeader>

                <div className="flex flex-col gap-4">
                    {card.githubLogin ? (
                        <div className="flex items-center justify-between gap-3 rounded-md border border-border bg-surface/40 p-3 text-sm">
                            <span className="flex items-center gap-2">
                                <CheckCircle2 className="size-4 text-success" />
                                Connected as <span className="font-medium">{card.githubLogin}</span>
                            </span>
                            <Button type="button" variant="danger" onClick={onDisconnect} disabled={saving}>
                                {saving ? <Loader2 className="size-4 animate-spin" /> : "Disconnect"}
                            </Button>
                        </div>
                    ) : null}

                    <label className="flex flex-col gap-1 text-sm">
                        <span className="font-medium">{card.githubLogin ? "Replace token" : card.apiKeyLabel}</span>
                        <div className="flex gap-2">
                            <Input
                                type="password"
                                autoComplete="off"
                                value={token}
                                onChange={(event) => setToken(event.target.value)}
                                placeholder="ghp_... or github_pat_..."
                            />
                            <Button type="button" variant="ghost" onClick={onTest} disabled={testing || !token.trim()}>
                                {testing ? <Loader2 className="size-4 animate-spin" /> : "Test"}
                            </Button>
                        </div>
                        {card.apiKeyHelp ? <span className="text-xs text-muted-foreground">{card.apiKeyHelp}</span> : null}
                        <a
                            href={card.docsUrl}
                            target="_blank"
                            rel="noreferrer noopener"
                            className="inline-flex w-fit items-center gap-1 text-xs text-primary hover:underline"
                        >
                            Create a token <ExternalLink className="size-3" />
                        </a>
                        {tested ? (
                            <span className="flex items-center gap-1 text-xs text-success">
                                <CheckCircle2 className="size-3" />
                                {tested}
                            </span>
                        ) : null}
                    </label>

                    {error ? <p className="text-sm text-danger">{error}</p> : null}

                    <div className="flex justify-end gap-2">
                        <Button type="button" variant="ghost" onClick={onClose}>
                            Cancel
                        </Button>
                        <Button type="button" onClick={onConnect} disabled={saving || !token.trim()}>
                            {saving ? <Loader2 className="size-4 animate-spin" /> : card.githubLogin ? "Update" : "Connect"}
                        </Button>
                    </div>
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
