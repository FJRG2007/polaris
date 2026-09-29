"use client";

/**
 * The integrations grid and the configure dialog behind each card. What a card
 * opens is decided in one place (`dialogFor`) because a card whose button opens
 * nothing looks exactly like a broken page. Saving goes through the admin-gated
 * server actions.
 *
 * The model providers used to be cards here too, which made connecting a model
 * look like connecting a service and left an operator with one key per provider
 * and nothing to name it. They are a list of keys now, on their own screen.
 */

import { useRouter } from "next/navigation";
import { runAction } from "@/lib/run-action";
import * as integrationActions from "./actions";
import { IntegrationLogo } from "@/components/logos";
import { CopyButton } from "@/components/copy-button";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { CRIMINALIP_RULES } from "@/lib/integrations/criminalip";
import {
    use,
    useMemo,
    useState,
    Suspense,
    useContext,
    createContext,
    useTransition,
    type ComponentType
} from "react";
import type { ConnectionFailure } from "@/lib/connections/attention";
import {
    isTunnelToken,
    type TunnelProviderSlug
} from "@/lib/integrations/tunnel-token";
import {
    CheckCircle2,
    Circle,
    Download,
    ExternalLink,
    Loader2,
    RefreshCw,
    Search,
    ShieldAlert,
    ShieldCheck,
    TriangleAlert
} from "lucide-react";
import {
    CLOUDFLARE_TOKEN_LINKS,
    CLOUDFLARE_TOKEN_PERMISSIONS,
    type CloudflareTokenScope
} from "@/lib/integrations/cloudflare-token-link";
import {
    DYMO_IP_RULES,
    INTEGRATION_CATEGORIES,
    SCAN_ACTIONS,
    type IntegrationSetupLink,
    type IntegrationSetupValue,
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
    EmptyState,
    DialogTitle,
    DialogHeader,
    DialogContent,
    Skeleton,
    SegmentedControl,
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
    /** What this deployment knows that those steps ask to be pasted in. */
    setupValues?: Partial<Record<IntegrationSetupValue, string>>;
    /** What the last authorization was refused with, when one was. */
    failure?: ConnectionFailure;
    /** Where a licensed call filter is served from. Set for that card only. */
    filterModuleUrl?: string;
    /** Whether a linked account of this service may sign anybody in here, for the
     *  services people link an account of. Undefined for the rest. */
    signInAllowed?: boolean;
    /** Why this service is a poor way in, when it is. */
    signInWarning?: string;
    /** Whether this service's word confirms the address it hands over. Undefined
     *  for a service that hands over none, which is most of them. */
    emailTrusted?: boolean;
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
    // Both GIF services are a key and a switch, so they share the dialog and
    // the action; which one the picker asks is decided where the search is made.
    if (card.slug === "tenor" || card.slug === "giphy") return TenorDialog;
    if (card.slug === "krisp") return LicensedFilterDialog;
    if (OAUTH_APPS[card.slug]) return OAuthAppDialog;
    return null;
}

/** What a search matches on. The summary is in there because somebody looking
 *  for "gif" or "noise" is describing what they want done, not naming a vendor. */
function haystack(card: IntegrationCard): string {
    return `${card.name} ${card.slug} ${card.category} ${card.summary}`.toLowerCase();
}

/** Set up, or set up and switched off. Either way there is something stored, and
 *  that is what puts a service in front of the ones nobody has touched. */
function isConnected(card: IntegrationCard): boolean {
    return card.hasSecret || card.enabled;
}

/** Whether the GitHub connection can also register self-hosted runners, and what
 *  to change so it can when it cannot. */
export interface RunnerAccessNoteData {
    ready: boolean;
    advice: string | null;
}

/**
 * The runner check, still in flight. It asks GitHub itself, so the page does not
 * wait for it: the grid paints at once and the one note that needs the answer
 * waits for it inside the dialog. Carried in context rather than through every
 * dialog's props, since only the GitHub one reads it.
 */
const RunnerAccessContext = createContext<Promise<RunnerAccessNoteData | null> | null>(null);

export function IntegrationsView({
    cards,
    runnerAccess
}: {
    cards: IntegrationCard[];
    /** Null when GitHub is not connected, so there is nothing to check. */
    runnerAccess?: Promise<RunnerAccessNoteData | null>;
}) {
    const t = useTranslations("admin");

    const router = useRouter();
    const [configuring, setConfiguring] = useState<IntegrationCard | null>(null);
    const [query, setQuery] = useState("");
    const ConfigureDialog = configuring ? dialogFor(configuring) : null;

    const needle = query.trim().toLowerCase();
    const matches = useMemo(
        () => (needle ? cards.filter((card) => haystack(card).includes(needle)) : cards),
        [cards, needle]
    );

    /**
     * The catalogue by category, in the catalogue's own order, with whatever is
     * already set up at the top of each.
     *
     * A search collapses it to one list: somebody typing has already said what
     * they are looking for, and answering with five headings and a single card
     * under one of them makes them find it twice.
     */
    const sections = useMemo(() => {
        if (needle)
            return [{ name: null as string | null, hint: null as string | null, cards: matches }];
        return INTEGRATION_CATEGORIES.map(({ name, hint }) => ({
            name: name as string | null,
            hint: hint as string | null,
            cards: matches
                .filter((card) => card.category === name)
                .sort((left, right) => Number(isConnected(right)) - Number(isConnected(left)))
        })).filter((section) => section.cards.length > 0);
    }, [matches, needle]);

    const connected = cards.filter(isConnected).length;

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
            <div className="flex flex-col gap-5">
                <div className="flex flex-wrap items-center gap-3">
                    <div className="relative min-w-0 flex-1">
                        <Search className="text-muted-foreground pointer-events-none absolute left-3 top-1/2 size-4 shrink-0 -translate-y-1/2" />
                        <Input
                            value={query}
                            onChange={(event) => setQuery(event.target.value)}
                            placeholder={t("integrations.grid.search")}
                            aria-label={t("integrations.grid.search")}
                            className="pl-9"
                        />
                    </div>
                    <p className="text-muted-foreground whitespace-nowrap text-xs tabular-nums">
                        {t("integrations.grid.count", { connected, total: cards.length })}
                    </p>
                </div>

                {matches.length === 0 ? (
                    <EmptyState
                        icon={<Search />}
                        title={t("integrations.grid.emptyTitle")}
                        description={t("integrations.grid.emptyDescription")}
                    />
                ) : (
                    sections.map((section) => (
                        <section key={section.name ?? "results"} className="flex flex-col gap-3">
                            {section.name ? (
                                <div>
                                    <h2 className="text-sm font-medium">
                                        {section.name}
                                        <span className="text-muted-foreground ml-2 text-xs font-normal tabular-nums">
                                            {section.cards.length}
                                        </span>
                                    </h2>
                                    <p className="text-muted-foreground text-xs">{section.hint}</p>
                                </div>
                            ) : null}
                            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                                {section.cards.map((card) => (
                                    <Card key={card.slug}>
                                        <CardBody className="flex flex-col gap-3">
                                            <div className="flex items-start gap-3">
                                                <div className="border-border bg-surface grid size-10 shrink-0 place-items-center rounded-md border">
                                                    <IntegrationLogo
                                                        slug={card.slug}
                                                        className="size-6"
                                                    />
                                                </div>
                                                <div className="min-w-0 flex-1">
                                                    <div className="flex items-center gap-2">
                                                        <h3 className="truncate text-sm font-medium">
                                                            {card.name}
                                                        </h3>
                                                        {/* Only while searching: under a heading
                                                            that already says it, the badge is the
                                                            same word twice on every card. */}
                                                        {needle ? (
                                                            <Badge variant="neutral">
                                                                {card.category}
                                                            </Badge>
                                                        ) : null}
                                                    </div>
                                                    <p className="text-muted-foreground mt-0.5 text-xs">
                                                        {card.summary}
                                                    </p>
                                                </div>
                                                {/* A service that refused the last person to try it
                                                    is the one thing on this grid worth reading
                                                    before "On": it is on, and it is not working. */}
                                                {card.failure ? (
                                                    <Badge variant="warning">
                                                        {t("integrations.grid.needsAttention")}
                                                    </Badge>
                                                ) : card.enabled ? (
                                                    <Badge variant="success">
                                                        {t("integrations.grid.on")}
                                                    </Badge>
                                                ) : card.hasSecret ? (
                                                    <Badge variant="neutral">
                                                        {t("integrations.grid.off")}
                                                    </Badge>
                                                ) : null}
                                            </div>
                                            <div className="flex items-center justify-end gap-2">
                                                <a
                                                    href={card.docsUrl}
                                                    target="_blank"
                                                    rel="noreferrer noopener"
                                                    className="text-muted-foreground hover:text-foreground mr-auto inline-flex items-center gap-1 text-xs"
                                                >
                                                    {t("integrations.grid.docs")}
                                                    <ExternalLink className="size-3 shrink-0" />
                                                </a>
                                                <Button
                                                    size="sm"
                                                    variant="secondary"
                                                    onClick={() => setConfiguring(card)}
                                                >
                                                    {card.hasSecret
                                                        ? t("integrations.grid.configure")
                                                        : t("integrations.grid.setUp")}
                                                </Button>
                                            </div>
                                        </CardBody>
                                    </Card>
                                ))}
                            </div>
                        </section>
                    ))
                )}
            </div>

            {configuring && ConfigureDialog ? (
                <RunnerAccessContext.Provider value={runnerAccess ?? null}>
                    <ConfigureDialog card={configuring} onClose={closeDialog} />
                </RunnerAccessContext.Provider>
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
    const t = useTranslations("admin");

    if (proven) {
        return (
            <p className="flex items-start gap-2 rounded-md border border-border p-3 text-xs text-muted-foreground">
                <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-success" />
                {t("integrations.proven.done")}
            </p>
        );
    }
    return (
        <div className="flex flex-col gap-2 rounded-md border border-warning-edge bg-warning-soft p-3 text-sm">
            <span className="flex items-start gap-2">
                <ShieldAlert className="mt-0.5 size-4 shrink-0 text-warning" />
                <span>
                    <span className="font-medium">{t("integrations.proven.title")}</span>
                    <span className="block text-xs text-muted-foreground">
                        {t("integrations.proven.body", { name })}
                    </span>
                </span>
            </span>
            <a
                href={`/api/connections/${slug}/link`}
                className="inline-flex w-fit items-center gap-1 text-sm font-medium text-primary hover:underline"
            >
                {t("integrations.proven.connect", { name })}
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
    const t = useTranslations("admin");

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
            const result = await runAction(
                () => integrationActions.saveConnectionLimitAction(slug, parsed),
                setError
            );
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
            <span className="font-medium">{t("integrations.accountLimit.label")}</span>
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
                {t("integrations.accountLimit.hint")}
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
/** One value the step is asking for, ready to be taken across. The logo is a file
 *  rather than a string, so it is offered as a download instead of a copy. Each
 *  value is labelled with what it is called on the vendor's own form
 *  (`setupValue.label`), so the label here matches the field it is meant to be
 *  pasted into. */
function SetupValue({ kind, value }: { kind: IntegrationSetupValue; value: string }) {
    const t = useTranslations("admin");

    return (
        <div className="flex items-center gap-2 rounded border border-border bg-field px-2 py-1">
            <span className="shrink-0 text-xs text-muted-foreground">
                {t(`integrations.setupValue.label.${kind}`)}
            </span>
            <code className="min-w-0 flex-1 truncate text-xs" title={value}>
                {value}
            </code>
            {kind === "logoUrl" ? (
                <a
                    href={value}
                    download
                    className="inline-flex shrink-0 items-center gap-1 text-xs text-primary hover:underline"
                >
                    <Download className="size-3" />
                    {t("integrations.setupValue.download")}
                </a>
            ) : (
                <CopyButton
                    value={value}
                    label={t(`integrations.setupValue.copy.${kind}`)}
                />
            )}
        </div>
    );
}

/**
 * The setup, in the order it happens, with what each step asks for beside it.
 *
 * Numbered because these are steps and not a pile of links: several of these
 * setups refuse everybody until the last one is done, and an operator who does
 * them out of order finds out from somebody else's failed Connect button. The
 * values are here rather than in one block at the bottom for the same reason -
 * the redirect URI belongs to the step that registers it.
 */
function SetupSteps({
    links,
    values
}: {
    links?: readonly IntegrationSetupLink[];
    values?: Partial<Record<IntegrationSetupValue, string>>;
}) {
    if (!links || links.length === 0) return null;
    return (
        <ol className="flex flex-col gap-3 rounded-md border border-border bg-muted/30 p-3">
            {links.map((step, index) => (
                <li key={`${step.url}-${step.label}`} className="flex gap-2">
                    <span className="mt-0.5 shrink-0 text-xs font-medium tabular-nums text-muted-foreground">
                        {index + 1}.
                    </span>
                    <div className="flex min-w-0 flex-1 flex-col gap-1">
                        <a
                            href={step.url}
                            target="_blank"
                            rel="noreferrer noopener"
                            className="inline-flex w-fit items-center gap-1 text-sm font-medium text-primary hover:underline"
                        >
                            {step.label}
                            <ExternalLink className="size-3 shrink-0" />
                        </a>
                        {step.help ? (
                            <span className="text-xs text-muted-foreground">{step.help}</span>
                        ) : null}
                        {step.values
                            ?.map((kind) => ({ kind, value: values?.[kind] }))
                            // A value this deployment does not know is left out rather
                            // than shown empty: an operator pasting a blank field in
                            // is worse off than one who was never offered it.
                            .filter(
                                (entry): entry is { kind: IntegrationSetupValue; value: string } =>
                                    Boolean(entry.value)
                            )
                            .map((entry) => (
                                <SetupValue
                                    key={entry.kind}
                                    kind={entry.kind}
                                    value={entry.value}
                                />
                            ))}
                    </div>
                </li>
            ))}
        </ol>
    );
}

/**
 * What the last authorization failed with.
 *
 * The operator is the only person who can act on it and the only one who never
 * sees it happen: it fails in somebody else's browser, against a console only
 * this account can open. The alert says the same thing - this is here for
 * whoever arrives at the screen afterwards.
 */
function AttentionNotice({ failure, name }: { failure: ConnectionFailure; name: string }) {
    const t = useTranslations("admin");

    return (
        <div className="flex gap-2 rounded-md border border-warning-edge bg-warning-soft p-3 text-xs">
            <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" />
            <div className="flex min-w-0 flex-col gap-1">
                <span className="text-sm font-medium">{t("integrations.attention.title")}</span>
                <span className="text-muted-foreground">
                    {t("integrations.attention.reason", { name, reason: failure.reason })}
                </span>
                <span className="text-muted-foreground">
                    {t("integrations.attention.clears")}
                </span>
            </div>
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
    const t = useTranslations("admin");

    const [value, setValue] = useState(allowed);
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();

    function toggle(next: boolean) {
        setValue(next);
        setError(null);
        startTransition(async () => {
            const result = await runAction(
                () => integrationActions.saveConnectionSignInAction(slug, next),
                setError
            );
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
                    <span className="font-medium">{t("integrations.signIn.label", { name })}</span>
                    <span className="block text-xs text-muted-foreground">
                        {t("integrations.signIn.hint", { name })}
                    </span>
                </span>
                <Switch
                    checked={value}
                    disabled={pending}
                    onChange={toggle}
                    aria-label={t("integrations.signIn.label", { name })}
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
 * Whether this service's word confirms the address it hands over.
 *
 * Worth an operator's attention rather than a default nobody sees: a confirmed
 * address is where a password reset and a sign-in code go, so trusting a service
 * makes that company's account recovery part of this deployment's. Turning it off
 * costs nothing but a confirmation link - the address is held for its owner
 * either way, which is the part that stops anybody else being given it.
 */
function EmailTrustSwitch({
    slug,
    name,
    trusted
}: {
    slug: string;
    name: string;
    trusted: boolean;
}) {
    const t = useTranslations("admin");

    const [value, setValue] = useState(trusted);
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();

    function toggle(next: boolean) {
        setValue(next);
        setError(null);
        startTransition(async () => {
            const result = await runAction(
                () => integrationActions.saveConnectionEmailTrustAction(slug, next),
                setError
            );
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
                    <span className="font-medium">{t("integrations.emailTrust.label", { name })}</span>
                    <span className="block text-xs text-muted-foreground">
                        {t("integrations.emailTrust.hint", { name })}
                    </span>
                </span>
                <Switch
                    checked={value}
                    disabled={pending}
                    onChange={toggle}
                    aria-label={t("integrations.emailTrust.label", { name })}
                />
            </div>
            <p className="flex items-start gap-2 text-xs text-muted-foreground">
                <ShieldAlert className="mt-0.5 size-3.5 shrink-0 text-warning" />
                {t("integrations.emailTrust.warning")}
            </p>
            {error ? <p className="text-xs text-danger">{error}</p> : null}
        </div>
    );
}

/**
 * What an operator decides about a service people link an account of: whether it
 * may sign them in, and whether its word confirms the address it hands over.
 *
 * Drawn together because they are the same judgement about the same company, and
 * every dialog that offers one offers the other. Each half draws only where the
 * service has that half to decide - a provider that vouches for no address gets
 * no switch about addresses.
 */
function ConnectionPolicy({
    card,
    slug,
    name
}: {
    card: IntegrationCard;
    slug: string;
    name: string;
}) {
    return (
        <>
            {card.signInAllowed === undefined ? null : (
                <SignInSwitch
                    slug={slug}
                    name={name}
                    allowed={card.signInAllowed}
                    warning={card.signInWarning}
                />
            )}
            {card.emailTrusted === undefined ? null : (
                <EmailTrustSwitch slug={slug} name={name} trusted={card.emailTrusted} />
            )}
        </>
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
    const t = useTranslations("admin");
    const tc = useTranslations("common");

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
                    <SetupSteps links={card.setupLinks} values={card.setupValues} />

                    <label className="flex flex-col gap-1 text-sm">
                        <span className="font-medium">
                            {card.apiKeyLabel ?? t("integrations.dialog.apiKey")}
                        </span>
                        <Input
                            type="password"
                            autoComplete="off"
                            value={apiKey}
                            onChange={(event) => setApiKey(event.target.value)}
                            placeholder={
                                card.hasSecret
                                    ? t("integrations.dialog.savedKey")
                                    : t("integrations.dialog.pasteKey")
                            }
                        />
                        {card.apiKeyHelp ? (
                            <span className="text-xs text-muted-foreground">{card.apiKeyHelp}</span>
                        ) : null}
                    </label>

                    <div className="flex flex-col gap-1.5">
                        <span className="text-sm font-medium">
                            {t("integrations.criminalIp.block")}
                        </span>
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
                                    {t(`integrations.criminalIp.rules.${rule.value}`)}
                                </button>
                            ))}
                        </div>
                        <span className="text-xs text-muted-foreground">
                            {t("integrations.criminalIp.hint")}
                        </span>
                    </div>

                    <div className="flex items-center justify-between gap-3 rounded-md border border-border p-2.5 text-sm">
                        <span className="flex items-center gap-1.5 font-medium">
                            <ShieldCheck className="size-4 text-primary" />
                            {t("integrations.dialog.enable", { name: card.name })}
                        </span>
                        <Switch
                            checked={enabled}
                            onChange={setEnabled}
                            aria-label={t("integrations.dialog.enable", { name: card.name })}
                        />
                    </div>

                    {error ? <p className="text-sm text-danger">{error}</p> : null}

                    <div className="flex justify-end gap-2">
                        <Button type="button" variant="ghost" onClick={onClose}>
                            {tc("actions.cancel")}
                        </Button>
                        <Button type="button" onClick={onSave} disabled={saving}>
                            {saving ? <Loader2 className="size-4 animate-spin" /> : tc("actions.save")}
                        </Button>
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    );
}

/**
 * Point calls at a licensed noise filter.
 *
 * Two fields and a switch, and the dialog is honest about both of them: the
 * address is loaded as code by every browser in a call, and the token goes with
 * it. There is no arrangement where a filter running on somebody's microphone
 * does not hold its own credential in the page.
 */
function LicensedFilterDialog({ card, onClose }: { card: IntegrationCard; onClose: () => void }) {
    const t = useTranslations("admin");
    const tc = useTranslations("common");

    const [enabled, setEnabled] = useState(card.filterModuleUrl ? card.enabled : true);
    const [moduleUrl, setModuleUrl] = useState(card.filterModuleUrl ?? "");
    const [token, setToken] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [saving, startSave] = useTransition();

    function onSave() {
        setError(null);
        startSave(async () => {
            const result = await runAction(
                () =>
                    integrationActions.saveLicensedFilterAction({
                        enabled,
                        moduleUrl,
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
                    <SetupSteps links={card.setupLinks} values={card.setupValues} />

                    <label className="flex flex-col gap-1 text-sm">
                        <span className="font-medium">{t("integrations.filter.moduleUrl")}</span>
                        <Input
                            value={moduleUrl}
                            autoComplete="off"
                            placeholder="https://files.example.com/krisp/filter.js"
                            onChange={(event) => setModuleUrl(event.target.value)}
                        />
                        <span className="text-xs text-muted-foreground">
                            {t.rich("integrations.filter.moduleHint", {
                                code: (chunks) => <code key="code">{chunks}</code>
                            })}
                        </span>
                    </label>

                    <label className="flex flex-col gap-1 text-sm">
                        <span className="font-medium">
                            {card.apiKeyLabel ?? t("integrations.dialog.token")}
                        </span>
                        <Input
                            type="password"
                            autoComplete="off"
                            value={token}
                            onChange={(event) => setToken(event.target.value)}
                            placeholder={
                                card.hasSecret
                                    ? t("integrations.dialog.savedOne")
                                    : t("integrations.dialog.optional")
                            }
                        />
                        <span className="text-xs text-muted-foreground">
                            {t("integrations.filter.tokenHint")}
                        </span>
                    </label>

                    <div className="flex items-start justify-between gap-3 rounded-md border border-border p-3 text-sm">
                        <span>
                            <span className="font-medium">{t("integrations.filter.use")}</span>
                            <span className="block text-xs text-muted-foreground">
                                {t("integrations.filter.useHint")}
                            </span>
                        </span>
                        <Switch
                            checked={enabled}
                            onChange={setEnabled}
                            aria-label={t("integrations.filter.use")}
                        />
                    </div>

                    {error ? <p className="text-sm text-danger">{error}</p> : null}

                    <div className="flex justify-end gap-2">
                        <Button type="button" variant="ghost" onClick={onClose}>
                            {tc("actions.cancel")}
                        </Button>
                        <Button type="button" onClick={onSave} disabled={saving}>
                            {saving ? <Loader2 className="size-4 animate-spin" /> : tc("actions.save")}
                        </Button>
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    );
}

/**
 * Turn the GIF and sticker search on, with the key it runs on.
 *
 * A key and a switch, because that is the whole of it: nothing else in Polaris
 * changes when it is off, and the picker in Chat keeps working without it.
 */
function TenorDialog({ card, onClose }: { card: IntegrationCard; onClose: () => void }) {
    const t = useTranslations("admin");
    const tc = useTranslations("common");

    // Nobody pastes a key meaning to leave it unused.
    const [enabled, setEnabled] = useState(card.hasSecret ? card.enabled : true);
    const [apiKey, setApiKey] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [saving, startSave] = useTransition();

    function onSave() {
        setError(null);
        startSave(async () => {
            const result = await runAction(
                () => integrationActions.saveTenorAction({ enabled, apiKey, slug: card.slug }),
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
                    <SetupSteps links={card.setupLinks} values={card.setupValues} />

                    <label className="flex flex-col gap-1 text-sm">
                        <span className="font-medium">
                            {card.apiKeyLabel ?? t("integrations.dialog.apiKey")}
                        </span>
                        <Input
                            type="password"
                            autoComplete="off"
                            value={apiKey}
                            onChange={(event) => setApiKey(event.target.value)}
                            placeholder={
                                card.hasSecret
                                    ? t("integrations.dialog.savedKey")
                                    : t("integrations.dialog.pasteKey")
                            }
                        />
                        {card.apiKeyHelp ? (
                            <span className="text-xs text-muted-foreground">{card.apiKeyHelp}</span>
                        ) : null}
                    </label>

                    <div className="flex items-start justify-between gap-3 rounded-md border border-border p-3 text-sm">
                        <span>
                            <span className="font-medium">{t("integrations.tenor.search")}</span>
                            <span className="block text-xs text-muted-foreground">
                                {t("integrations.tenor.hint")}
                            </span>
                        </span>
                        <Switch
                            checked={enabled}
                            onChange={setEnabled}
                            aria-label={t("integrations.tenor.search")}
                        />
                    </div>

                    {error ? <p className="text-sm text-danger">{error}</p> : null}

                    <div className="flex justify-end gap-2">
                        <Button type="button" variant="ghost" onClick={onClose}>
                            {tc("actions.cancel")}
                        </Button>
                        <Button type="button" onClick={onSave} disabled={saving}>
                            {saving ? <Loader2 className="size-4 animate-spin" /> : tc("actions.save")}
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
/** The id's name on the vendor's form, as a key of `oauth.idLabel`. */
type OAuthIdLabel = "clientId" | "applicationId" | "appKey";

const OAUTH_APPS: Record<string, { name: string; idLabel: OAuthIdLabel; idPlaceholder: string }> = {
    google: {
        name: "Google",
        idLabel: "clientId",
        idPlaceholder: "1234567890-abc.apps.googleusercontent.com"
    },
    microsoft: {
        name: "Microsoft",
        idLabel: "applicationId",
        idPlaceholder: "00000000-0000-0000-0000-000000000000"
    },
    dropbox: { name: "Dropbox", idLabel: "appKey", idPlaceholder: "abcdefghijklmno" },
    epic: { name: "Epic Games", idLabel: "clientId", idPlaceholder: "xyza7891..." },
    minecraft: {
        name: "Minecraft",
        idLabel: "applicationId",
        idPlaceholder: "00000000-0000-0000-0000-000000000000"
    },
    // Discord's client id is the application id: a snowflake, so the placeholder
    // is digits rather than the hex an operator might otherwise go looking for.
    discord: { name: "Discord", idLabel: "clientId", idPlaceholder: "123456789012345678" },
    // Spotify's client id is 32 hexadecimal characters.
    spotify: {
        name: "Spotify",
        idLabel: "clientId",
        idPlaceholder: "0123456789abcdef0123456789abcdef"
    }
};

function OAuthAppDialog({ card, onClose }: { card: IntegrationCard; onClose: () => void }) {
    const t = useTranslations("admin");
    const tc = useTranslations("common");

    const app = OAUTH_APPS[card.slug] ?? {
        name: card.name,
        idLabel: "clientId",
        idPlaceholder: ""
    };
    const [enabled, setEnabled] = useState(card.hasSecret ? card.enabled : true);
    const [clientId, setClientId] = useState(card.oauthClientId ?? "");
    const [clientSecret, setClientSecret] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();

    const canSave =
        clientId.trim().length > 0 && (card.hasSecret || clientSecret.trim().length > 0);

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
                    {card.failure ? (
                        <AttentionNotice failure={card.failure} name={app.name} />
                    ) : null}

                    <SetupSteps links={card.setupLinks} values={card.setupValues} />

                    <div className="flex items-center justify-between gap-3 rounded-md border border-border p-3 text-sm">
                        <span>{t("integrations.dialog.enabled")}</span>
                        <Switch checked={enabled} onChange={setEnabled} aria-label={t("integrations.dialog.enabled")} />
                    </div>

                    <label className="flex flex-col gap-1 text-sm">
                        <span className="font-medium">
                            {t(`integrations.oauth.idLabel.${app.idLabel}`)}
                        </span>
                        <Input
                            value={clientId}
                            onChange={(event) => setClientId(event.target.value)}
                            placeholder={app.idPlaceholder}
                            autoComplete="off"
                        />
                    </label>

                    <label className="flex flex-col gap-1 text-sm">
                        <span className="font-medium">
                            {card.apiKeyLabel ?? t("integrations.dialog.clientSecret")}
                        </span>
                        <Input
                            type="password"
                            value={clientSecret}
                            onChange={(event) => setClientSecret(event.target.value)}
                            placeholder={
                                card.hasSecret
                                    ? t("integrations.dialog.savedSecret")
                                    : t("integrations.dialog.pasteSecret")
                            }
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

                    <ConnectionPolicy card={card} slug={card.slug} name={app.name} />

                    {card.oauthCallbackUrl ? (
                        <div className="flex flex-col gap-1 rounded-md border border-border bg-muted/30 p-3 text-sm">
                            <span className="font-medium">
                                {t("integrations.oauth.redirectTitle")}
                            </span>
                            <div className="flex items-center gap-2">
                                <code
                                    className="min-w-0 flex-1 truncate text-xs"
                                    title={card.oauthCallbackUrl}
                                >
                                    {card.oauthCallbackUrl}
                                </code>
                                <CopyButton
                                    value={card.oauthCallbackUrl}
                                    label={t("integrations.oauth.copyRedirect")}
                                />
                            </div>
                            <span className="text-xs text-muted-foreground">
                                {t("integrations.oauth.redirectHint", { name: app.name })}
                            </span>
                        </div>
                    ) : null}

                    {error ? <p className="text-sm text-danger">{error}</p> : null}
                    <div className="flex justify-end gap-2">
                        <Button variant="ghost" onClick={onClose}>
                            {tc("actions.cancel")}
                        </Button>
                        <Button onClick={onSave} disabled={pending || !canSave}>
                            {pending ? tc("actions.saving") : tc("actions.save")}
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
    const t = useTranslations("admin");
    const tc = useTranslations("common");

    const [enabled, setEnabled] = useState(card.enabled || !card.hasSecret);
    const [apiKey, setApiKey] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();

    function onSave() {
        setError(null);
        startTransition(async () => {
            const result = await runAction(
                () =>
                    integrationActions.saveSteamAction({
                        enabled,
                        apiKey: apiKey.trim() || undefined
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
                    <SetupSteps links={card.setupLinks} values={card.setupValues} />

                    <div className="flex items-center justify-between gap-3 rounded-md border border-border p-3 text-sm">
                        <span className="flex flex-col gap-0.5">
                            <span>{t("integrations.dialog.enabled")}</span>
                            <span className="text-xs text-muted-foreground">
                                {t("integrations.steam.enabledHint")}
                            </span>
                        </span>
                        <Switch checked={enabled} onChange={setEnabled} aria-label={t("integrations.dialog.enabled")} />
                    </div>

                    <label className="flex flex-col gap-1 text-sm">
                        <span className="font-medium">
                            {card.apiKeyLabel ?? t("integrations.dialog.webApiKey")}
                        </span>
                        <Input
                            type="password"
                            value={apiKey}
                            onChange={(event) => setApiKey(event.target.value)}
                            placeholder={
                                card.hasSecret
                                    ? t("integrations.dialog.savedKey")
                                    : t("integrations.dialog.optional")
                            }
                            autoComplete="off"
                        />
                        {card.apiKeyHelp ? (
                            <span className="text-xs text-muted-foreground">{card.apiKeyHelp}</span>
                        ) : null}
                    </label>

                    <AccountLimitField slug={card.slug} current={card.accountLimit ?? 1} />

                    <ConnectionPolicy card={card} slug={card.slug} name={card.name} />

                    {error ? <p className="text-sm text-danger">{error}</p> : null}
                    <div className="flex justify-end gap-2">
                        <Button variant="ghost" onClick={onClose}>
                            {tc("actions.cancel")}
                        </Button>
                        <Button onClick={onSave} disabled={pending}>
                            {pending ? tc("actions.saving") : tc("actions.save")}
                        </Button>
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    );
}

function TunnelDialog({ card, onClose }: { card: IntegrationCard; onClose: () => void }) {
    const t = useTranslations("admin");
    const tc = useTranslations("common");

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
                () =>
                    integrationActions.saveTunnelAction({
                        provider,
                        enabled,
                        token: entered || undefined
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
                    <SetupSteps links={card.setupLinks} values={card.setupValues} />

                    <div className="flex items-center justify-between gap-3 rounded-md border border-border p-3 text-sm">
                        <span>{t("integrations.dialog.enabled")}</span>
                        <Switch checked={enabled} onChange={setEnabled} aria-label={t("integrations.dialog.enabled")} />
                    </div>
                    <label className="flex flex-col gap-1 text-sm">
                        {card.apiKeyLabel ?? t("integrations.dialog.token")}
                        <Input
                            type="password"
                            value={token}
                            onChange={(event) => setToken(event.target.value)}
                            placeholder={
                                card.hasSecret
                                    ? t("integrations.dialog.savedToken")
                                    : t("integrations.dialog.pasteToken")
                            }
                            autoComplete="off"
                        />
                        {entered && !valid ? (
                            <span className="text-xs text-danger">{t(`integrations.tunnelHint.${provider}`)}</span>
                        ) : card.apiKeyHelp ? (
                            <span className="text-xs text-muted-foreground">{card.apiKeyHelp}</span>
                        ) : null}
                    </label>
                    {error ? <p className="text-sm text-danger">{error}</p> : null}
                    <div className="flex justify-end gap-2">
                        <Button variant="ghost" onClick={onClose}>
                            {tc("actions.cancel")}
                        </Button>
                        <Button onClick={onSave} disabled={pending || !canSave}>
                            {pending ? t("integrations.dialog.applying") : tc("actions.save")}
                        </Button>
                    </div>

                    {provider === "cloudflare" ? <CloudflareApiTokenSection card={card} /> : null}
                </div>
            </DialogContent>
        </Dialog>
    );
}

/** What a token can be created for, in the order an operator most likely wants.
 *  Each one's label and hint are `cloudflare.scope.<id>`. */
const CLOUDFLARE_SCOPES: CloudflareTokenScope[] = ["all", "dns", "tunnel"];

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
    const t = useTranslations("admin");

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
                () =>
                    integrationActions.connectCloudflareAccountAction({
                        token,
                        scope,
                        accountId: chosen
                    }),
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
                    setNote(t("integrations.cloudflare.dnsOnlyNote"));
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
            const result = await runAction(
                () => integrationActions.disconnectCloudflareAccountAction({ scope: which }),
                setError
            );
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

    // Nothing left to ask for once both are connected; the rows above carry the state
    // and a form offering a token for capabilities that already work is just noise.
    const complete = dnsConnected && tunnelConnected;

    return (
        <div className="flex flex-col gap-3 border-t border-border pt-4">
            <div className="flex flex-col gap-1">
                <span className="text-sm font-medium">{t("integrations.cloudflare.apiAccess")}</span>
                <span className="text-xs text-muted-foreground">
                    {t("integrations.cloudflare.apiAccessHint")}
                </span>
            </div>

            <div className="flex flex-col gap-2">
                <CloudflareCapability
                    label={t("integrations.cloudflare.dnsLabel")}
                    detail={t("integrations.cloudflare.dnsDetail")}
                    connected={dnsConnected}
                    pending={pending}
                    onDisconnect={() => onDisconnect("dns")}
                />
                <CloudflareCapability
                    label={t("integrations.cloudflare.tunnelsLabel")}
                    detail={
                        tunnelConnected && accountName
                            ? t("integrations.cloudflare.tunnelsAccount", { name: accountName })
                            : t("integrations.cloudflare.tunnelsDetail")
                    }
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
                                key={entry}
                                type="button"
                                onClick={() => setScope(entry)}
                                className={`rounded-md border px-2 py-1 text-xs transition-colors ${
                                    scope === entry
                                        ? "border-primary bg-primary/5 text-foreground"
                                        : "border-border/60 text-muted-foreground hover:bg-muted/40"
                                }`}
                            >
                                {t(`integrations.cloudflare.scope.${entry}.label`)}
                            </button>
                        ))}
                    </div>
                    <span className="text-xs text-muted-foreground">
                        {t("integrations.cloudflare.scopeHint", {
                            hint: t(`integrations.cloudflare.scope.${scope}.hint`),
                            permissions: CLOUDFLARE_TOKEN_PERMISSIONS[scope].join(", ")
                        })}
                    </span>

                    <Input
                        type="password"
                        autoComplete="off"
                        value={token}
                        onChange={(event) => setToken(event.target.value)}
                        placeholder={t("integrations.cloudflare.tokenPlaceholder")}
                    />
                    {accounts.length > 0 ? (
                        <div className="flex flex-col gap-1 text-xs text-muted-foreground">
                            {t("integrations.cloudflare.pickAccount")}
                            <Select
                                value={accountId}
                                onValueChange={setAccountId}
                                options={accounts.map((account) => ({
                                    value: account.id,
                                    label: account.name
                                }))}
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
                            {t("integrations.cloudflare.createToken")}{" "}
                            <ExternalLink className="size-3" />
                        </a>
                        <Button
                            type="button"
                            size="sm"
                            onClick={() => onConnect(accounts.length > 0 ? accountId : undefined)}
                            disabled={
                                pending || !token.trim() || (accounts.length > 0 && !accountId)
                            }
                        >
                            {pending ? (
                                <Loader2 className="size-4 animate-spin" />
                            ) : accounts.length > 0 ? (
                                t("integrations.cloudflare.useAccount")
                            ) : (
                                t("integrations.dialog.connect")
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
    const t = useTranslations("admin");

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
                    {connected ? detail : t("integrations.cloudflare.notConnected", { detail })}
                </span>
            </span>
            {connected && (
                <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={onDisconnect}
                    disabled={pending}
                >
                    {pending ? (
                        <Loader2 className="size-4 animate-spin" />
                    ) : (
                        t("integrations.dialog.disconnect")
                    )}
                </Button>
            )}
        </div>
    );
}

function DuckDnsDialog({ card, onClose }: { card: IntegrationCard; onClose: () => void }) {
    const t = useTranslations("admin");
    const tc = useTranslations("common");

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
                () =>
                    integrationActions.saveDuckdnsAction({ subdomain, token: token || undefined }),
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
                        {/* i18n-ignore: brand name */}
                        DuckDNS
                    </DialogTitle>
                    <DialogDescription>{card.description}</DialogDescription>
                </DialogHeader>

                <div className="flex flex-col gap-4">
                    <SetupSteps links={card.setupLinks} values={card.setupValues} />

                    <label className="flex flex-col gap-1 text-sm">
                        <span className="font-medium">{t("integrations.duckdns.subdomain")}</span>
                        <div className="flex items-center gap-2">
                            <Input
                                value={subdomain}
                                onChange={(event) => setSubdomain(event.target.value)}
                                placeholder="myhome"
                                autoComplete="off"
                            />
                            <span className="shrink-0 text-sm text-muted-foreground">
                                .duckdns.org
                            </span>
                        </div>
                    </label>

                    <label className="flex flex-col gap-1 text-sm">
                        <span className="font-medium">
                            {card.apiKeyLabel ?? t("integrations.dialog.token")}
                        </span>
                        <Input
                            type="password"
                            autoComplete="off"
                            value={token}
                            onChange={(event) => setToken(event.target.value)}
                            placeholder={
                                card.hasSecret
                                    ? t("integrations.dialog.savedToken")
                                    : t("integrations.duckdns.pasteToken")
                            }
                        />
                        {card.apiKeyHelp ? (
                            <span className="text-xs text-muted-foreground">{card.apiKeyHelp}</span>
                        ) : null}
                    </label>

                    {card.hasSecret ? (
                        <div className="flex items-center justify-between gap-3 rounded-md border border-border p-2.5 text-sm">
                            <span className="text-muted-foreground">
                                {t("integrations.duckdns.syncHint")}
                            </span>
                            <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                onClick={onSync}
                                disabled={syncing}
                            >
                                {syncing ? (
                                    <Loader2 className="size-4 animate-spin" />
                                ) : (
                                    <RefreshCw className="size-4" />
                                )}
                                {t("integrations.duckdns.syncNow")}
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
                            {tc("actions.cancel")}
                        </Button>
                        <Button type="button" onClick={onSave} disabled={saving}>
                            {saving ? <Loader2 className="size-4 animate-spin" /> : tc("actions.save")}
                        </Button>
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    );
}

function DymoDialog({ card, onClose }: { card: IntegrationCard; onClose: () => void }) {
    const t = useTranslations("admin");
    const tc = useTranslations("common");

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
            const result = await runAction(
                () => integrationActions.testDymoKeyAction(apiKey),
                setError
            );
            if (!result) return;
            if (result.ok) setTested(t("integrations.dialog.keyWorks"));
            else setError(result.error ?? t("integrations.dialog.keyRejected"));
        });
    }

    function onSave() {
        setError(null);
        startSave(async () => {
            const result = await runAction(
                () =>
                    integrationActions.saveDymoAction({
                        enabled,
                        verifyAccessIp,
                        deny: [...deny],
                        apiKey
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
            <DialogContent>
                <DialogHeader>
                    <DialogTitle className="flex items-center gap-2">
                        <IntegrationLogo slug="dymo" className="size-5" />
                        {/* i18n-ignore: brand name */}
                        Dymo API
                    </DialogTitle>
                    <DialogDescription>{card.description}</DialogDescription>
                </DialogHeader>

                <div className="flex flex-col gap-4">
                    <SetupSteps links={card.setupLinks} values={card.setupValues} />

                    <label className="flex flex-col gap-1 text-sm">
                        <span className="font-medium">
                            {card.apiKeyLabel ?? t("integrations.dialog.apiKey")}
                        </span>
                        <div className="flex gap-2">
                            <Input
                                type="password"
                                autoComplete="off"
                                value={apiKey}
                                onChange={(event) => setApiKey(event.target.value)}
                                placeholder={
                                    card.hasSecret
                                        ? t("integrations.dialog.savedKey")
                                        : t("integrations.dialog.pasteKey")
                                }
                            />
                            <Button
                                type="button"
                                variant="ghost"
                                onClick={onTest}
                                disabled={testing || !apiKey.trim()}
                            >
                                {testing ? (
                                    <Loader2 className="size-4 animate-spin" />
                                ) : (
                                    t("integrations.dialog.test")
                                )}
                            </Button>
                        </div>
                        {card.apiKeyHelp ? (
                            <span className="text-xs text-muted-foreground">{card.apiKeyHelp}</span>
                        ) : null}
                        {tested ? (
                            <span className="flex items-center gap-1 text-xs text-success">
                                <CheckCircle2 className="size-3" />
                                {tested}
                            </span>
                        ) : null}
                    </label>

                    <div className="flex items-start justify-between gap-3 text-sm">
                        <span>
                            <span className="font-medium">{t("integrations.dymo.verify")}</span>
                            <span className="block text-xs text-muted-foreground">
                                {t("integrations.dymo.verifyHint")}
                            </span>
                        </span>
                        <Switch
                            checked={verifyAccessIp}
                            onChange={setVerifyAccessIp}
                            aria-label={t("integrations.dymo.verify")}
                        />
                    </div>

                    <div className="flex flex-col gap-1.5">
                        <span className="text-sm font-medium">{t("integrations.dymo.block")}</span>
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
                                    {rule.premium
                                        ? t("integrations.dymo.premium", { label: rule.label })
                                        : rule.label}
                                </button>
                            ))}
                        </div>
                    </div>

                    <div className="flex items-center justify-between gap-3 rounded-md border border-border p-2.5 text-sm">
                        <span className="flex items-center gap-1.5 font-medium">
                            <ShieldCheck className="size-4 text-primary" />
                            {t("integrations.dialog.enable", { name: "Dymo API" })}
                        </span>
                        <Switch
                            checked={enabled}
                            onChange={setEnabled}
                            aria-label={t("integrations.dialog.enable", { name: "Dymo API" })}
                        />
                    </div>

                    {error ? <p className="text-sm text-danger">{error}</p> : null}

                    <div className="flex justify-end gap-2">
                        <Button type="button" variant="ghost" onClick={onClose}>
                            {tc("actions.cancel")}
                        </Button>
                        <Button type="button" onClick={onSave} disabled={saving}>
                            {saving ? <Loader2 className="size-4 animate-spin" /> : tc("actions.save")}
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
function RunnerAccessNote() {
    const pending = useContext(RunnerAccessContext);
    if (!pending) return null;
    return (
        <Suspense fallback={<Skeleton className="h-4 w-2/3" />}>
            <RunnerAccessAnswer pending={pending} />
        </Suspense>
    );
}

function RunnerAccessAnswer({ pending }: { pending: Promise<RunnerAccessNoteData | null> }) {
    const t = useTranslations("admin");
    const access = use(pending);
    if (!access) return null;
    if (access.ready && !access.advice) {
        return (
            <p className="flex items-start gap-2 text-xs text-muted-foreground">
                <ShieldCheck className="mt-0.5 size-3.5 shrink-0 text-success" />
                {t("integrations.runners.ready")}
            </p>
        );
    }
    return (
        <p className="flex items-start gap-2 rounded-md border border-warning-edge bg-warning-soft px-3 py-2 text-xs text-muted-foreground">
            <ShieldCheck className="mt-0.5 size-3.5 shrink-0 text-warning" />
            <span>
                <span className="block font-medium text-foreground">
                    {t("integrations.runners.title")}
                </span>
                {access.advice}
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
    const t = useTranslations("admin");

    const [error, setError] = useState<string | null>(null);
    const [busy, startBusy] = useTransition();
    const isApp = card.githubMethod === "app";

    return (
        <Dialog open onOpenChange={(open) => !open && onClose()}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle className="flex items-center gap-2">
                        <IntegrationLogo slug="github" className="size-5" />
                        {/* i18n-ignore: brand name */}
                        GitHub
                    </DialogTitle>
                    <DialogDescription>{card.description}</DialogDescription>
                </DialogHeader>

                <div className="flex flex-col gap-4">
                    {/* Connected and refusing people are not exclusive: the App is
                        installed, and the last person through it was turned away. */}
                    {card.failure ? (
                        <AttentionNotice failure={card.failure} name={card.name} />
                    ) : null}

                    <div className="flex items-center gap-2 rounded-md border border-border bg-surface/40 p-3 text-sm">
                        <CheckCircle2 className="size-4 text-success" />
                        {t.rich("integrations.github.connectedVia", {
                            method: isApp ? "app" : "token",
                            login: card.githubLogin ?? "",
                            strong: (chunks) => (
                                <span key="login" className="font-medium">
                                    {chunks}
                                </span>
                            )
                        })}
                    </div>

                    <RunnerAccessNote />

                    <AccountLimitField slug="github" current={card.accountLimit ?? 1} />

                    {/* Only the App method can authorize a person at all; a token
                        connection has nobody to take through. */}
                    {isApp && card.proven !== undefined ? (
                        <ProvenState slug="github" name="GitHub" proven={card.proven} />
                    ) : null}

                    <ConnectionPolicy card={card} slug="github" name="GitHub" />

                    {isApp ? (
                        <div className="flex flex-col gap-2 text-sm">
                            <span className="font-medium">
                                {t("integrations.github.installations")}
                            </span>
                            {card.githubInstallations && card.githubInstallations.length > 0 ? (
                                <div className="flex flex-wrap gap-1.5">
                                    {card.githubInstallations.map((login) => (
                                        <span
                                            key={login}
                                            className="rounded-full border border-border px-2 py-0.5 text-xs"
                                        >
                                            {login}
                                        </span>
                                    ))}
                                </div>
                            ) : (
                                <p className="text-xs text-muted-foreground">
                                    {t("integrations.github.notInstalled")}
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
                                        {t("integrations.github.installManage")}{" "}
                                        <ExternalLink className="size-3" />
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
                                                () =>
                                                    integrationActions.refreshGithubInstallationsAction(),
                                                setError
                                            );
                                            if (result?.error) setError(result.error);
                                        })
                                    }
                                >
                                    {busy ? (
                                        <Loader2 className="size-4 animate-spin" />
                                    ) : (
                                        t("integrations.dialog.refresh")
                                    )}
                                </Button>
                            </div>
                        </div>
                    ) : null}

                    {error ? <p className="text-sm text-danger">{error}</p> : null}

                    <div className="flex justify-end gap-2">
                        <Button type="button" variant="ghost" onClick={onClose}>
                            {t("integrations.dialog.close")}
                        </Button>
                        <Button
                            type="button"
                            variant="danger"
                            disabled={busy}
                            onClick={() =>
                                startBusy(async () => {
                                    const result = await runAction(
                                        () => integrationActions.disconnectGithubAction(),
                                        setError
                                    );
                                    if (!result) return;
                                    if (result.error) setError(result.error);
                                    else onClose();
                                })
                            }
                        >
                            {busy ? (
                                <Loader2 className="size-4 animate-spin" />
                            ) : (
                                t("integrations.dialog.disconnect")
                            )}
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
    const t = useTranslations("admin");

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
                () =>
                    integrationActions.connectGithubAppAction({
                        appId,
                        pem,
                        clientId,
                        clientSecret
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
            <DialogContent>
                <DialogHeader>
                    <DialogTitle className="flex items-center gap-2">
                        <IntegrationLogo slug="github" className="size-5" />
                        {t("integrations.github.connectTitle")}
                    </DialogTitle>
                    <DialogDescription>{card.description}</DialogDescription>
                </DialogHeader>

                <div className="flex flex-col gap-4">
                    <SegmentedControl
                        aria-label={t("integrations.github.howToConnect")}
                        className="flex w-full"
                        value={method}
                        onValueChange={setMethod}
                        options={[
                            { value: "app", label: t("integrations.github.createApp") },
                            { value: "existing", label: t("integrations.github.existingApp") }
                        ]}
                    />

                    {method === "app" ? (
                        <div className="flex flex-col gap-3 text-sm">
                            <p className="text-muted-foreground">
                                {t("integrations.github.createIntro")}
                            </p>
                            {!card.githubPublicUrl ? (
                                <p className="text-muted-foreground">
                                    {t("integrations.github.noWebhook")}
                                </p>
                            ) : null}
                            <a
                                href="/api/integrations/github/new"
                                className="inline-flex w-fit items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
                            >
                                <IntegrationLogo slug="github" className="size-4" />
                                {t("integrations.github.createGithubApp")}
                            </a>
                        </div>
                    ) : method === "existing" ? (
                        <div className="flex flex-col gap-3 text-sm">
                            <label className="flex flex-col gap-1">
                                <span className="font-medium">{t("integrations.github.appId")}</span>
                                <Input
                                    value={appId}
                                    onChange={(event) => setAppId(event.target.value)}
                                    placeholder="123456"
                                />
                            </label>
                            <label className="flex flex-col gap-1">
                                <span className="font-medium">
                                    {t("integrations.github.privateKey")}
                                </span>
                                <Textarea
                                    value={pem}
                                    onChange={(event) => setPem(event.target.value)}
                                    placeholder={t("integrations.github.pemPlaceholder")}
                                    rows={4}
                                    className="rounded-md border border-border bg-surface px-3 py-2 font-mono text-xs "
                                />
                            </label>
                            <label className="flex flex-col gap-1">
                                <span className="font-medium">
                                    {t("integrations.github.clientId")}
                                </span>
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
                                <span className="font-medium">
                                    {t("integrations.dialog.clientSecret")}
                                </span>
                                <Input
                                    type="password"
                                    value={clientSecret}
                                    onChange={(event) => setClientSecret(event.target.value)}
                                    placeholder={t("integrations.dialog.optional")}
                                />
                                <span className="text-xs text-muted-foreground">
                                    {t("integrations.github.clientSecretHint")}
                                </span>
                            </label>
                            <div className="flex justify-end">
                                <Button
                                    type="button"
                                    onClick={onConnectExisting}
                                    disabled={saving || !appId.trim() || !pem.trim()}
                                >
                                    {saving ? (
                                        <Loader2 className="size-4 animate-spin" />
                                    ) : (
                                        t("integrations.github.connectApp")
                                    )}
                                </Button>
                            </div>
                        </div>
                    ) : null}

                    <AccountLimitField slug="github" current={card.accountLimit ?? 1} />

                    <ConnectionPolicy card={card} slug="github" name="GitHub" />

                    {error ? <p className="text-sm text-danger">{error}</p> : null}
                </div>
            </DialogContent>
        </Dialog>
    );
}

function VirusTotalDialog({ card, onClose }: { card: IntegrationCard; onClose: () => void }) {
    const t = useTranslations("admin");
    const tc = useTranslations("common");

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
            const result = await runAction(
                () => integrationActions.testVirusTotalKeyAction(apiKey),
                setError
            );
            if (!result) return;
            if (result.ok) setTested(t("integrations.dialog.keyWorks"));
            else setError(result.error ?? t("integrations.dialog.keyRejected"));
        });
    }

    function onSave() {
        setError(null);
        startSave(async () => {
            const result = await runAction(
                () =>
                    integrationActions.saveVirusTotalAction({
                        enabled,
                        scanDropPoints,
                        onDetection,
                        apiKey
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
            <DialogContent>
                <DialogHeader>
                    <DialogTitle className="flex items-center gap-2">
                        <IntegrationLogo slug="virustotal" className="size-5" />
                        {/* i18n-ignore: brand name */}
                        VirusTotal
                    </DialogTitle>
                    <DialogDescription>{card.description}</DialogDescription>
                </DialogHeader>

                <div className="flex flex-col gap-4">
                    <SetupSteps links={card.setupLinks} values={card.setupValues} />

                    <label className="flex flex-col gap-1 text-sm">
                        <span className="font-medium">
                            {card.apiKeyLabel ?? t("integrations.dialog.apiKey")}
                        </span>
                        <div className="flex gap-2">
                            <Input
                                type="password"
                                autoComplete="off"
                                value={apiKey}
                                onChange={(event) => setApiKey(event.target.value)}
                                placeholder={
                                    card.hasSecret
                                        ? t("integrations.dialog.savedKey")
                                        : t("integrations.dialog.pasteKey")
                                }
                            />
                            <Button
                                type="button"
                                variant="ghost"
                                onClick={onTest}
                                disabled={testing || !apiKey.trim()}
                            >
                                {testing ? (
                                    <Loader2 className="size-4 animate-spin" />
                                ) : (
                                    t("integrations.dialog.test")
                                )}
                            </Button>
                        </div>
                        {card.apiKeyHelp ? (
                            <span className="text-xs text-muted-foreground">{card.apiKeyHelp}</span>
                        ) : null}
                        {tested ? (
                            <span className="flex items-center gap-1 text-xs text-success">
                                <CheckCircle2 className="size-3" />
                                {tested}
                            </span>
                        ) : null}
                    </label>

                    <div className="flex items-start justify-between gap-3 text-sm">
                        <span>
                            <span className="font-medium">{t("integrations.virusTotal.scan")}</span>
                            <span className="block text-xs text-muted-foreground">
                                {t("integrations.virusTotal.scanHint")}
                            </span>
                        </span>
                        <Switch
                            checked={scanDropPoints}
                            onChange={setScanDropPoints}
                            aria-label={t("integrations.virusTotal.scan")}
                        />
                    </div>

                    <div className="flex flex-col gap-1.5">
                        <span className="text-sm font-medium">
                            {t("integrations.virusTotal.whenFlagged")}
                        </span>
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
                                            onDetection === action.value
                                                ? "border-primary"
                                                : "border-muted-foreground"
                                        )}
                                    >
                                        {onDetection === action.value ? (
                                            <span className="size-2 rounded-full bg-primary" />
                                        ) : null}
                                    </span>
                                    <span>
                                        <span className="font-medium">{action.label}</span>
                                        <span className="block text-xs text-muted-foreground">
                                            {action.help}
                                        </span>
                                    </span>
                                </button>
                            ))}
                        </div>
                    </div>

                    <div className="flex items-center justify-between gap-3 rounded-md border border-border p-2.5 text-sm">
                        <span className="flex items-center gap-1.5 font-medium">
                            <ShieldCheck className="size-4 text-primary" />
                            {t("integrations.dialog.enable", { name: "VirusTotal" })}
                        </span>
                        <Switch
                            checked={enabled}
                            onChange={setEnabled}
                            aria-label={t("integrations.dialog.enable", { name: "VirusTotal" })}
                        />
                    </div>

                    {error ? <p className="text-sm text-danger">{error}</p> : null}

                    <div className="flex justify-end gap-2">
                        <Button type="button" variant="ghost" onClick={onClose}>
                            {tc("actions.cancel")}
                        </Button>
                        <Button type="button" onClick={onSave} disabled={saving}>
                            {saving ? <Loader2 className="size-4 animate-spin" /> : tc("actions.save")}
                        </Button>
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    );
}
