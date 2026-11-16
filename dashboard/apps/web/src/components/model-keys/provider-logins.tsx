"use client";

/**
 * Sign in with a subscription instead of pasting a key: SuperGrok, GitHub
 * Copilot and GitLab Duo, plus a pointer for Poe, whose sign-in cannot return
 * to a self-hosted server. What a login ends with is an ordinary key row in the
 * table below, named after the subscription.
 */

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { ExternalLink, Loader2 } from "lucide-react";
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
import { useTranslations } from "@/components/i18n/i18n-provider";
import type { LoginStart, LoginState, ProviderLogin } from "@/lib/agents/provider-logins";
import {
    finishGitlabLoginAction,
    pollProviderLoginAction,
    startProviderLoginAction
} from "@/app/(app)/account/ai-keys/login-actions";

const LOGINS: readonly { provider: ProviderLogin; name: string }[] = [
    { provider: "xai", name: "SuperGrok" }, // i18n-ignore: product name
    { provider: "github-copilot", name: "GitHub Copilot" }, // i18n-ignore: product name
    { provider: "gitlab", name: "GitLab Duo" } // i18n-ignore: product name
];

const POE_DOCS = "https://creator.poe.com/docs/external-applications/openai-compatible-api";

type Ended = Exclude<LoginState, { state: "pending" }>;

export function ProviderLogins() {
    const t = useTranslations("account");
    const [open, setOpen] = useState<ProviderLogin | null>(null);
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
                <p className="text-muted-foreground text-xs">
                    {t("aiKeys.logins.poe")}{" "}
                    <a className="underline" href={POE_DOCS} target="_blank" rel="noreferrer noopener">
                        {t("aiKeys.logins.poeLink")}
                    </a>
                </p>
            </CardBody>
            {open ? (
                <LoginDialog
                    provider={open}
                    name={LOGINS.find((login) => login.provider === open)?.name ?? open}
                    onClose={() => setOpen(null)}
                />
            ) : null}
        </Card>
    );
}

function LoginDialog({ provider, name, onClose }: { provider: ProviderLogin; name: string; onClose: () => void }) {
    const t = useTranslations("account");
    const router = useRouter();
    const [start, setStart] = useState<LoginStart | null>(null);
    const [ended, setEnded] = useState<Ended | null>(null);
    const [pasted, setPasted] = useState("");
    const [busy, setBusy] = useState(false);
    const [pastedError, setPastedError] = useState(false);
    const started = useRef(false);

    useEffect(() => {
        if (started.current) return;
        started.current = true;
        void runAction(
            () => startProviderLoginAction(provider),
            () => setEnded({ state: "failed" })
        ).then((answer) => {
            if (!answer) return;
            if ("error" in answer) setEnded({ state: "failed" });
            else setStart(answer);
        });
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
                    {ended ? (
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
                                    <p className="text-muted-foreground text-xs">{t("aiKeys.logins.gitlabSelfManaged")}</p>
                                </div>
                            ) : (
                                <p className="text-muted-foreground flex items-center gap-2 text-xs">
                                    <Loader2 className="size-3 shrink-0 animate-spin" />
                                    {t("aiKeys.logins.waiting")}
                                </p>
                            )}
                        </>
                    )}
                </div>
                <DialogFooter>
                    {start?.paste && !ended ? (
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
