"use client";

/**
 * Sign in with a subscription instead of pasting a key: SuperGrok, GitHub
 * Copilot, GitLab Duo and an OpenCode Console account (Zen or Go, whose Go
 * allowance is shown here once signed in), plus a pointer for Poe, whose sign-in cannot return
 * to a self-hosted server. What a login ends with is an ordinary key row in the
 * table below, named after the subscription.
 */

import { useRouter } from "next/navigation";
import { createContext, useContext, useEffect, useRef, useState } from "react";
import { ExternalLink, Loader2, RefreshCw } from "lucide-react";
import {
    Button,
    Card,
    CardBody,
    CardHeader,
    CardTitle,
    CopyButton,
    Dialog,
    DialogContent,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Input
} from "@polaris/ui";
import { runAction } from "@/lib/run-action";
import { IntegrationLogo } from "@/components/logos";
import { useHubFlow, type ConnectionOption } from "./connection-hub";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { useDisplayFormat } from "@/components/display-format";
import type { GoUsageRow } from "@/lib/agents/go-usage";
import type { LoginStart, LoginState, ProviderLogin } from "@/lib/agents/provider-logins";
import {
    GITLAB_CLIENT_ID_PATTERN,
    copilotDomain,
    gitlabInstanceUrl,
    type GitlabInstance
} from "@/lib/agents/login-instances";
import type * as loginActions from "@/app/(app)/polar/settings/providers/login-actions";

const LOGINS: readonly { provider: ProviderLogin; name: string }[] = [
    { provider: "xai", name: "SuperGrok" }, // i18n-ignore: product name
    { provider: "github-copilot", name: "GitHub Copilot" }, // i18n-ignore: product name
    { provider: "gitlab", name: "GitLab Duo" }, // i18n-ignore: product name
    { provider: "opencode", name: "OpenCode Zen" }, // i18n-ignore: product name
    { provider: "opencode-go", name: "OpenCode Go" } // i18n-ignore: product name
];

/** The one return address GitLab's application must be registered with. */
const GITLAB_RETURN = "http://127.0.0.1:8080/callback"; // i18n-ignore: address

const POE_DOCS = "https://creator.poe.com/docs/external-applications/openai-compatible-api";

type Ended = Exclude<LoginState, { state: "pending" }>;

/** What Add connection lists for these: a sign-in each, grouped with the
 *  provider whose slug it signs in to. */
const LOGIN_OPTIONS: readonly ConnectionOption[] = LOGINS.map((login) => ({
    method: "login",
    slug: login.provider,
    name: login.name,
    vendor: login.name
}));

/**
 * The server actions a login runs through: an account's own, or the
 * deployment's on Management. Handed in by the page, so one set of screens
 * serves both and each owner's actions check their own permission.
 */
export interface ProviderLoginActions {
    startProviderLoginAction: typeof loginActions.startProviderLoginAction;
    pollProviderLoginAction: typeof loginActions.pollProviderLoginAction;
    finishGitlabLoginAction: typeof loginActions.finishGitlabLoginAction;
    goUsageAction: typeof loginActions.goUsageAction;
}

const ProviderLoginActionsContext = createContext<ProviderLoginActions | null>(null);

function useProviderLoginActions(): ProviderLoginActions {
    const actions = useContext(ProviderLoginActionsContext);
    if (!actions) throw new Error("ProviderLogins draws its parts");
    return actions;
}

export function ProviderLogins({ actions }: { actions: ProviderLoginActions }) {
    return (
        <ProviderLoginActionsContext.Provider value={actions}>
            <ProviderLoginsBody />
        </ProviderLoginActionsContext.Provider>
    );
}

function ProviderLoginsBody() {
    const t = useTranslations("account");
    const [open, setOpen] = useState<ProviderLogin | null>(null);
    // Inside a connection hub, Add connection opens these. What stays is the Go
    // allowance, which is a reading of a sign-in already made, not a way in.
    const inHub = useHubFlow(
        "login",
        (slug) => {
            const login = LOGINS.find((one) => one.provider === slug);
            if (login) setOpen(login.provider);
        },
        LOGIN_OPTIONS
    );
    const dialog = open ? (
        <LoginDialog
            provider={open}
            name={LOGINS.find((login) => login.provider === open)?.name ?? open}
            onClose={() => setOpen(null)}
        />
    ) : null;
    if (inHub)
        return (
            <>
                <GoUsageList />
                {dialog}
            </>
        );
    return (
        <Card>
            <CardHeader>
                <CardTitle>{t("aiKeys.logins.title")}</CardTitle>
                <p className="text-muted-foreground text-xs">{t("aiKeys.logins.hint")}</p>
            </CardHeader>
            <CardBody className="flex flex-col gap-2">
                <div className="flex flex-wrap gap-2">
                    {LOGINS.map((login) => (
                        <Button key={login.provider} size="sm" variant="outline" onClick={() => setOpen(login.provider)}>
                            <IntegrationLogo slug={login.provider} name={login.name} className="size-4 shrink-0" />
                            {t("aiKeys.logins.signIn", { name: login.name })}
                        </Button>
                    ))}
                </div>
                <GoUsageList />
                <p className="text-muted-foreground text-xs">
                    {t("aiKeys.logins.poe")}{" "}
                    <a className="underline" href={POE_DOCS} target="_blank" rel="noreferrer noopener">
                        {t("aiKeys.logins.poeLink")}
                    </a>
                </p>
            </CardBody>
            {dialog}
        </Card>
    );
}

const METERS = ["rolling", "weekly", "monthly"] as const;

/**
 * Each Console sign-in's Go allowance: how much is used and when it starts
 * over, read when the card opens and on request (the server keeps a reading
 * for a minute). Renders nothing for somebody with no Console sign-in.
 */
function GoUsageList() {
    const { goUsageAction } = useProviderLoginActions();
    const t = useTranslations("account");
    const format = useDisplayFormat();
    const [rows, setRows] = useState<GoUsageRow[] | null>(null);
    const [loading, setLoading] = useState(true);
    const load = () => {
        setLoading(true);
        void goUsageAction()
            .then(setRows)
            .catch(() => setRows((current) => current ?? []))
            .finally(() => setLoading(false));
    };
    useEffect(load, []);
    if (!rows || rows.length === 0) return null;
    return (
        <div className="flex flex-col gap-2 border-t pt-2">
            <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-medium">{t("aiKeys.logins.go.title")}</p>
                <Button
                    size="sm"
                    variant="ghost"
                    onClick={load}
                    disabled={loading}
                    aria-label={t("aiKeys.logins.go.refresh")}
                >
                    <RefreshCw className={loading ? "size-4 shrink-0 animate-spin" : "size-4 shrink-0"} />
                </Button>
            </div>
            {rows.map((row) => {
                const label = row.workspace ? `${row.name} - ${row.workspace}` : row.name;
                return (
                    <div key={row.keyId} className="flex min-w-0 flex-col gap-1">
                        <p className="truncate text-xs font-medium" title={label}>
                            {label}
                        </p>
                        {row.failed ? (
                            <p className="text-muted-foreground text-xs">{t("aiKeys.logins.go.failed")}</p>
                        ) : !row.usage ? (
                            <p className="text-muted-foreground text-xs">{t("aiKeys.logins.go.none")}</p>
                        ) : (
                            <ul className="grid gap-2 sm:grid-cols-3">
                                {METERS.map((name) => {
                                    const meter = row.usage![name];
                                    const used = Math.min(100, Math.max(0, Math.round(meter.percent)));
                                    return (
                                        <li key={name} className="flex min-w-0 flex-col gap-0.5 text-xs">
                                            <span className="flex justify-between gap-2">
                                                <span className="truncate">{t(`aiKeys.logins.go.${name}`)}</span>
                                                <span className={meter.limited ? "text-destructive shrink-0" : "shrink-0"}>
                                                    {t("aiKeys.logins.go.used", { percent: used })}
                                                </span>
                                            </span>
                                            <span
                                                className="bg-muted block h-1.5 overflow-hidden rounded-full"
                                                role="meter"
                                                aria-valuemin={0}
                                                aria-valuemax={100}
                                                aria-valuenow={used}
                                                aria-label={t(`aiKeys.logins.go.${name}`)}
                                            >
                                                <span
                                                    className={meter.limited ? "bg-destructive block h-full" : "bg-primary block h-full"}
                                                    style={{ width: `${used}%` }}
                                                />
                                            </span>
                                            <span className="text-muted-foreground truncate">
                                                {t("aiKeys.logins.go.resets", { when: format.dateTime(meter.resetsAt) })}
                                            </span>
                                        </li>
                                    );
                                })}
                            </ul>
                        )}
                    </div>
                );
            })}
        </div>
    );
}

function LoginDialog({ provider, name, onClose }: { provider: ProviderLogin; name: string; onClose: () => void }) {
    const { startProviderLoginAction, pollProviderLoginAction, finishGitlabLoginAction } = useProviderLoginActions();
    const t = useTranslations("account");
    const router = useRouter();
    const [start, setStart] = useState<LoginStart | null>(null);
    const [ended, setEnded] = useState<Ended | null>(null);
    const [pasted, setPasted] = useState("");
    const [busy, setBusy] = useState(false);
    const [pastedError, setPastedError] = useState(false);
    // A self-managed GitLab or a GitHub Enterprise domain: null is the
    // vendor's public one; `asking` shows its form.
    const [instance, setInstance] = useState<GitlabInstance | null>(null);
    const [domain, setDomain] = useState<string | null>(null);
    const [asking, setAsking] = useState(false);
    const started = useRef(false);

    /** Starts a login, on the instance or domain given or the vendor's own. */
    const begin = (on: GitlabInstance | null, enterprise: string | null = null) => {
        setStart(null);
        setEnded(null);
        setPasted("");
        setPastedError(false);
        void runAction(
            () =>
                startProviderLoginAction(
                    on
                        ? { provider: "gitlab" as const, gitlab: on }
                        : enterprise
                          ? { provider: "github-copilot" as const, copilotDomain: enterprise }
                          : provider
                ),
            () => setEnded({ state: "failed" })
        ).then((answer) => {
            if (!answer) return;
            if ("error" in answer) setEnded({ state: "failed" });
            else setStart(answer);
        });
    };

    useEffect(() => {
        if (started.current) return;
        started.current = true;
        begin(null);
        // eslint-disable-next-line react-hooks/exhaustive-deps -- once, on open
    }, [provider]);

    // A device login is checked every two seconds; the server asks the vendor
    // only as often as the vendor allows.
    useEffect(() => {
        if (!start || start.paste || ended) return;
        const timer = setInterval(() => {
            void pollProviderLoginAction(start.id)
                .then((state) => {
                    if (state.state === "pending") return;
                    setEnded(state);
                    if (state.state === "done") router.refresh();
                })
                .catch(() => undefined);
        }, 2000);
        return () => clearInterval(timer);
    }, [start, ended, router]);

    const submitPaste = async () => {
        if (!start) return;
        setBusy(true);
        const state = await runAction(
            () => finishGitlabLoginAction({ id: start.id, pasted }),
            () => setEnded({ state: "failed" })
        );
        setBusy(false);
        if (!state || state.state === "pending") return;
        if (state.state === "bad-paste") {
            setEnded(null);
            setPasted("");
            return setPastedError(true);
        }
        setEnded(state);
        if (state.state === "done") router.refresh();
    };
    return (
        <Dialog open onOpenChange={(next) => (next ? undefined : onClose())}>
            <DialogContent className="w-[min(32rem,96vw)] max-w-[min(32rem,96vw)]">
                <DialogHeader>
                    <DialogTitle>{t("aiKeys.logins.signIn", { name })}</DialogTitle>
                </DialogHeader>
                <div className="flex min-w-0 flex-col gap-3 text-sm">
                    {asking && provider === "github-copilot" ? (
                        <CopilotDomainForm
                            initial={domain}
                            onCancel={() => setAsking(false)}
                            onUse={(next) => {
                                setAsking(false);
                                setDomain(next);
                                begin(null, next);
                            }}
                        />
                    ) : asking ? (
                        <GitlabInstanceForm
                            initial={instance}
                            onCancel={() => setAsking(false)}
                            onUse={(next) => {
                                setAsking(false);
                                setInstance(next);
                                begin(next);
                            }}
                        />
                    ) : ended ? (
                        <p role="status">{endedText(t, ended)}</p>
                    ) : !start ? (
                        <p className="text-muted-foreground flex items-center gap-2">
                            <Loader2 className="size-4 shrink-0 animate-spin" />
                            {t("aiKeys.logins.starting")}
                        </p>
                    ) : (
                        <>
                            <p>{start.paste ? t("aiKeys.logins.gitlabStep") : t("aiKeys.logins.deviceStep")}</p>
                            {start.userCode ? (
                                <div className="flex items-center gap-2">
                                    <code className="bg-muted rounded px-2 py-1 font-mono text-base tracking-widest">
                                        {start.userCode}
                                    </code>
                                    <CopyButton value={start.userCode} />
                                </div>
                            ) : null}
                            <Button asChild size="sm" className="self-start">
                                <a href={start.url} target="_blank" rel="noreferrer noopener">
                                    <ExternalLink className="size-4 shrink-0" />
                                    {t("aiKeys.logins.open", { name })}
                                </a>
                            </Button>
                            {start.paste ? (
                                <div className="flex flex-col gap-1">
                                    <Input
                                        value={pasted}
                                        onChange={(event) => {
                                            setPasted(event.target.value);
                                            setPastedError(false);
                                        }}
                                        placeholder="http://127.0.0.1:8080/callback?code=..." // i18n-ignore: address shape
                                        aria-label={t("aiKeys.logins.pasteLabel")}
                                        aria-invalid={pastedError || undefined}
                                    />
                                    {pastedError ? (
                                        <p className="text-destructive text-xs">{t("aiKeys.logins.badPaste")}</p>
                                    ) : null}
                                    <p className="text-muted-foreground flex min-w-0 flex-wrap items-center gap-x-2 text-xs">
                                        <span className="min-w-0 truncate" title={instance?.url}>
                                            {instance
                                                ? t("aiKeys.logins.gitlab.on", { host: new URL(instance.url).host })
                                                : t("aiKeys.logins.gitlab.onCom")}
                                        </span>
                                        <button type="button" className="shrink-0 underline" onClick={() => setAsking(true)}>
                                            {instance ? t("aiKeys.logins.gitlab.change") : t("aiKeys.logins.gitlab.selfManaged")}
                                        </button>
                                        {instance ? (
                                            <button
                                                type="button"
                                                className="shrink-0 underline"
                                                onClick={() => {
                                                    setInstance(null);
                                                    begin(null);
                                                }}
                                            >
                                                {t("aiKeys.logins.gitlab.useCom")}
                                            </button>
                                        ) : null}
                                    </p>
                                </div>
                            ) : (
                                <>
                                    <p className="text-muted-foreground flex items-center gap-2 text-xs">
                                        <Loader2 className="size-3 shrink-0 animate-spin" />
                                        {t("aiKeys.logins.waiting")}
                                    </p>
                                    {provider === "github-copilot" ? (
                                        <p className="text-muted-foreground flex min-w-0 flex-wrap items-center gap-x-2 text-xs">
                                            <span className="min-w-0 truncate" title={domain ?? undefined}>
                                                {domain
                                                    ? t("aiKeys.logins.copilot.on", { domain })
                                                    : t("aiKeys.logins.copilot.onCom")}
                                            </span>
                                            <button type="button" className="shrink-0 underline" onClick={() => setAsking(true)}>
                                                {domain ? t("aiKeys.logins.copilot.change") : t("aiKeys.logins.copilot.enterprise")}
                                            </button>
                                            {domain ? (
                                                <button
                                                    type="button"
                                                    className="shrink-0 underline"
                                                    onClick={() => {
                                                        setDomain(null);
                                                        begin(null);
                                                    }}
                                                >
                                                    {t("aiKeys.logins.copilot.useCom")}
                                                </button>
                                            ) : null}
                                        </p>
                                    ) : null}
                                </>
                            )}
                        </>
                    )}
                </div>
                <DialogFooter>
                    {start?.paste && !ended && !asking ? (
                        <Button size="sm" onClick={submitPaste} disabled={busy || pasted.trim() === ""}>
                            {busy ? <Loader2 className="size-4 shrink-0 animate-spin" /> : null}
                            {t("aiKeys.logins.finish")}
                        </Button>
                    ) : null}
                    <Button size="sm" variant="outline" onClick={onClose}>
                        {ended?.state === "done" ? t("aiKeys.logins.close") : t("aiKeys.logins.cancel")}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

/**
 * A self-managed GitLab: its address, and the ID of the OAuth application its
 * owner registered there with the return address above. Checked as typed with
 * the rules the server applies; an empty field is incomplete, not wrong.
 */
function GitlabInstanceForm({
    initial,
    onUse,
    onCancel
}: {
    initial: GitlabInstance | null;
    onUse: (instance: GitlabInstance) => void;
    onCancel: () => void;
}) {
    const t = useTranslations("account");
    const [address, setAddress] = useState(initial?.url ?? "");
    const [clientId, setClientId] = useState(initial?.clientId ?? "");
    const url = gitlabInstanceUrl(address);
    const id = clientId.trim();
    const idOk = GITLAB_CLIENT_ID_PATTERN.test(id);
    const ready = url !== null && idOk;
    return (
        <form
            className="flex min-w-0 flex-col gap-3"
            onSubmit={(event) => {
                event.preventDefault();
                if (url && idOk) onUse({ url, clientId: id });
            }}
        >
            <p>{t("aiKeys.logins.gitlab.intro")}</p>
            <div className="bg-muted/50 flex min-w-0 flex-col gap-1 rounded-md p-2 text-xs">
                <span className="text-muted-foreground">{t("aiKeys.logins.gitlab.register")}</span>
                <span className="flex min-w-0 items-center gap-2">
                    <code className="min-w-0 truncate font-mono" title={GITLAB_RETURN}>
                        {GITLAB_RETURN}
                    </code>
                    <CopyButton value={GITLAB_RETURN} />
                </span>
            </div>
            <label className="flex min-w-0 flex-col gap-1">
                <span className="text-xs font-medium">{t("aiKeys.logins.gitlab.address")} *</span>
                <Input
                    value={address}
                    onChange={(event) => setAddress(event.target.value)}
                    placeholder="https://gitlab.example.com" // i18n-ignore: address shape
                    inputMode="url"
                    autoComplete="url"
                    aria-invalid={(address.trim() !== "" && url === null) || undefined}
                />
                {address.trim() !== "" && url === null ? (
                    <span className="text-destructive text-xs">{t("aiKeys.logins.gitlab.badAddress")}</span>
                ) : null}
            </label>
            <label className="flex min-w-0 flex-col gap-1">
                <span className="text-xs font-medium">{t("aiKeys.logins.gitlab.clientId")} *</span>
                <Input
                    value={clientId}
                    onChange={(event) => setClientId(event.target.value)}
                    autoComplete="off"
                    spellCheck={false}
                    className="font-mono"
                    aria-invalid={(id !== "" && !idOk) || undefined}
                />
                {id !== "" && !idOk ? (
                    <span className="text-destructive text-xs">{t("aiKeys.logins.gitlab.badClientId")}</span>
                ) : null}
            </label>
            <div className="flex flex-wrap justify-end gap-2">
                <Button type="button" size="sm" variant="outline" onClick={onCancel}>
                    {t("aiKeys.logins.gitlab.back")}
                </Button>
                <Button type="submit" size="sm" disabled={!ready}>
                    {t("aiKeys.logins.gitlab.use")}
                </Button>
            </div>
        </form>
    );
}

/** A GitHub Enterprise domain for Copilot, checked as typed with the rules the
 *  server applies; an empty field is incomplete, not wrong. */
function CopilotDomainForm({
    initial,
    onUse,
    onCancel
}: {
    initial: string | null;
    onUse: (domain: string) => void;
    onCancel: () => void;
}) {
    const t = useTranslations("account");
    const [typed, setTyped] = useState(initial ?? "");
    const domain = copilotDomain(typed);
    const wrong = typed.trim() !== "" && domain === null;
    return (
        <form
            className="flex min-w-0 flex-col gap-3"
            onSubmit={(event) => {
                event.preventDefault();
                if (domain) onUse(domain);
            }}
        >
            <p>{t("aiKeys.logins.copilot.intro")}</p>
            <label className="flex min-w-0 flex-col gap-1">
                <span className="text-xs font-medium">{t("aiKeys.logins.copilot.domain")} *</span>
                <Input
                    value={typed}
                    onChange={(event) => setTyped(event.target.value)}
                    placeholder="company.ghe.com" // i18n-ignore: domain shape
                    inputMode="url"
                    autoComplete="off"
                    spellCheck={false}
                    aria-invalid={wrong || undefined}
                />
                {wrong ? <span className="text-destructive text-xs">{t("aiKeys.logins.copilot.badDomain")}</span> : null}
            </label>
            <div className="flex flex-wrap justify-end gap-2">
                <Button type="button" size="sm" variant="outline" onClick={onCancel}>
                    {t("aiKeys.logins.gitlab.back")}
                </Button>
                <Button type="submit" size="sm" disabled={domain === null}>
                    {t("aiKeys.logins.gitlab.use")}
                </Button>
            </div>
        </form>
    );
}

function endedText(t: ReturnType<typeof useTranslations>, ended: Ended): string {
    switch (ended.state) {
        case "done":
            return t("aiKeys.logins.done");
        case "denied":
            return t("aiKeys.logins.denied");
        case "expired":
        case "gone":
            return t("aiKeys.logins.expired");
        case "no-copilot":
            return ended.canSignUp ? t("aiKeys.logins.noCopilotFree") : t("aiKeys.logins.noCopilot");
        case "no-duo":
            return t("aiKeys.logins.noDuo");
        default:
            return t("aiKeys.logins.failed");
    }
}
