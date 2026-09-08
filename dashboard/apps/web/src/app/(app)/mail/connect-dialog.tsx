"use client";

/**
 * Connecting a mailbox, in one dialog that fills itself in.
 *
 * There is no "next" step and no second screen. Somebody types their address;
 * the moment it IS an address, Polaris goes and finds out where its mail lives
 * and the rest of the form appears underneath, already answered. What they then
 * do depends only on what was found:
 *
 * - a service that can be authorized: one button, and no password is typed;
 * - a service that needs one: a password box, with the sentence that service's
 *   own support page would have said;
 * - a domain nobody could answer for: the same password box with the servers
 *   open beneath it, because somebody who got here has nothing else to try and
 *   hiding the fields from them would be hiding the only thing left.
 *
 * The lookup runs on the address settling rather than on a button, because the
 * button was the whole reason it felt like two screens. It is cancelled and
 * re-run as the address changes, and a stale answer is dropped rather than
 * filling the form in with the wrong servers.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { refusalOf } from "@/app/(app)/mail/refusal";
import type { MailDiscovery } from "@/lib/mailbox/autoconfig";
import { useEffect, useRef, useState, useTransition } from "react";
import { ChevronDown, Loader2 } from "lucide-react";
import { addAccountAction, discoverAction } from "@/app/(app)/mail/actions";
import { addressState } from "@/app/(app)/mail/address-state";
import {
    Button,
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    Input,
    Select,
    cn,
    useToast
} from "@polaris/ui";

/** An outside account somebody has already authorized here. */
export interface LinkedAccount {
    readonly id: string;
    readonly provider: string;
    readonly label: string;
    /** Whether it has been granted what a mailbox needs, rather than only what a
     *  calendar needs. */
    readonly readyForMail: boolean;
}

/** How long the address settles before Polaris goes looking. Long enough that
 *  typing a domain is one lookup rather than eight. */
const SETTLE_MS = 600;

export function ConnectMailboxDialog({
    links,
    googleReady,
    publicAddress,
    canSetDomain,
    microsoftReady,
    taken = [],
    onClose
}: {
    links: readonly LinkedAccount[];
    googleReady: boolean;
    /**
     * The addresses this person already has here.
     *
     * Held by the screen that opened this dialog, and until now never asked:
     * somebody retyping a mailbox they already had waited for a server lookup,
     * typed a password and pressed Connect before anything said so. The server
     * still decides - see `addAccount`, which refuses in the same words - this
     * only answers it before the rest of the form is filled in.
     */
    taken?: readonly string[];
    /** Whether this dashboard has an address a provider could return somebody
     *  to. Without one the authorize button is a dead end, so it is not drawn. */
    publicAddress: boolean;
    /** Whether the person looking can go and set that address themself. */
    canSetDomain: boolean;
    microsoftReady: boolean;
    onClose: () => void;
}) {
    const router = useRouter();
    const toast = useToast();

    const [address, setAddress] = useState("");
    const [discovery, setDiscovery] = useState<MailDiscovery | null>(null);
    const [looking, setLooking] = useState(false);
    const [password, setPassword] = useState("");
    const [username, setUsername] = useState("");
    const [displayName, setDisplayName] = useState("");
    const [connectionId, setConnectionId] = useState("");
    const [usePassword, setUsePassword] = useState(false);
    const [showServers, setShowServers] = useState(false);
    const [servers, setServers] = useState({
        imapHost: "",
        imapPort: "993",
        imapSecurity: "tls",
        smtpHost: "",
        smtpPort: "465",
        smtpSecurity: "tls"
    });
    const [problem, setProblem] = useState("");
    const [field, setField] = useState("");
    const [connecting, startConnecting] = useTransition();

    // Which lookup the answer on the wire belongs to. An address typed on top of
    // a slow lookup must not be filled in with the previous domain's servers.
    const wanted = useRef("");

    const state = addressState(address, taken);
    const valid = state === "ok" || state === "taken";
    /** Already here. Nothing else on this dialog applies: there are no servers
     *  worth looking up for a mailbox that is already connected. */
    const already = state === "taken";

    useEffect(() => {
        if (!valid || already) {
            setDiscovery(null);
            setLooking(false);
            return;
        }
        const asked = address.trim().toLowerCase();
        wanted.current = asked;
        setLooking(true);
        const timer = setTimeout(() => {
            void (async () => {
                const form = new FormData();
                form.set("address", asked);
                const answer = await discoverAction(form);
                if (wanted.current !== asked) return;
                setLooking(false);
                if (!("discovery" in answer) || !answer.discovery) return;
                const found = answer.discovery;
                setDiscovery(found);
                setServers({
                    imapHost: found.imap.host,
                    imapPort: String(found.imap.port),
                    imapSecurity: found.imap.security,
                    smtpHost: found.smtp.host,
                    smtpPort: String(found.smtp.port),
                    smtpSecurity: found.smtp.security
                });
                // Open the servers only when nobody could answer for the domain.
                // Everywhere else they are a detail behind a disclosure, because
                // filling them in is not this person's job.
                setShowServers(found.source === "none");
                setUsePassword(false);
            })();
        }, SETTLE_MS);
        return () => clearTimeout(timer);
    }, [address, valid, already]);

    const oauthReady =
        discovery?.oauth === "google" ? googleReady : discovery?.oauth === "microsoft" ? microsoftReady : false;
    const authorizable = Boolean(discovery?.oauth) && oauthReady && !usePassword;
    const usable = links.filter((link) => link.provider === discovery?.oauth && link.readyForMail);
    const chosenConnection = connectionId || usable[0]?.id || "";

    function connect(): void {
        if (!discovery) return;
        startConnecting(async () => {
            setProblem("");
            setField("");
            const answer = await addAccountAction({
                address,
                displayName,
                label: "",
                auth: authorizable ? "oauth" : "password",
                connectionId: authorizable ? chosenConnection : null,
                ...(authorizable ? {} : { password }),
                username,
                provider: discovery.service,
                imap: {
                    host: servers.imapHost,
                    port: Number(servers.imapPort),
                    security: servers.imapSecurity
                },
                smtp: {
                    host: servers.smtpHost,
                    port: Number(servers.smtpPort),
                    security: servers.smtpSecurity
                }
            });
            const said = refusalOf(answer);
            if (said) {
                setProblem(said);
                setField("field" in answer && typeof answer.field === "string" ? answer.field : "");
                // A refusal about the servers opens them, so the thing being
                // complained about is on screen.
                if (said.toLowerCase().includes("server")) setShowServers(true);
                return;
            }
            toast.show({ title: `${address} is connected. Its mail is on its way.` });
            router.refresh();
            onClose();
        });
    }

    const ready =
        valid && !already && Boolean(discovery) && (authorizable ? Boolean(chosenConnection) : password.length > 0);

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
                        <div className="relative">
                            <Input
                                value={address}
                                autoFocus
                                inputMode="email"
                                autoComplete="email"
                                placeholder="you@example.com"
                                aria-invalid={state === "invalid" || already ? true : undefined}
                                aria-describedby="mailbox-lookup"
                                onChange={(event) => {
                                    setAddress(event.target.value);
                                    setProblem("");
                                }}
                            />
                            {looking ? (
                                <Loader2
                                    className="absolute right-2 top-1/2 size-4 shrink-0 -translate-y-1/2 animate-spin text-foreground-subtle"
                                    aria-hidden
                                />
                            ) : null}
                        </div>
                        <span
                            id="mailbox-lookup"
                            className={cn(
                                "mt-1 block text-[12px]",
                                already ? "text-danger" : "text-foreground-subtle"
                            )}
                        >
                            {already
                                ? "That mailbox is already here. Open it from the rail, or remove it first to add it again."
                                : lookupSentence(address, valid, looking, discovery)}
                        </span>
                    </label>

                    {discovery && !looking ? (
                        <>
                            {authorizable ? (
                                <div className="space-y-2">
                                    {usable.length > 0 ? (
                                        <>
                                            <label className="block">
                                                <span className="mb-1 block text-[12px] text-muted-foreground">
                                                    Authorized account
                                                </span>
                                                <Select
                                                    value={chosenConnection}
                                                    onValueChange={setConnectionId}
                                                    options={usable.map((link) => ({
                                                        value: link.id,
                                                        label: link.label
                                                    }))}
                                                    aria-label="The authorized account this mailbox belongs to"
                                                />
                                            </label>
                                            <p className="text-[12px] text-foreground-subtle">
                                                No password is stored. Polaris uses the account you already
                                                authorized.
                                            </p>
                                        </>
                                    ) : (
                                        <>
                                            <p className="text-[13px] text-muted-foreground">
                                                {discovery.serviceName} can connect this without a password. You
                                                will be sent to their sign-in and back here.
                                            </p>
                                            <Button asChild className="w-full">
                                                <a href={`/api/connections/${discovery.oauth}/link?scope=mail`}>
                                                    Authorize {discovery.serviceName}
                                                </a>
                                            </Button>
                                        </>
                                    )}
                                    <button
                                        type="button"
                                        className="text-[12px] text-muted-foreground underline hover:text-foreground"
                                        onClick={() => setUsePassword(true)}
                                    >
                                        Use a password instead
                                    </button>
                                </div>
                            ) : (
                                <label className="block">
                                    {/* Why the one-click option is not here. Without
                                        this the screen simply asks for a password and
                                        somebody spends an afternoon working out that
                                        Polaris cannot be returned to. */}
                                    {discovery.oauth && !publicAddress ? (
                                        <span className="mb-2 block rounded-md border border-border bg-card px-3 py-2 text-[12px] text-muted-foreground">
                                            {discovery.serviceName} could connect this without a password, but
                                            it has nowhere to send you back to: Polaris is only reachable on
                                            this network, and an address like that is one they refuse.{" "}
                                            {canSetDomain ? (
                                                <Link href="/admin/domains" className="underline">
                                                    Give Polaris a public address
                                                </Link>
                                            ) : (
                                                "Ask an administrator to give Polaris a public address."
                                            )}{" "}
                                            Until then this mailbox takes a password.
                                        </span>
                                    ) : null}
                                    <span className="mb-1 block text-[12px] text-muted-foreground">
                                        Password <span aria-hidden>*</span>
                                    </span>
                                    <Input
                                        type="password"
                                        value={password}
                                        autoComplete="off"
                                        aria-invalid={field === "password" ? true : undefined}
                                        onChange={(event) => setPassword(event.target.value)}
                                    />
                                    {discovery.passwordHelp ? (
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

                            {!authorizable ? (
                                <div className="rounded-md border border-border">
                                    <button
                                        type="button"
                                        className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] text-muted-foreground"
                                        aria-expanded={showServers}
                                        onClick={() => setShowServers((held) => !held)}
                                    >
                                        <ChevronDown
                                            className={cn("size-3.5 shrink-0", showServers && "rotate-180")}
                                            aria-hidden
                                        />
                                        Server settings
                                        <span className="ml-auto truncate text-foreground-subtle">
                                            {servers.imapHost || "not worked out"}
                                        </span>
                                    </button>
                                    {showServers ? (
                                        <div className="space-y-2 border-t border-border p-2">
                                            <ServerFields
                                                legend="Incoming (IMAP)"
                                                host={servers.imapHost}
                                                port={servers.imapPort}
                                                security={servers.imapSecurity}
                                                invalid={field === "imapHost"}
                                                onChange={(next) => setServers({ ...servers, ...next })}
                                                names={{
                                                    host: "imapHost",
                                                    port: "imapPort",
                                                    security: "imapSecurity"
                                                }}
                                            />
                                            <ServerFields
                                                legend="Outgoing (SMTP)"
                                                host={servers.smtpHost}
                                                port={servers.smtpPort}
                                                security={servers.smtpSecurity}
                                                invalid={field === "smtpHost"}
                                                onChange={(next) => setServers({ ...servers, ...next })}
                                                names={{
                                                    host: "smtpHost",
                                                    port: "smtpPort",
                                                    security: "smtpSecurity"
                                                }}
                                            />
                                            <label className="block">
                                                <span className="mb-1 block text-[12px] text-muted-foreground">
                                                    Login, if it is not the address
                                                </span>
                                                <Input
                                                    value={username}
                                                    onChange={(event) => setUsername(event.target.value)}
                                                />
                                            </label>
                                        </div>
                                    ) : null}
                                </div>
                            ) : null}
                        </>
                    ) : null}

                    {problem ? <p className="text-[13px] text-danger">{problem}</p> : null}

                    {!authorizable || usable.length > 0 ? (
                        <Button className="w-full" disabled={!ready || connecting} onClick={connect}>
                            {connecting ? <Loader2 className="size-4 shrink-0 animate-spin" aria-hidden /> : null}
                            Connect this mailbox
                        </Button>
                    ) : null}
                </div>
            </DialogContent>
        </Dialog>
    );
}

/**
 * The line under the address.
 *
 * It is doing real work: it is the only thing that tells somebody whether
 * Polaris knows where their mail lives, and saying which of the five questions
 * answered is what makes a wrong guess something they can correct rather than
 * argue with.
 */
function lookupSentence(
    address: string,
    valid: boolean,
    looking: boolean,
    discovery: MailDiscovery | null
): string {
    if (!address.trim()) return "Polaris works out the rest from your address.";
    if (!valid) return "That is not an email address yet.";
    if (looking) return "Looking up where this mail lives...";
    if (!discovery) return "";
    switch (discovery.source) {
        case "catalogue":
            return `${discovery.serviceName}. Nothing else to fill in.`;
        case "domain":
            return `${address.split("@")[1]} publishes its own settings, and these are them.`;
        case "directory":
            return "Found in the shared directory of mail providers.";
        case "exchangers":
            return `This domain's mail is handled by ${discovery.serviceName}.`;
        case "probe":
            return "Found by asking the domain's own servers.";
        default:
            return "Nothing said where this domain's mail lives, so the servers below are guesses. Change anything that is wrong.";
    }
}

function ServerFields({
    legend,
    host,
    port,
    security,
    invalid,
    names,
    onChange
}: {
    legend: string;
    host: string;
    port: string;
    security: string;
    invalid: boolean;
    names: { host: string; port: string; security: string };
    onChange: (next: Record<string, string>) => void;
}) {
    return (
        <fieldset className="space-y-2 rounded-md border border-border p-2">
            <legend className="px-1 text-[12px] text-muted-foreground">{legend}</legend>
            <div className="flex gap-2">
                <Input
                    className="flex-1"
                    value={host}
                    aria-label={`${legend} server`}
                    aria-invalid={invalid ? true : undefined}
                    onChange={(event) => onChange({ [names.host]: event.target.value })}
                />
                <Input
                    className="w-20"
                    value={port}
                    inputMode="numeric"
                    aria-label={`${legend} port`}
                    onChange={(event) => onChange({ [names.port]: event.target.value })}
                />
            </div>
            <Select
                value={security}
                onValueChange={(next) => onChange({ [names.security]: next })}
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
