"use client";

/**
 * Connecting a mailbox.
 *
 * The flow is one field long for nearly everybody: type the address, and Polaris
 * works out where its mail lives. What happens next depends only on what it
 * found.
 *
 * - **A service that can be authorized** (Gmail, Outlook): a Connect button, and
 *   no password is ever typed. If the account is already linked here for
 *   something else, it is offered directly.
 * - **A service that needs a password**: one password field, with the sentence
 *   that service's own support page would have said - "Google refuses your
 *   ordinary password here", "Yahoo needs an app password" - because that is the
 *   single most common reason a correct password is refused.
 * - **Anything else**: the servers Polaris found, filled in and editable. The
 *   fields are shown rather than hidden behind "advanced": somebody who got here
 *   is somebody whose domain answered nothing, and hiding the fields from them
 *   would be hiding the only thing left to try.
 *
 * Nothing is stored until both servers have accepted the credential, so a
 * mistyped password fails on this form rather than as a mailbox that silently
 * never syncs.
 */

import { refusalOf } from "@/app/(app)/mail/refusal";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import type { MailDiscovery } from "@/lib/mailbox/autoconfig";
import type { MailAccountView } from "@/lib/mailbox/accounts";
import { AlertTriangle, CheckCircle2, Loader2, Mail, Plus, RefreshCw, Trash2 } from "lucide-react";
import {
    addAccountAction,
    discoverAction,
    editAccountAction,
    removeAccountAction,
    syncAccountAction
} from "@/app/(app)/mail/actions";
import {
    Button,
    ConfirmDeleteDialog,
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    Input,
    Select,
    Switch,
    cn,
    useToast
} from "@polaris/ui";

interface LinkedAccount {
    readonly id: string;
    readonly provider: string;
    readonly label: string;
    /** Whether it has been granted what a mailbox needs, rather than only what a
     *  calendar needs. */
    readonly readyForMail: boolean;
}

export function AccountsView({
    accounts,
    links,
    googleReady,
    microsoftReady,
    outcome,
    outcomeProvider
}: {
    accounts: MailAccountView[];
    links: LinkedAccount[];
    googleReady: boolean;
    microsoftReady: boolean;
    outcome: string;
    outcomeProvider: string;
}) {
    const [adding, setAdding] = useState(false);

    return (
        <div className="space-y-4">
            {outcome === "linked" ? (
                <p className="rounded-md border border-border bg-card px-3 py-2 text-[13px] text-muted-foreground">
                    {outcomeProvider === "microsoft" ? "Microsoft" : "Google"} account authorized. Add the
                    mailbox below and it will be offered without a password.
                </p>
            ) : null}
            {outcome && outcome !== "linked" ? (
                <p className="rounded-md border border-danger/40 bg-card px-3 py-2 text-[13px] text-danger">
                    That authorization did not finish. Nothing was changed.
                </p>
            ) : null}

            <div className="flex items-center justify-between">
                <div>
                    <h2 className="text-[15px] font-semibold tracking-tight">Your mailboxes</h2>
                    <p className="text-[13px] text-muted-foreground">
                        Connect as many as you like. They share one inbox and each keeps its own colour.
                    </p>
                </div>
                <Button onClick={() => setAdding(true)}>
                    <Plus className="size-4 shrink-0" aria-hidden />
                    Add a mailbox
                </Button>
            </div>

            {accounts.length === 0 ? (
                <div className="rounded-md border border-dashed border-border px-4 py-8 text-center">
                    <Mail className="mx-auto size-5 shrink-0 text-foreground-subtle" aria-hidden />
                    <p className="mt-2 text-[13px] font-medium">No mailboxes yet</p>
                    <p className="mt-1 text-[13px] text-muted-foreground">
                        Connect one and your mail is read here instead of in somebody else&apos;s browser tab.
                    </p>
                </div>
            ) : (
                <ul className="space-y-2">
                    {accounts.map((account) => (
                        <AccountRow key={account.id} account={account} />
                    ))}
                </ul>
            )}

            {adding ? (
                <AddMailboxDialog
                    links={links}
                    googleReady={googleReady}
                    microsoftReady={microsoftReady}
                    onClose={() => setAdding(false)}
                />
            ) : null}
        </div>
    );
}

function AccountRow({ account }: { account: MailAccountView }) {
    const router = useRouter();
    const toast = useToast();
    const [busy, startBusy] = useTransition();
    const [removing, setRemoving] = useState(false);
    const [unified, setUnified] = useState(account.unified);

    const broken = account.state === "auth" || account.state === "unreachable";

    return (
        <li className="rounded-md border border-border bg-card px-3 py-2.5">
            <div className="flex flex-wrap items-center gap-3">
                <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-2 text-[13px] font-medium">
                        <span className="min-w-0 truncate" title={account.label || account.address}>
                            {account.label || account.address}
                        </span>
                        {account.serviceName ? (
                            <span className="shrink-0 rounded bg-surface px-1.5 py-0.5 text-[11px] text-muted-foreground">
                                {account.serviceName}
                            </span>
                        ) : null}
                        {account.auth === "oauth" ? (
                            <span className="shrink-0 rounded bg-surface px-1.5 py-0.5 text-[11px] text-muted-foreground">
                                Authorized
                            </span>
                        ) : null}
                    </p>
                    <p className="truncate text-[12px] text-muted-foreground" title={account.address}>{account.address}</p>
                    <p
                        className={cn(
                            "mt-0.5 flex items-center gap-1.5 text-[12px]",
                            broken ? "text-danger" : "text-foreground-subtle"
                        )}
                    >
                        {broken ? (
                            <AlertTriangle className="size-3.5 shrink-0" aria-hidden />
                        ) : (
                            <CheckCircle2 className="size-3.5 shrink-0" aria-hidden />
                        )}
                        {stateSentence(account)}
                    </p>
                </div>

                <label className="flex shrink-0 items-center gap-2 text-[12px] text-muted-foreground">
                    <Switch
                        checked={unified}
                        onChange={(next) => {
                            setUnified(next);
                            startBusy(async () => {
                                const answer = await editAccountAction(account.id, {
                                    displayName: account.displayName,
                                    label: account.label,
                                    color: account.color,
                                    notify: account.notify,
                                    pollSeconds: account.pollSeconds,
                                    unified: next,
                                    appendToSent: account.appendToSent,
                                    signature: account.signature,
                                    signatureAboveQuote: account.signatureAboveQuote
                                });
                                const said = refusalOf(answer);
                                if (said) {
                                    setUnified(!next);
                                    toast.show({ title: said });
                                    return;
                                }
                                router.refresh();
                            });
                        }}
                        aria-label="Include this mailbox in the shared inbox"
                    />
                    In the shared inbox
                </label>

                <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Check this mailbox now"
                    title="Check this mailbox now"
                    disabled={busy}
                    onClick={() =>
                        startBusy(async () => {
                            const answer = await syncAccountAction(account.id);
                            const said = refusalOf(answer);
                            if (said) toast.show({ title: said });
                            router.refresh();
                        })
                    }
                >
                    <RefreshCw className={cn("size-4 shrink-0", busy && "animate-spin")} aria-hidden />
                </Button>
                <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Remove this mailbox"
                    title="Remove this mailbox"
                    onClick={() => setRemoving(true)}
                >
                    <Trash2 className="size-4 shrink-0" aria-hidden />
                </Button>
            </div>

            {removing ? (
                <ConfirmDeleteDialog
                    open
                    onOpenChange={(next) => setRemoving(next)}
                    name={account.address}
                    kind="mailbox"
                    // One row of several and nothing inside it is lost, so a
                    // plain confirmation rather than typing the address out.
                    requireTyping={false}
                    title={`Remove ${account.address}?`}
                    // Said plainly, because "remove mailbox" reads as "delete my
                    // mail" to anybody who has not thought about where it lives.
                    description="Polaris stops checking this mailbox and forgets the copy it keeps. Nothing on the mail server is touched, and your mail stays exactly where it is."
                    confirmLabel="Remove it"
                    onConfirm={async () => {
                        const answer = await removeAccountAction(account.id);
                        const said = refusalOf(answer);
                        if (said) {
                            toast.show({ title: said });
                            return;
                        }
                        toast.show({ title: `${account.address} is no longer connected.` });
                        router.refresh();
                    }}
                />
            ) : null}
        </li>
    );
}

function stateSentence(account: MailAccountView): string {
    if (account.state === "auth") {
        return account.stateDetail || "This mailbox needs connecting again.";
    }
    if (account.state === "unreachable") return "Polaris cannot reach this mail server.";
    if (account.state === "never") return "Waiting for its first check.";
    return account.lastSyncAt ? "Checked recently." : "Connected.";
}

/* -------------------------------------------------------------------------- */
/* Adding one                                                                  */
/* -------------------------------------------------------------------------- */

type Step = "address" | "authorize" | "password" | "servers";

function AddMailboxDialog({
    links,
    googleReady,
    microsoftReady,
    onClose
}: {
    links: LinkedAccount[];
    googleReady: boolean;
    microsoftReady: boolean;
    onClose: () => void;
}) {
    const router = useRouter();
    const toast = useToast();
    const [step, setStep] = useState<Step>("address");
    const [address, setAddress] = useState("");
    const [discovery, setDiscovery] = useState<MailDiscovery | null>(null);
    const [password, setPassword] = useState("");
    const [username, setUsername] = useState("");
    const [displayName, setDisplayName] = useState("");
    const [connectionId, setConnectionId] = useState("");
    const [imapHost, setImapHost] = useState("");
    const [imapPort, setImapPort] = useState("993");
    const [imapSecurity, setImapSecurity] = useState("tls");
    const [smtpHost, setSmtpHost] = useState("");
    const [smtpPort, setSmtpPort] = useState("465");
    const [smtpSecurity, setSmtpSecurity] = useState("tls");
    const [problem, setProblem] = useState("");
    const [working, startWorking] = useTransition();

    function fill(found: MailDiscovery): void {
        setDiscovery(found);
        setImapHost(found.imap.host);
        setImapPort(String(found.imap.port));
        setImapSecurity(found.imap.security);
        setSmtpHost(found.smtp.host);
        setSmtpPort(String(found.smtp.port));
        setSmtpSecurity(found.smtp.security);
        // Which of the three ways in this address gets. The authorized route is
        // only offered where the operator has connected the application - a
        // button that can only fail is worse than no button.
        const oauthReady = found.oauth === "google" ? googleReady : found.oauth === "microsoft" ? microsoftReady : false;
        setStep(found.oauth && oauthReady ? "authorize" : found.source === "none" ? "servers" : "password");
    }

    const usable = links.filter(
        (link) => link.provider === discovery?.oauth && link.readyForMail
    );

    return (
        <Dialog open onOpenChange={(next) => (next ? undefined : onClose())}>
            <DialogContent className="max-w-lg">
                <DialogHeader>
                    <DialogTitle>Add a mailbox</DialogTitle>
                </DialogHeader>

                <div className="space-y-3">
                    <label className="block">
                        <span className="mb-1 block text-[12px] text-muted-foreground">
                            Email address <span aria-hidden>*</span>
                        </span>
                        <Input
                            value={address}
                            autoFocus
                            placeholder="you@example.com"
                            onChange={(event) => {
                                setAddress(event.target.value);
                                setDiscovery(null);
                                setStep("address");
                                setProblem("");
                            }}
                        />
                    </label>

                    {step === "address" ? (
                        <Button
                            className="w-full"
                            disabled={working || !address.includes("@")}
                            onClick={() =>
                                startWorking(async () => {
                                    setProblem("");
                                    const form = new FormData();
                                    form.set("address", address);
                                    const answer = await discoverAction(form);
                                    const said = refusalOf(answer);
                                    if (said) {
                                        setProblem(said);
                                        return;
                                    }
                                    if ("discovery" in answer && answer.discovery) fill(answer.discovery);
                                })
                            }
                        >
                            {working ? <Loader2 className="size-4 shrink-0 animate-spin" aria-hidden /> : null}
                            Continue
                        </Button>
                    ) : null}

                    {discovery && step !== "address" ? (
                        <p className="text-[12px] text-muted-foreground">
                            {discovery.serviceName
                                ? `This looks like ${discovery.serviceName}.`
                                : "Polaris worked out these servers from the address."}
                        </p>
                    ) : null}

                    {step === "authorize" ? (
                        <div className="space-y-2">
                            {usable.length > 0 ? (
                                <>
                                    <label className="block">
                                        <span className="mb-1 block text-[12px] text-muted-foreground">
                                            Authorized account
                                        </span>
                                        <Select
                                            value={connectionId || usable[0]!.id}
                                            onValueChange={setConnectionId}
                                            options={usable.map((link) => ({ value: link.id, label: link.label }))}
                                            aria-label="The authorized account this mailbox belongs to"
                                        />
                                    </label>
                                    <Button
                                        className="w-full"
                                        disabled={working}
                                        onClick={() =>
                                            startWorking(async () => {
                                                setProblem("");
                                                const answer = await addAccountAction({
                                                    address,
                                                    displayName,
                                                    label: "",
                                                    auth: "oauth",
                                                    connectionId: connectionId || usable[0]!.id,
                                                    username: "",
                                                    provider: discovery?.service ?? "",
                                                    imap: {
                                                        host: imapHost,
                                                        port: Number(imapPort),
                                                        security: imapSecurity
                                                    },
                                                    smtp: {
                                                        host: smtpHost,
                                                        port: Number(smtpPort),
                                                        security: smtpSecurity
                                                    }
                                                });
                                                const said = refusalOf(answer);
                                                if (said) {
                                                    setProblem(said);
                                                    return;
                                                }
                                                toast.show({ title: `${address} is connected. Its mail is on its way.` });
                                                router.refresh();
                                                onClose();
                                            })
                                        }
                                    >
                                        Connect {address}
                                    </Button>
                                </>
                            ) : (
                                <>
                                    <p className="text-[13px] text-muted-foreground">
                                        {discovery?.serviceName} can authorize this without a password. You will be
                                        sent to their sign-in and back here.
                                    </p>
                                    <Button asChild className="w-full">
                                        <a href={`/api/connections/${discovery?.oauth}/link?scope=mail`}>
                                            Authorize {discovery?.serviceName}
                                        </a>
                                    </Button>
                                </>
                            )}
                            <button
                                type="button"
                                className="text-[12px] text-muted-foreground underline hover:text-foreground"
                                onClick={() => setStep("password")}
                            >
                                Use a password instead
                            </button>
                        </div>
                    ) : null}

                    {step === "password" || step === "servers" ? (
                        <div className="space-y-3">
                            <label className="block">
                                <span className="mb-1 block text-[12px] text-muted-foreground">
                                    Password <span aria-hidden>*</span>
                                </span>
                                <Input
                                    type="password"
                                    value={password}
                                    onChange={(event) => setPassword(event.target.value)}
                                />
                                {discovery?.passwordHelp ? (
                                    <span className="mt-1 block text-[12px] text-foreground-subtle">
                                        {discovery.passwordHelp}{" "}
                                        {discovery.passwordUrl ? (
                                            <a
                                                className="underline"
                                                href={discovery.passwordUrl}
                                                target="_blank"
                                                rel="noopener noreferrer"
                                            >
                                                Make one
                                            </a>
                                        ) : null}
                                    </span>
                                ) : null}
                            </label>

                            {step === "servers" ? (
                                <>
                                    <p className="text-[12px] text-foreground-subtle">
                                        Nothing at {address.split("@")[1]} said where its mail lives, so these are
                                        guesses. Change anything that is wrong.
                                    </p>
                                    <ServerFields
                                        legend="Incoming (IMAP)"
                                        host={imapHost}
                                        port={imapPort}
                                        security={imapSecurity}
                                        onHost={setImapHost}
                                        onPort={setImapPort}
                                        onSecurity={setImapSecurity}
                                    />
                                    <ServerFields
                                        legend="Outgoing (SMTP)"
                                        host={smtpHost}
                                        port={smtpPort}
                                        security={smtpSecurity}
                                        onHost={setSmtpHost}
                                        onPort={setSmtpPort}
                                        onSecurity={setSmtpSecurity}
                                    />
                                    <label className="block">
                                        <span className="mb-1 block text-[12px] text-muted-foreground">
                                            Login, if it is not the address
                                        </span>
                                        <Input value={username} onChange={(event) => setUsername(event.target.value)} />
                                    </label>
                                </>
                            ) : (
                                <button
                                    type="button"
                                    className="text-[12px] text-muted-foreground underline hover:text-foreground"
                                    onClick={() => setStep("servers")}
                                >
                                    Change the servers
                                </button>
                            )}

                            <label className="block">
                                <span className="mb-1 block text-[12px] text-muted-foreground">
                                    Your name, as people will see it
                                </span>
                                <Input
                                    value={displayName}
                                    onChange={(event) => setDisplayName(event.target.value)}
                                    placeholder="Left blank, your Polaris name is used"
                                />
                            </label>

                            <Button
                                className="w-full"
                                disabled={working || !password}
                                onClick={() =>
                                    startWorking(async () => {
                                        setProblem("");
                                        const answer = await addAccountAction({
                                            address,
                                            displayName,
                                            label: "",
                                            auth: "password",
                                            connectionId: null,
                                            password,
                                            username,
                                            provider: discovery?.service ?? "",
                                            imap: { host: imapHost, port: Number(imapPort), security: imapSecurity },
                                            smtp: { host: smtpHost, port: Number(smtpPort), security: smtpSecurity }
                                        });
                                        const said = refusalOf(answer);
                                        if (said) {
                                            setProblem(said);
                                            return;
                                        }
                                        toast.show({ title: `${address} is connected. Its mail is on its way.` });
                                        router.refresh();
                                        onClose();
                                    })
                                }
                            >
                                {working ? <Loader2 className="size-4 shrink-0 animate-spin" aria-hidden /> : null}
                                Connect this mailbox
                            </Button>
                        </div>
                    ) : null}

                    {problem ? <p className="text-[13px] text-danger">{problem}</p> : null}
                </div>
            </DialogContent>
        </Dialog>
    );
}

function ServerFields({
    legend,
    host,
    port,
    security,
    onHost,
    onPort,
    onSecurity
}: {
    legend: string;
    host: string;
    port: string;
    security: string;
    onHost: (next: string) => void;
    onPort: (next: string) => void;
    onSecurity: (next: string) => void;
}) {
    return (
        <fieldset className="space-y-2 rounded-md border border-border p-2">
            <legend className="px-1 text-[12px] text-muted-foreground">{legend}</legend>
            <div className="flex gap-2">
                <Input
                    className="flex-1"
                    value={host}
                    aria-label={`${legend} server`}
                    onChange={(event) => onHost(event.target.value)}
                />
                <Input
                    className="w-20"
                    value={port}
                    inputMode="numeric"
                    aria-label={`${legend} port`}
                    onChange={(event) => onPort(event.target.value)}
                />
            </div>
            <Select
                value={security}
                onValueChange={onSecurity}
                aria-label={`${legend} security`}
                options={[
                    { value: "tls", label: "TLS from the start" },
                    { value: "starttls", label: "Upgrade with STARTTLS" },
                    { value: "none", label: "No encryption (a bridge on this machine only)" }
                ]}
            />
        </fieldset>
    );
}
