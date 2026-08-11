"use client";

/**
 * The integrations grid and the configure dialog behind each card. Shared by the
 * marketplace and the AI providers screen, which pass different cards to the same
 * component. What a card opens is decided in one place (`dialogFor`) because a
 * card whose button opens nothing looks exactly like a broken page. Saving goes
 * through the admin-gated server actions.
 */

import { useRouter } from "next/navigation";
import { runAction } from "@/lib/run-action";
import * as integrationActions from "./actions";
import { IntegrationLogo } from "@/components/logos";
import { CopyButton } from "@/components/copy-button";
import { CRIMINALIP_RULES } from "@/lib/integrations/criminalip";
import { useState, useTransition, type ComponentType } from "react";
import { isTunnelToken, tunnelTokenHint, type TunnelProviderSlug } from "@/lib/integrations/tunnel-token";
import { CheckCircle2, Circle, ExternalLink, Loader2, RefreshCw, ShieldAlert, ShieldCheck } from "lucide-react";
import {
    CLOUDFLARE_TOKEN_LINKS,
    CLOUDFLARE_TOKEN_PERMISSIONS,
    type CloudflareTokenScope
} from "@/lib/integrations/cloudflare-token-link";
import {
    DYMO_IP_RULES,
    SCAN_ACTIONS,
    type GatewayConfig,
    type IntegrationSetupLink,
    type ScanAction
} from "@/lib/integrations/registry";
import {
    cn,
    Card,
    Badge,
    Input,
    Button,
    Dialog,
    Select,
    Switch,
    CardBody,
    Textarea,
    DialogTitle,
    DialogHeader,
    DialogContent,
    DialogDescription
} from "@polaris/ui";

/** What every configure dialog takes: the card it is for, and how to close it. */
export interface IntegrationDialogProps {
    card: IntegrationCard;
    onClose: () => void;
}

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
    /** Cloudflare: whether a token that can create named tunnels is connected. */
    cloudflareApiConnected?: boolean;
    /** Cloudflare: whether a token that can write DNS records is connected. */
    cloudflareDnsConnected?: boolean;
    /** Cloudflare: the connected account name, when a tunnel token is set. */
    cloudflareAccountName?: string;
    /** GitHub: how it is connected, when connected. */
    githubMethod?: "pat" | "app" | null;
    /** GitHub: the connected account login (PAT) or app name (App). */
    githubLogin?: string;
    /** GitHub App: accounts/orgs the app is installed on. */
    githubInstallations?: string[];
    /** GitHub App: the app's GitHub page, for the Install button. */
    githubHtmlUrl?: string;
    /** GitHub: whether this connection can also register self-hosted runners. */
    githubRunnersReady?: boolean;
    /** GitHub: what to change so it can, when it cannot. */
    githubRunnersAdvice?: string;
    /** GitHub: the address GitHub's own servers can reach this instance at, unset
     *  when there is none - then a new App gets no webhook. */
    githubPublicUrl?: string;
    /** Google/Microsoft/Dropbox: the OAuth client id, which is not a secret. */
    oauthClientId?: string;
    /** Google/Microsoft/Dropbox: the redirect URI to register on that client. */
    oauthCallbackUrl?: string;
    /** GitHub and the OAuth apps: how many accounts one person may connect. */
    accountLimit?: number;
    /** The services somebody links an account of: whether one authorization has
     *  completed here. Until it has, only administrators are offered the service.
     *  Undefined where there is no application to prove. */
    proven?: boolean;
    /** Where the vendor makes the credential this dialog is asking for. */
    setupLinks?: readonly IntegrationSetupLink[];
    /** The gateway's endpoint settings. Set for that card only. */
    gateway?: GatewayConfig;
    /** Whether a linked account of this service may sign anybody in here, for the
     *  services people link an account of. Undefined for the rest. */
    signInAllowed?: boolean;
    /** Why this service is a poor way in, when it is. */
    signInWarning?: string;
}

/** What a card's button opens. Every card in the catalog has to resolve to
 *  something here: one that resolves to nothing has a button that does nothing,
 *  which is indistinguishable from a broken page. */
export function dialogFor(card: IntegrationCard): ComponentType<IntegrationDialogProps> | null {
    if (card.slug === "virustotal") return VirusTotalDialog;
    if (card.slug === "dymo") return DymoDialog;
    if (card.slug === "criminalip") return CriminalIpDialog;
    if (card.slug === "github") return GitHubDialog;
    if (card.slug === "cloudflare" || card.slug === "ngrok") return TunnelDialog;
    if (card.slug === "duckdns") return DuckDnsDialog;
    if (card.slug === "steam") return SteamDialog;
    if (OAUTH_APPS[card.slug]) return OAuthAppDialog;
    // The gateway asks for an endpoint rather than a provider key, so it is told
    // apart by carrying those settings and not by its slug.
    if (card.gateway) return GatewayDialog;
    if (card.category === "Models") return ModelProviderDialog;
    return null;
}

export function IntegrationsView({ cards }: { cards: IntegrationCard[] }) {
    const router = useRouter();
    const [configuring, setConfiguring] = useState<IntegrationCard | null>(null);
    const ConfigureDialog = configuring ? dialogFor(configuring) : null;
    // The category badge sorts a mixed grid. On a screen that is all one category
    // it repeats the page title on every card, so it is left off there.
    const mixed = new Set(cards.map((card) => card.category)).size > 1;

    /**
     * These cards were rendered on the server, and a dialog saves through an
     * action rather than by navigating - so without this the grid behind it keeps
     * saying "Set up" over an integration that is configured and on, until
     * somebody reloads the page and finds out it worked. Asked for on every close
     * because several of these dialogs save on their own (the account limit, the
     * sign-in switch, a Cloudflare token) and never reach a Save button.
     */
    function closeDialog() {
        setConfiguring(null);
        router.refresh();
    }

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
                                        {mixed ? <Badge variant="neutral">{card.category}</Badge> : null}
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

            {configuring && ConfigureDialog ? (
                <ConfigureDialog card={configuring} onClose={closeDialog} />
            ) : null}
        </>
    );
}

/**
 * Whether this application has ever taken somebody through, and the way to find
 * out when it has not.
 *
 * Credentials that save are not a service that works, and the two are
 * indistinguishable from this screen: the client id and secret can be a genuine
 * pair, the redirect URI registered exactly right, and the provider still refuse
 * everybody - a Google client left in Testing blocks every account that is not on
 * its test-user list, and says so on its own error page, in a console the person
 * who hit it cannot open.
 *
 * So nobody else is offered the service until one authorization has completed
 * here. The button is the check: it is the ordinary Connect flow, run by the one
 * person who can fix what it hits.
 */
function ProvenState({ slug, name, proven }: { slug: string; name: string; proven: boolean }) {
    if (proven) {
        return (
            <p className="flex items-start gap-2 rounded-md border border-border p-3 text-xs text-muted-foreground">
                <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-success" />
                An account has been connected through this application, so everybody here is offered it.
            </p>
        );
    }
    return (
        <div className="flex flex-col gap-2 rounded-md border border-warning/40 bg-warning/5 p-3 text-sm">
            <span className="flex items-start gap-2">
                <ShieldAlert className="mt-0.5 size-4 shrink-0 text-warning" />
                <span>
                    <span className="font-medium">Not proven yet</span>
                    <span className="block text-xs text-muted-foreground">
                        Nobody else can connect {name} or sign in with it until one authorization has gone through
                        here. Connect your own account to check it - whatever {name} refuses, you are the one who can
                        change it.
                    </span>
                </span>
            </span>
            <a
                href={`/api/connections/${slug}/link`}
                className="inline-flex w-fit items-center gap-1 text-sm font-medium text-primary hover:underline"
            >
                Connect my {name} account
                <ExternalLink className="size-3 shrink-0" />
            </a>
        </div>
    );
}

/**
 * How many accounts of this service one person may connect.
 *
 * It saves itself rather than riding on the dialog's Save, because it is a
 * different subject from the application's credentials and the GitHub dialog has
 * three ways to reach that button. Unchanged values are not written at all - a
 * field somebody clicked into and left alone is not a change.
 */
function AccountLimitField({ slug, current }: { slug: string; current: number }) {
    const [value, setValue] = useState(String(current));
    const [saved, setSaved] = useState(current);
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();

    function commit() {
        const parsed = Number.parseInt(value, 10);
        if (!Number.isFinite(parsed) || parsed < 0) {
            setValue(String(saved));
            return;
        }
        if (parsed === saved) return;
        setError(null);
        startTransition(async () => {
            const result = await runAction(() => integrationActions.saveConnectionLimitAction(slug, parsed), setError);
            if (!result) return;
            if (result.error) {
                setError(result.error);
                setValue(String(saved));
                return;
            }
            setSaved(parsed);
        });
    }

    return (
        <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">Accounts per person</span>
            <Input
                type="number"
                min={0}
                max={20}
                inputMode="numeric"
                value={value}
                disabled={pending}
                onChange={(event) => setValue(event.target.value)}
                onBlur={commit}
            />
            <span className="text-xs text-muted-foreground">
                How many of these accounts one person may connect. Zero turns connecting off; lowering it never
                disconnects anybody already over the limit.
            </span>
            {error ? <span className="text-xs text-danger">{error}</span> : null}
        </label>
    );
}

/**
 * Where to go and get what this dialog is asking for.
 *
 * Every one of these forms ends with a value pasted from somebody else's console,
 * and finding that console is most of the work - so the steps are links, in the
 * order they happen, rather than a sentence naming a menu path. What the vendor
 * lets a URL carry it carries; the rest of the values stay on this screen to be
 * copied, because none of these consoles accept them from a link.
 */
function SetupSteps({ links }: { links?: readonly IntegrationSetupLink[] }) {
    if (!links || links.length === 0) return null;
    return (
        <div className="flex flex-col gap-2 rounded-md border border-border bg-muted/30 p-3">
            {links.map((step) => (
                <div key={step.url} className="flex flex-col gap-0.5">
                    <a
                        href={step.url}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="inline-flex w-fit items-center gap-1 text-sm font-medium text-primary hover:underline"
                    >
                        {step.label}
                        <ExternalLink className="size-3 shrink-0" />
                    </a>
                    {step.help ? <span className="text-xs text-muted-foreground">{step.help}</span> : null}
                </div>
            ))}
        </div>
    );
}

/**
 * Whether a linked account of this service may sign anybody in here.
 *
 * The operator's half of the decision. Each person still chooses for their own
 * account under Account > Security, and both have to say yes - turning it off
 * here refuses everybody at once, whatever they chose, which is what an operator
 * reaching for this wants. Saves itself for the same reason the account limit
 * does: it is a different subject from the credentials the dialog is about.
 */
function SignInSwitch({
    slug,
    name,
    allowed,
    warning
}: {
    slug: string;
    name: string;
    allowed: boolean;
    warning?: string;
}) {
    const [value, setValue] = useState(allowed);
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();

    function toggle(next: boolean) {
        setValue(next);
        setError(null);
        startTransition(async () => {
            const result = await runAction(() => integrationActions.saveConnectionSignInAction(slug, next), setError);
            if (!result || result.error) {
                setValue(!next);
                if (result?.error) setError(result.error);
            }
        });
    }

    return (
        <div className="flex flex-col gap-2 rounded-md border border-border p-3 text-sm">
            <div className="flex items-start justify-between gap-3">
                <span>
                    <span className="font-medium">Allow signing in with {name}</span>
                    <span className="block text-xs text-muted-foreground">
                        People who have connected a {name} account get a sign-in button for it. It never creates an
                        account: only someone who already has one, and connected it themselves, can use it.
                    </span>
                </span>
                <Switch
                    checked={value}
                    disabled={pending}
                    onChange={toggle}
                    aria-label={`Allow signing in with ${name}`}
                />
            </div>
            {warning ? (
                <p className="flex items-start gap-2 text-xs text-muted-foreground">
                    <ShieldAlert className="mt-0.5 size-3.5 shrink-0 text-warning" />
                    {warning}
                </p>
            ) : null}
            {error ? <p className="text-xs text-danger">{error}</p> : null}
        </div>
    );
}

/**
 * Connect Criminal IP: a key, and which of their verdicts count as a block.
 *
 * The rules are here rather than defaulted quietly because two of them - hosting
 * and VPN - refuse a great many ordinary people, and an operator who turns this
 * on without seeing that list would find out from a support message. The key is
 * not test-called on save: their summary endpoint spends a lookup from the
 * operator's own quota, and a wrong key surfaces in the firewall log instead.
 */
function CriminalIpDialog({ card, onClose }: IntegrationDialogProps) {
    const [enabled, setEnabled] = useState(card.hasSecret ? card.enabled : true);
    const [deny, setDeny] = useState<Set<string>>(new Set(card.deny));
    const [apiKey, setApiKey] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [saving, startSave] = useTransition();

    function toggleRule(value: string) {
        setDeny((prev) => {
            const next = new Set(prev);
            if (next.has(value)) next.delete(value);
            else next.add(value);
            return next;
        });
    }

    function onSave() {
        setError(null);
        startSave(async () => {
            const result = await runAction(
                () => integrationActions.saveCriminalIpAction({ enabled, deny: [...deny], apiKey }),
                setError
            );
            if (!result) return;
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
                    <SetupSteps links={card.setupLinks} />

                    <label className="flex flex-col gap-1 text-sm">
                        <span className="font-medium">{card.apiKeyLabel ?? "API key"}</span>
                        <Input
                            type="password"
                            autoComplete="off"
                            value={apiKey}
                            onChange={(event) => setApiKey(event.target.value)}
                            placeholder={card.hasSecret ? "Saved - enter a new key to replace it" : "Paste your key"}
                        />
                        {card.apiKeyHelp ? <span className="text-xs text-muted-foreground">{card.apiKeyHelp}</span> : null}
                    </label>

                    <div className="flex flex-col gap-1.5">
                        <span className="text-sm font-medium">Block addresses reported as</span>
                        <div className="flex flex-wrap gap-1.5">
                            {CRIMINALIP_RULES.map((rule) => (
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
                                </button>
                            ))}
                        </div>
                        <span className="text-xs text-muted-foreground">
                            Hosting and VPN cover a lot of ordinary traffic. Lookups happen in the background and the
                            answer is cached as an ordinary ban, so nothing here slows a request down.
                        </span>
                    </div>

                    <div className="flex items-center justify-between gap-3 rounded-md border border-border p-2.5 text-sm">
                        <span className="flex items-center gap-1.5 font-medium">
                            <ShieldCheck className="size-4 text-primary" />
                            Enable {card.name}
                        </span>
                        <Switch checked={enabled} onChange={setEnabled} aria-label={`Enable ${card.name}`} />
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

/**
 * Connect one model provider: a key, and whether runs may use it.
 *
 * One dialog for every provider in the Models category, because that is all
 * connecting one is - the key goes in, and a run is handed it. Nothing is
 * verified against the provider on save: every check costs tokens on the
 * operator's own account, and a wrong key fails at the start of the first run
 * naming itself.
 */
function ModelProviderDialog({ card, onClose }: { card: IntegrationCard; onClose: () => void }) {
    // A first-time setup defaults to on: nobody pastes a key meaning to leave it unused.
    const [enabled, setEnabled] = useState(card.hasSecret ? card.enabled : true);
    const [apiKey, setApiKey] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [saving, startSave] = useTransition();
    const [removing, startRemove] = useTransition();

    function onSave() {
        setError(null);
        startSave(async () => {
            const result = await runAction(
                () => integrationActions.saveModelProviderAction({ slug: card.slug, enabled, apiKey }),
                setError
            );
            if (!result) return;
            if (result.error) setError(result.error);
            else onClose();
        });
    }

    function onDisconnect() {
        setError(null);
        startRemove(async () => {
            const result = await runAction(() => integrationActions.disconnectModelProviderAction(card.slug), setError);
            if (!result) return;
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
                    <SetupSteps links={card.setupLinks} />

                    <label className="flex flex-col gap-1 text-sm">
                        <span className="font-medium">{card.apiKeyLabel ?? "API key"}</span>
                        <Input
                            type="password"
                            autoComplete="off"
                            value={apiKey}
                            onChange={(event) => setApiKey(event.target.value)}
                            placeholder={card.hasSecret ? "Saved - enter a new key to replace it" : "Paste your key"}
                        />
                        {card.apiKeyHelp ? <span className="text-xs text-muted-foreground">{card.apiKeyHelp}</span> : null}
                    </label>

                    <div className="flex items-start justify-between gap-3 rounded-md border border-border p-3 text-sm">
                        <span>
                            <span className="font-medium">Let agents use it</span>
                            <span className="block text-xs text-muted-foreground">
                                Runs are handed this key over an authenticated call. It is never written into a
                                repository, so rotating it here takes effect everywhere at once.
                            </span>
                        </span>
                        <Switch checked={enabled} onChange={setEnabled} aria-label={`Let agents use ${card.name}`} />
                    </div>

                    {error ? <p className="text-sm text-danger">{error}</p> : null}

                    <div className="flex justify-end gap-2">
                        {card.hasSecret ? (
                            <Button
                                type="button"
                                variant="ghost"
                                className="mr-auto text-danger"
                                onClick={onDisconnect}
                                disabled={saving || removing}
                            >
                                {removing ? <Loader2 className="size-4 animate-spin" /> : "Forget key"}
                            </Button>
                        ) : null}
                        <Button type="button" variant="ghost" onClick={onClose}>
                            Cancel
                        </Button>
                        <Button type="button" onClick={onSave} disabled={saving || removing}>
                            {saving ? <Loader2 className="size-4 animate-spin" /> : "Save"}
                        </Button>
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    );
}

/**
 * Point runs at an OpenAI-compatible endpoint instead of a provider key.
 *
 * The two token limits are fields rather than assumptions: an endpoint publishes
 * no catalog, and a run that has to guess caps its answers at 32000 tokens and
 * stops compacting - which looks like the agent quitting halfway through, not
 * like a setting nobody filled in.
 */
function GatewayDialog({ card, onClose }: { card: IntegrationCard; onClose: () => void }) {
    const saved = card.gateway ?? { baseUrl: "", model: "", context: 0, maxOutput: 0 };
    const [enabled, setEnabled] = useState(card.hasSecret || saved.baseUrl ? card.enabled : true);
    const [baseUrl, setBaseUrl] = useState(saved.baseUrl);
    const [model, setModel] = useState(saved.model);
    const [context, setContext] = useState(saved.context > 0 ? String(saved.context) : "");
    const [maxOutput, setMaxOutput] = useState(saved.maxOutput > 0 ? String(saved.maxOutput) : "");
    const [token, setToken] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [saving, startSave] = useTransition();

    function onSave() {
        setError(null);
        startSave(async () => {
            const result = await runAction(
                () =>
                    integrationActions.saveGatewayAction({
                        enabled,
                        baseUrl,
                        model,
                        context: Number.parseInt(context, 10) || 0,
                        maxOutput: Number.parseInt(maxOutput, 10) || 0,
                        token
                    }),
                setError
            );
            if (!result) return;
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
                    <label className="flex flex-col gap-1 text-sm">
                        <span className="font-medium">Base URL</span>
                        <Input
                            value={baseUrl}
                            onChange={(event) => setBaseUrl(event.target.value)}
                            placeholder="https://gateway.example.com/v1"
                            autoComplete="off"
                            spellCheck={false}
                        />
                        <span className="text-xs text-muted-foreground">
                            Reachable from wherever runs happen. A loopback address works for runs on this server and
                            not for runs on GitHub-hosted machines.
                        </span>
                    </label>

                    <label className="flex flex-col gap-1 text-sm">
                        <span className="font-medium">Model id</span>
                        <Input
                            value={model}
                            onChange={(event) => setModel(event.target.value)}
                            placeholder="The id the endpoint serves"
                            autoComplete="off"
                            spellCheck={false}
                        />
                    </label>

                    <div className="grid grid-cols-2 gap-3">
                        <label className="flex flex-col gap-1 text-sm">
                            <span className="font-medium">Context window</span>
                            <Input
                                type="number"
                                min={1}
                                inputMode="numeric"
                                value={context}
                                onChange={(event) => setContext(event.target.value)}
                                placeholder="200000"
                            />
                        </label>
                        <label className="flex flex-col gap-1 text-sm">
                            <span className="font-medium">Largest answer</span>
                            <Input
                                type="number"
                                min={1}
                                inputMode="numeric"
                                value={maxOutput}
                                onChange={(event) => setMaxOutput(event.target.value)}
                                placeholder="64000"
                            />
                        </label>
                    </div>
                    <span className="-mt-2 text-xs text-muted-foreground">
                        Both in tokens, from whatever the endpoint serves. Left unset, a run answers in 32000-token
                        slices and never compacts.
                    </span>

                    <label className="flex flex-col gap-1 text-sm">
                        <span className="font-medium">{card.apiKeyLabel ?? "Token"}</span>
                        <Input
                            type="password"
                            autoComplete="off"
                            value={token}
                            onChange={(event) => setToken(event.target.value)}
                            placeholder={card.hasSecret ? "Saved - enter a new token to replace it" : "Optional"}
                        />
                        {card.apiKeyHelp ? <span className="text-xs text-muted-foreground">{card.apiKeyHelp}</span> : null}
                    </label>

                    <div className="flex items-center justify-between gap-3 rounded-md border border-border p-3 text-sm">
                        <span className="font-medium">Let agents use it</span>
                        <Switch checked={enabled} onChange={setEnabled} aria-label={`Let agents use ${card.name}`} />
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

/**
 * Connect the Google Cloud OAuth client. Two fields and one thing to copy back:
 * Google refuses an authorization whose redirect URI was not registered on the
 * client, and that URI is decided by this deployment's address rather than by
 * anything the operator can guess - so it is shown here to be pasted in.
 */
/**
 * The services somebody links a personal account of, and what their app is
 * called where it is registered.
 *
 * One dialog for all of them: the fields are identical - a client id, a secret,
 * a redirect URI to paste back, how many accounts one person may link, and
 * whether the service may sign anybody in. Only the vocabulary differs, and a
 * second copy of this form would be a second place to fix the next bug in it.
 */
const OAUTH_APPS: Record<string, { name: string; idLabel: string; idPlaceholder: string }> = {
    google: {
        name: "Google",
        idLabel: "Client ID",
        idPlaceholder: "1234567890-abc.apps.googleusercontent.com"
    },
    microsoft: {
        name: "Microsoft",
        idLabel: "Application (client) ID",
        idPlaceholder: "00000000-0000-0000-0000-000000000000"
    },
    dropbox: { name: "Dropbox", idLabel: "App key", idPlaceholder: "abcdefghijklmno" },
    epic: { name: "Epic Games", idLabel: "Client ID", idPlaceholder: "xyza7891..." },
    minecraft: {
        name: "Minecraft",
        idLabel: "Application (client) ID",
        idPlaceholder: "00000000-0000-0000-0000-000000000000"
    }
};

function OAuthAppDialog({ card, onClose }: { card: IntegrationCard; onClose: () => void }) {
    const app = OAUTH_APPS[card.slug] ?? { name: card.name, idLabel: "Client ID", idPlaceholder: "" };
    const [enabled, setEnabled] = useState(card.hasSecret ? card.enabled : true);
    const [clientId, setClientId] = useState(card.oauthClientId ?? "");
    const [clientSecret, setClientSecret] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();

    const canSave = clientId.trim().length > 0 && (card.hasSecret || clientSecret.trim().length > 0);

    function onSave() {
        setError(null);
        startTransition(async () => {
            const result = await runAction(
                () =>
                    integrationActions.saveOAuthAppAction({
                        slug: card.slug,
                        enabled,
                        clientId: clientId.trim(),
                        clientSecret: clientSecret.trim() || undefined
                    }),
                setError
            );
            if (!result) return;
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
                    <SetupSteps links={card.setupLinks} />

                    <div className="flex items-center justify-between gap-3 rounded-md border border-border p-3 text-sm">
                        <span>Enabled</span>
                        <Switch checked={enabled} onChange={setEnabled} aria-label="Enabled" />
                    </div>

                    <label className="flex flex-col gap-1 text-sm">
                        <span className="font-medium">{app.idLabel}</span>
                        <Input
                            value={clientId}
                            onChange={(event) => setClientId(event.target.value)}
                            placeholder={app.idPlaceholder}
                            autoComplete="off"
                        />
                    </label>

                    <label className="flex flex-col gap-1 text-sm">
                        <span className="font-medium">{card.apiKeyLabel ?? "Client secret"}</span>
                        <Input
                            type="password"
                            value={clientSecret}
                            onChange={(event) => setClientSecret(event.target.value)}
                            placeholder={card.hasSecret ? "Saved - enter a new secret to replace it" : "Paste the secret"}
                            autoComplete="off"
                        />
                        {card.apiKeyHelp ? (
                            <span className="text-xs text-muted-foreground">{card.apiKeyHelp}</span>
                        ) : null}
                    </label>

                    <AccountLimitField slug={card.slug} current={card.accountLimit ?? 1} />

                    {card.hasSecret && card.proven !== undefined ? (
                        <ProvenState slug={card.slug} name={app.name} proven={card.proven} />
                    ) : null}

                    {card.signInAllowed === undefined ? null : (
                        <SignInSwitch
                            slug={card.slug}
                            name={app.name}
                            allowed={card.signInAllowed}
                            warning={card.signInWarning}
                        />
                    )}

                    {card.oauthCallbackUrl ? (
                        <div className="flex flex-col gap-1 rounded-md border border-border bg-muted/30 p-3 text-sm">
                            <span className="font-medium">Authorized redirect URI</span>
                            <div className="flex items-center gap-2">
                                <code className="min-w-0 flex-1 truncate text-xs" title={card.oauthCallbackUrl}>{card.oauthCallbackUrl}</code>
                                <CopyButton value={card.oauthCallbackUrl} label="Copy the redirect URI" />
                            </div>
                            <span className="text-xs text-muted-foreground">
                                Paste this into the app under its redirect URIs. {app.name} refuses an authorization
                                that arrives from any other address.
                            </span>
                        </div>
                    ) : null}

                    {error ? <p className="text-sm text-danger">{error}</p> : null}
                    <div className="flex justify-end gap-2">
                        <Button variant="ghost" onClick={onClose}>
                            Cancel
                        </Button>
                        <Button onClick={onSave} disabled={pending || !canSave}>
                            {pending ? "Saving..." : "Save"}
                        </Button>
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    );
}

/**
 * Steam, which is the one service on this screen with nothing to register.
 *
 * No client id, no redirect URI, no secret to refuse to switch on without: Steam
 * proves an account over OpenID, so turning this on is the whole setup and
 * everybody's Connect button starts working. The Web API key is optional and only
 * decides whether a linked account shows a name or a seventeen-digit number.
 */
function SteamDialog({ card, onClose }: { card: IntegrationCard; onClose: () => void }) {
    const [enabled, setEnabled] = useState(card.enabled || !card.hasSecret);
    const [apiKey, setApiKey] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();

    function onSave() {
        setError(null);
        startTransition(async () => {
            const result = await runAction(
                () => integrationActions.saveSteamAction({ enabled, apiKey: apiKey.trim() || undefined }),
                setError
            );
            if (!result) return;
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
                    <SetupSteps links={card.setupLinks} />

                    <div className="flex items-center justify-between gap-3 rounded-md border border-border p-3 text-sm">
                        <span className="flex flex-col gap-0.5">
                            <span>Enabled</span>
                            <span className="text-xs text-muted-foreground">
                                Everybody gets a Connect button for their own Steam account.
                            </span>
                        </span>
                        <Switch checked={enabled} onChange={setEnabled} aria-label="Enabled" />
                    </div>

                    <label className="flex flex-col gap-1 text-sm">
                        <span className="font-medium">{card.apiKeyLabel ?? "Web API key"}</span>
                        <Input
                            type="password"
                            value={apiKey}
                            onChange={(event) => setApiKey(event.target.value)}
                            placeholder={card.hasSecret ? "Saved - enter a new key to replace it" : "Optional"}
                            autoComplete="off"
                        />
                        {card.apiKeyHelp ? (
                            <span className="text-xs text-muted-foreground">{card.apiKeyHelp}</span>
                        ) : null}
                    </label>

                    <AccountLimitField slug={card.slug} current={card.accountLimit ?? 1} />

                    {card.signInAllowed === undefined ? null : (
                        <SignInSwitch
                            slug={card.slug}
                            name={card.name}
                            allowed={card.signInAllowed}
                            warning={card.signInWarning}
                        />
                    )}

                    {error ? <p className="text-sm text-danger">{error}</p> : null}
                    <div className="flex justify-end gap-2">
                        <Button variant="ghost" onClick={onClose}>
                            Cancel
                        </Button>
                        <Button onClick={onSave} disabled={pending}>
                            {pending ? "Saving..." : "Save"}
                        </Button>
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    );
}

function TunnelDialog({ card, onClose }: { card: IntegrationCard; onClose: () => void }) {
    const provider = card.slug as TunnelProviderSlug;
    // Default a first-time setup to enabled; respect the stored state once configured.
    const [enabled, setEnabled] = useState(card.hasSecret ? card.enabled : true);
    const [token, setToken] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();

    const entered = token.trim();
    const valid = isTunnelToken(provider, entered);
    // A blank field keeps the stored token, so an operator with one on file can save
    // the switch on its own. With nothing on file, and with a token that cannot be
    // one, there is nothing worth sending.
    const canSave = valid || (entered === "" && card.hasSecret && enabled !== card.enabled);

    function onSave() {
        setError(null);
        startTransition(async () => {
            const result = await runAction(
                () => integrationActions.saveTunnelAction({ provider, enabled, token: entered || undefined }),
                setError
            );
            if (!result) return;
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
                    <SetupSteps links={card.setupLinks} />

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
                        {entered && !valid ? (
                            <span className="text-xs text-danger">{tunnelTokenHint(provider)}</span>
                        ) : card.apiKeyHelp ? (
                            <span className="text-xs text-muted-foreground">{card.apiKeyHelp}</span>
                        ) : null}
                    </label>
                    {error ? <p className="text-sm text-danger">{error}</p> : null}
                    <div className="flex justify-end gap-2">
                        <Button variant="ghost" onClick={onClose}>
                            Cancel
                        </Button>
                        <Button onClick={onSave} disabled={pending || !canSave}>
                            {pending ? "Applying..." : "Save"}
                        </Button>
                    </div>

                    {provider === "cloudflare" ? <CloudflareApiTokenSection card={card} /> : null}
                </div>
            </DialogContent>
        </Dialog>
    );
}

/** What a token can be created for, in the order an operator most likely wants. */
const CLOUDFLARE_SCOPES: Array<{ id: CloudflareTokenScope; label: string; hint: string }> = [
    { id: "all", label: "Everything", hint: "One token for records and tunnels." },
    { id: "dns", label: "DNS only", hint: "Points your domains at this server." },
    { id: "tunnel", label: "Tunnels only", hint: "Publishes apps with no ports open." }
];

/**
 * Connect the API tokens Polaris uses Cloudflare through. Two capabilities, because
 * they need different permissions and either is useful alone: writing a zone's DNS
 * records, and creating a named tunnel per app. One token can carry both, and an
 * operator who would rather not give a DNS credential any tunnel access connects two.
 *
 * Separate from the connector token above, which runs one server-wide tunnel and
 * grants no API access at all.
 *
 * Each choice links to Cloudflare's token form with its permissions already ticked.
 * The permissions stay written out beside it because a key Cloudflare does not
 * recognize is dropped silently - the form opens looking entirely normal with that
 * row missing, and the operator only finds out when the token is rejected here.
 */
function CloudflareApiTokenSection({ card }: { card: IntegrationCard }) {
    const [tunnelConnected, setTunnelConnected] = useState(card.cloudflareApiConnected ?? false);
    const [dnsConnected, setDnsConnected] = useState(card.cloudflareDnsConnected ?? false);
    const [accountName, setAccountName] = useState(card.cloudflareAccountName ?? "");
    const [scope, setScope] = useState<CloudflareTokenScope>("all");
    const [token, setToken] = useState("");
    const [accounts, setAccounts] = useState<{ id: string; name: string }[]>([]);
    const [accountId, setAccountId] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [note, setNote] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();

    function onConnect(chosen?: string) {
        setError(null);
        setNote(null);
        startTransition(async () => {
            const result = await runAction(
                () => integrationActions.connectCloudflareAccountAction({ token, scope, accountId: chosen }),
                setError
            );
            if (!result) return;
            if (result.error) {
                setError(result.error);
                return;
            }
            if (result.connected) {
                const stored = result.stored ?? [];
                if (stored.includes("dns")) setDnsConnected(true);
                if (stored.includes("tunnel")) {
                    setTunnelConnected(true);
                    setAccountName(result.accountName ?? "");
                }
                // An "everything" token that reached no account lands as DNS only. Said
                // plainly here, because the row above simply not lighting up is the kind
                // of half-success an operator reads as a bug.
                if (scope === "all" && !stored.includes("tunnel")) {
                    setNote("Connected for DNS. The token reaches no account, so tunnels still need one.");
                }
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

    function onDisconnect(which: CloudflareTokenScope) {
        setError(null);
        setNote(null);
        startTransition(async () => {
            const result = await runAction(() => integrationActions.disconnectCloudflareAccountAction({ scope: which }), setError);
            if (!result) return;
            if (result.error) {
                setError(result.error);
                return;
            }
            if (which !== "tunnel") setDnsConnected(false);
            if (which !== "dns") {
                setTunnelConnected(false);
                setAccountName("");
            }
        });
    }

    const active = CLOUDFLARE_SCOPES.find((entry) => entry.id === scope);
    // Nothing left to ask for once both are connected; the rows above carry the state
    // and a form offering a token for capabilities that already work is just noise.
    const complete = dnsConnected && tunnelConnected;

    return (
        <div className="flex flex-col gap-3 border-t border-border pt-4">
            <div className="flex flex-col gap-1">
                <span className="text-sm font-medium">API access</span>
                <span className="text-xs text-muted-foreground">
                    Lets Polaris create your DNS records and each app&apos;s tunnel for you. One token can do both,
                    or connect them separately.
                </span>
            </div>

            <div className="flex flex-col gap-2">
                <CloudflareCapability
                    label="DNS records"
                    detail="Points your zones at this server."
                    connected={dnsConnected}
                    pending={pending}
                    onDisconnect={() => onDisconnect("dns")}
                />
                <CloudflareCapability
                    label="Named tunnels"
                    detail={tunnelConnected && accountName ? `Account: ${accountName}` : "One tunnel per app, no open ports."}
                    connected={tunnelConnected}
                    pending={pending}
                    onDisconnect={() => onDisconnect("tunnel")}
                />
            </div>

            {!complete && (
                <div className="flex flex-col gap-2">
                    <div className="flex flex-wrap gap-1.5">
                        {CLOUDFLARE_SCOPES.map((entry) => (
                            <button
                                key={entry.id}
                                type="button"
                                onClick={() => setScope(entry.id)}
                                className={`rounded-md border px-2 py-1 text-xs transition-colors ${
                                    scope === entry.id
                                        ? "border-primary bg-primary/5 text-foreground"
                                        : "border-border/60 text-muted-foreground hover:bg-muted/40"
                                }`}
                            >
                                {entry.label}
                            </button>
                        ))}
                    </div>
                    <span className="text-xs text-muted-foreground">
                        {active?.hint} The link opens Cloudflare with{" "}
                        {CLOUDFLARE_TOKEN_PERMISSIONS[scope].join(", ")} already selected.
                    </span>

                    <Input
                        type="password"
                        autoComplete="off"
                        value={token}
                        onChange={(event) => setToken(event.target.value)}
                        placeholder="Paste a Cloudflare API token"
                    />
                    {accounts.length > 0 ? (
                        <div className="flex flex-col gap-1 text-xs text-muted-foreground">
                            The token reaches several accounts - pick the one to use
                            <Select
                                value={accountId}
                                onValueChange={setAccountId}
                                options={accounts.map((account) => ({ value: account.id, label: account.name }))}
                            />
                        </div>
                    ) : null}
                    <div className="flex items-center justify-between gap-2">
                        <a
                            href={CLOUDFLARE_TOKEN_LINKS[scope]}
                            target="_blank"
                            rel="noreferrer noopener"
                            className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                        >
                            Create the token on Cloudflare <ExternalLink className="size-3" />
                        </a>
                        <Button
                            type="button"
                            size="sm"
                            onClick={() => onConnect(accounts.length > 0 ? accountId : undefined)}
                            disabled={pending || !token.trim() || (accounts.length > 0 && !accountId)}
                        >
                            {pending ? (
                                <Loader2 className="size-4 animate-spin" />
                            ) : accounts.length > 0 ? (
                                "Use this account"
                            ) : (
                                "Connect"
                            )}
                        </Button>
                    </div>
                </div>
            )}

            {note ? <p className="text-xs text-muted-foreground">{note}</p> : null}
            {error ? <p className="text-sm text-danger">{error}</p> : null}
        </div>
    );
}

/** One thing the API access buys, and whether it is paid for. */
function CloudflareCapability({
    label,
    detail,
    connected,
    pending,
    onDisconnect
}: {
    label: string;
    detail: string;
    connected: boolean;
    pending: boolean;
    onDisconnect: () => void;
}) {
    return (
        <div className="flex items-center justify-between gap-3 rounded-md border border-border bg-surface/40 p-2.5">
            <span className="flex min-w-0 flex-col">
                <span className="flex items-center gap-1.5 text-sm">
                    {connected ? (
                        <CheckCircle2 className="size-4 shrink-0 text-success" />
                    ) : (
                        <Circle className="size-4 shrink-0 text-muted-foreground" />
                    )}
                    {label}
                </span>
                <span className="truncate pl-5.5 text-xs text-muted-foreground">
                    {connected ? detail : `Not connected. ${detail}`}
                </span>
            </span>
            {connected && (
                <Button type="button" variant="ghost" size="sm" onClick={onDisconnect} disabled={pending}>
                    {pending ? <Loader2 className="size-4 animate-spin" /> : "Disconnect"}
                </Button>
            )}
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
            const result = await runAction(
                () => integrationActions.saveDuckdnsAction({ subdomain, token: token || undefined }),
                setError
            );
            if (!result) return;
            if (result.error) setError(result.error);
            else onClose();
        });
    }

    function onSync() {
        setError(null);
        setSynced(null);
        startSync(async () => {
            const result = await runAction(() => integrationActions.syncDuckdnsAction(), setError);
            if (!result) return;
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
                    <SetupSteps links={card.setupLinks} />

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
    const [enabled, setEnabled] = useState(card.hasSecret ? card.enabled : true);
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
            const result = await runAction(() => integrationActions.testDymoKeyAction(apiKey), setError);
            if (!result) return;
            if (result.ok) setTested("The key works.");
            else setError(result.error ?? "The key was rejected");
        });
    }

    function onSave() {
        setError(null);
        startSave(async () => {
            const result = await runAction(
                () => integrationActions.saveDymoAction({ enabled, verifyAccessIp, deny: [...deny], apiKey }),
                setError
            );
            if (!result) return;
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
                    <SetupSteps links={card.setupLinks} />

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

/**
 * Whether this connection can register self-hosted runners. Neither method asks
 * for the permission by default, so saying nothing would leave the operator to
 * discover it as a 403 after they have already set a machine up.
 */
function RunnerAccessNote({ card }: { card: IntegrationCard }) {
    if (card.githubRunnersReady === undefined) return null;
    if (card.githubRunnersReady && !card.githubRunnersAdvice) {
        return (
            <p className="flex items-start gap-2 text-xs text-muted-foreground">
                <ShieldCheck className="mt-0.5 size-3.5 shrink-0 text-success" />
                This connection can also register self-hosted runners.
            </p>
        );
    }
    return (
        <p className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning/5 px-3 py-2 text-xs text-muted-foreground">
            <ShieldCheck className="mt-0.5 size-3.5 shrink-0 text-warning" />
            <span>
                <span className="block font-medium text-foreground">Self-hosted runners</span>
                {card.githubRunnersAdvice}
            </span>
        </p>
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

                    <RunnerAccessNote card={card} />

                    <AccountLimitField slug="github" current={card.accountLimit ?? 1} />

                    {/* Only the App method can authorize a person at all; a token
                        connection has nobody to take through. */}
                    {isApp && card.proven !== undefined ? (
                        <ProvenState slug="github" name="GitHub" proven={card.proven} />
                    ) : null}

                    {card.signInAllowed === undefined ? null : (
                        <SignInSwitch
                            slug="github"
                            name="GitHub"
                            allowed={card.signInAllowed}
                            warning={card.signInWarning}
                        />
                    )}

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
                                            const result = await runAction(
                                                () => integrationActions.refreshGithubInstallationsAction(),
                                                setError
                                            );
                                            if (result?.error) setError(result.error);
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
                                    const result = await runAction(() => integrationActions.disconnectGithubAction(), setError);
                                    if (!result) return;
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

type ConnectMethod = "app" | "existing";

/**
 * Disconnected state: create a GitHub App for this instance, or paste one that
 * already exists.
 *
 * A personal access token is deliberately not offered here. It authenticates one
 * person, and connecting one instance-wide meant everybody on the box listed and
 * cloned that person's repositories with it. People paste their own token under
 * Connected accounts instead, where it only ever speaks for them.
 */
function GitHubConnect({ card, onClose }: { card: IntegrationCard; onClose: () => void }) {
    const [method, setMethod] = useState<ConnectMethod>("app");
    const [appId, setAppId] = useState("");
    const [pem, setPem] = useState("");
    const [clientId, setClientId] = useState("");
    const [clientSecret, setClientSecret] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [saving, startSave] = useTransition();

    function onConnectExisting() {
        setError(null);
        startSave(async () => {
            const result = await runAction(
                () => integrationActions.connectGithubAppAction({ appId, pem, clientId, clientSecret }),
                setError
            );
            if (!result) return;
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
                    <div className="grid grid-cols-2 gap-1 rounded-md bg-muted p-1 text-sm">
                        {(
                            [
                                ["app", "Create app"],
                                ["existing", "Existing app"]
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
                            {!card.githubPublicUrl ? (
                                <p className="text-muted-foreground">
                                    This instance has no address GitHub can reach, so the app is created without a
                                    webhook. Deploys and runner pools poll instead; agent triggers need the webhook,
                                    which you can add on GitHub once a domain is set.
                                </p>
                            ) : null}
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
                                <Textarea
                                    value={pem}
                                    onChange={(event) => setPem(event.target.value)}
                                    placeholder="Paste the contents of the app's .pem file"
                                    rows={4}
                                    className="rounded-md border border-input bg-surface px-3 py-2 font-mono text-xs shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                />
                            </label>
                            <label className="flex flex-col gap-1">
                                <span className="font-medium">Client ID</span>
                                <Input
                                    value={clientId}
                                    onChange={(event) => setClientId(event.target.value)}
                                    placeholder="Iv1.0123456789abcdef"
                                    autoCapitalize="none"
                                    autoCorrect="off"
                                    spellCheck={false}
                                />
                            </label>
                            <label className="flex flex-col gap-1">
                                <span className="font-medium">Client secret</span>
                                <Input
                                    type="password"
                                    value={clientSecret}
                                    onChange={(event) => setClientSecret(event.target.value)}
                                    placeholder="Optional"
                                />
                                <span className="text-xs text-muted-foreground">
                                    Only needed so people can link their own GitHub account to their Polaris one. An app
                                    created above already carries these.
                                </span>
                            </label>
                            <div className="flex justify-end">
                                <Button type="button" onClick={onConnectExisting} disabled={saving || !appId.trim() || !pem.trim()}>
                                    {saving ? <Loader2 className="size-4 animate-spin" /> : "Connect app"}
                                </Button>
                            </div>
                        </div>
                    ) : null}

                    <AccountLimitField slug="github" current={card.accountLimit ?? 1} />

                    {card.signInAllowed === undefined ? null : (
                        <SignInSwitch
                            slug="github"
                            name="GitHub"
                            allowed={card.signInAllowed}
                            warning={card.signInWarning}
                        />
                    )}

                    {error ? <p className="text-sm text-danger">{error}</p> : null}
                </div>
            </DialogContent>
        </Dialog>
    );
}

function VirusTotalDialog({ card, onClose }: { card: IntegrationCard; onClose: () => void }) {
    const [enabled, setEnabled] = useState(card.hasSecret ? card.enabled : true);
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
            const result = await runAction(() => integrationActions.testVirusTotalKeyAction(apiKey), setError);
            if (!result) return;
            if (result.ok) setTested("The key works.");
            else setError(result.error ?? "The key was rejected");
        });
    }

    function onSave() {
        setError(null);
        startSave(async () => {
            const result = await runAction(
                () => integrationActions.saveVirusTotalAction({ enabled, scanDropPoints, onDetection, apiKey }),
                setError
            );
            if (!result) return;
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
                    <SetupSteps links={card.setupLinks} />

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
