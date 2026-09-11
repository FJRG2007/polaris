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
 *
 * The same dialog changes a mailbox that is already here (`editing`): the same
 * fields, the same checks as they are typed, and the same rule on the server -
 * nothing is stored until both servers accept it. What differs is only what a
 * change means: the address is shown rather than asked for, the password box is
 * empty and empty keeps the one stored - until the servers or the login change,
 * when it has to be typed again - and an authorized mailbox is offered the way to
 * authorize it again instead of a password.
 */

import Link from "next/link";
import { MAIL_PALETTE } from "./palette";
import { useRouter } from "next/navigation";
import { ChevronDown, Loader2 } from "lucide-react";
import { refusalOf } from "@/app/(app)/mail/refusal";
import type { MailDiscovery } from "@/lib/mailbox/autoconfig";
import type { MailAccountView } from "@/lib/mailbox/accounts";
import { addressState } from "@/app/(app)/mail/address-state";
import { useEffect, useRef, useState, useTransition, type ReactNode } from "react";
import {
    addAccountAction,
    discoverAction,
    updateAccountAction
} from "@/app/(app)/mail/actions";
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
import {
    findMailService,
    sameAddress,
    mailAccountSetupSchema,
    mailAccountUpdateSchema,
    mailHost,
    mailPort,
    normalizeMailName,
    type MailSocketSecurity
} from "@polaris/core";

/** An outside account somebody has already authorized here. */
export interface LinkedAccount {
    readonly id: string;
    readonly provider: string;
    readonly label: string;
    /**
     * The address the provider vouched for, or empty where it vouched for none.
     *
     * What decides whether this link is any use for the mailbox being connected.
     * Without it every authorized account was offered for every address and the
     * first was picked, so somebody typing one address and authorizing a
     * different account ended up with a mailbox stored under the address they
     * typed and a token for another one.
     */
    readonly address: string;
    /** Whether it has been granted what a mailbox needs, rather than only what a
     *  calendar needs. */
    readonly readyForMail: boolean;
}

/**
 * Where the address being connected waits while its owner is at the provider.
 *
 * Authorizing leaves Polaris entirely - a full navigation to Google and back -
 * so everything typed into this dialog is gone by the time they return, and what
 * they came back to was an empty form and a sentence telling them to add the
 * mailbox they had just authorized. Kept for this tab only, and for long enough
 * to sign in and no longer.
 */
const RESUME_KEY = "polaris.mail.connecting";
const RESUME_TTL_MS = 15 * 60 * 1000;

function keepResume(address: string): void {
    try {
        window.sessionStorage.setItem(RESUME_KEY, JSON.stringify({ address, at: Date.now() }));
    } catch {
        // A browser told to keep no site data. They come back to the form they
        // would have come back to before this existed.
    }
}

function takeResume(): string {
    try {
        const held = window.sessionStorage.getItem(RESUME_KEY);
        window.sessionStorage.removeItem(RESUME_KEY);
        if (!held) return "";
        const parsed = JSON.parse(held) as { address?: unknown; at?: unknown };
        if (typeof parsed.address !== "string" || typeof parsed.at !== "number") return "";
        return Date.now() - parsed.at < RESUME_TTL_MS ? parsed.address : "";
    } catch {
        return "";
    }
}

/** Which field a refusal was about, when it named one. Read the same way
 *  `refusalOf` reads the sentence: the two shapes are a union at every call
 *  site, and narrowing by hand is how one of them ends up unhandled. */
function fieldAtFault(answer: unknown): string {
    if (typeof answer !== "object" || answer === null) return "";
    const named = (answer as { field?: unknown }).field;
    return typeof named === "string" ? named : "";
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
    allowOauth = true,
    taken = [],
    title = "Add a mailbox",
    done = "",
    lead,
    submit,
    editing,
    focusPassword = false,
    onPending,
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
    /**
     * Whether this dialog may connect a mailbox by authorizing an outside
     * account.
     *
     * False where the mailbox is not being added by the person who will hold it:
     * an authorization belongs to the account that granted it, so the one the
     * person filling this in has is of no use to the holder. Offering it there
     * was a button that could only ever come back refused.
     */
    allowOauth?: boolean;
    /** What the dialog is called. The other caller is an organization handing a
     *  mailbox to somebody, which is not "adding" one. */
    title?: string;
    /** What the toast says instead of the default sentence. */
    done?: string;
    /**
     * Anything that has to be answered before the address - who the mailbox is
     * for, on the organization's screen.
     *
     * Above the address rather than below it because it changes what the rest of
     * the form means, and a question that comes after the answer is a question
     * people fill the form in twice for.
     */
    lead?: ReactNode;
    /**
     * Where the finished setup goes, when it is not this person's own mailbox.
     *
     * The form, the lookup and every sentence on it are the same either way -
     * only the destination differs - and copying six hundred lines to change one
     * call is how the two drift into disagreeing about what a valid address is.
     */
    submit?: (setup: unknown) => Promise<unknown>;
    /**
     * A mailbox already here, to change rather than to add.
     *
     * Everything it has is filled in except its password, which no read ever
     * returns: the box is empty, and empty keeps the stored one.
     */
    editing?: MailAccountView;
    /** Open with the cursor in the password box - what the "stopped accepting
     *  its password" notice is asking somebody to do. */
    focusPassword?: boolean;
    /**
     * Told what the mailbox's row should say while the servers are asked, and
     * told `null` when that has to be taken back because they refused.
     */
    onPending?: (pending: Partial<MailAccountView> | null) => void;
    onClose: () => void;
}) {
    const router = useRouter();
    const toast = useToast();

    const [address, setAddress] = useState(editing?.address ?? "");
    const [discovery, setDiscovery] = useState<MailDiscovery | null>(
        editing ? seededDiscovery(editing) : null
    );
    const [looking, setLooking] = useState(false);
    const [password, setPassword] = useState("");
    const [username, setUsername] = useState(editing?.username ?? "");
    const [displayName, setDisplayName] = useState(editing?.displayName ?? "");
    const [label, setLabel] = useState(editing?.label ?? "");
    const [color, setColor] = useState<string | null>(editing?.color ?? null);
    const [connectionId, setConnectionId] = useState(editing?.connectionId ?? "");
    const [usePassword, setUsePassword] = useState(editing?.auth === "password");
    const [showServers, setShowServers] = useState(false);
    const [servers, setServers] = useState(
        editing
            ? {
                  imapHost: editing.imapHost,
                  imapPort: String(editing.imapPort),
                  imapSecurity: editing.imapSecurity,
                  smtpHost: editing.smtpHost,
                  smtpPort: String(editing.smtpPort),
                  smtpSecurity: editing.smtpSecurity
              }
            : {
                  imapHost: "",
                  imapPort: "993",
                  imapSecurity: "tls",
                  smtpHost: "",
                  smtpPort: "465",
                  smtpSecurity: "tls"
              }
    );
    const [problem, setProblem] = useState("");
    const [field, setField] = useState("");
    const [connecting, startConnecting] = useTransition();
    /**
     * Whether this dialog is the second half of a trip to a provider.
     *
     * Authorizing is a full navigation away and back, so the form somebody
     * filled in is gone by the time they return - and what they returned to was
     * an empty one, under a sentence congratulating them on an authorization
     * that had connected no mailbox. The address comes back from where it was
     * left, and the rest finishes itself: pressing Authorize was never a thing
     * anybody wanted done on its own.
     */
    const [resuming, setResuming] = useState(false);
    useEffect(() => {
        if (editing) return;
        const held = takeResume();
        if (!held) return;
        setAddress(held);
        setResuming(true);
    }, [editing]);

    // Which lookup the answer on the wire belongs to. An address typed on top of
    // a slow lookup must not be filled in with the previous domain's servers.
    const wanted = useRef("");

    // A mailbox being changed is already its own answer: its address is not
    // typed, so it is neither invalid nor "already here".
    const state = editing ? "ok" : addressState(address, taken);
    const valid = state === "ok" || state === "taken";
    /** Already here. Nothing else on this dialog applies: there are no servers
     *  worth looking up for a mailbox that is already connected. */
    const already = state === "taken";

    useEffect(() => {
        // Its servers are the ones it has, not the ones a lookup would guess.
        if (editing) return;
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
    }, [address, valid, already, editing]);

    const oauthReady = !allowOauth
        ? false
        : discovery?.oauth === "google"
          ? googleReady
          : discovery?.oauth === "microsoft"
            ? microsoftReady
            : false;
    const authorizable = Boolean(discovery?.oauth) && oauthReady && !usePassword;
    /** The mailbox this dialog is about, which is what any authorization has to
     *  be for. */
    const forAddress = (editing?.address ?? address).trim();
    const authorized = links.filter(
        (link) => link.provider === discovery?.oauth && link.readyForMail
    );
    /**
     * The ones that are this mailbox.
     *
     * Matched on the address the provider vouched for rather than offered as a
     * list: an account somebody authorized for another mailbox cannot read this
     * one, and picking it stored a mailbox that could never log in.
     *
     * A link with no address on it - an older one, or a provider that vouched
     * for none - is not offered. There is nothing to check it against, and
     * guessing is the bug this exists to remove.
     */
    const usable = authorized.filter(
        (link) => forAddress !== "" && link.address !== "" && sameAddress(link.address, forAddress)
    );
    /** Authorized here, but a different account than the one being connected -
     *  which is exactly what happens when the consent screen opens on whoever
     *  the browser is already signed into. */
    const otherAccount = usable.length === 0 && authorized.length > 0;
    // The one chosen, while it is still one that can be chosen: a mailbox being
    // changed may point at a link that has since lost its mail access.
    const chosenConnection = usable.some((link) => link.id === connectionId)
        ? connectionId
        : (usable[0]?.id ?? "");
    const provider = discovery?.oauth === "microsoft" ? "Microsoft" : "Google";
    /**
     * Where Authorize goes.
     *
     * It names the mailbox: the provider opens its consent screen on that
     * account rather than on whichever one the browser is signed into, and the
     * callback refuses to link any other - see `link-flow`. `edit` is what
     * brings a re-authorization back to the mailbox it was for instead of to a
     * list.
     */
    const authorizeHref = `/api/connections/${discovery?.oauth ?? ""}/link?scope=mail&address=${encodeURIComponent(
        forAddress
    )}${editing ? `&edit=${encodeURIComponent(editing.id)}` : ""}`;

    /** What would be sent, as it stands. Checked against the server's own
     *  schema as it is typed, and compared with the mailbox as it was loaded. */
    const shape = {
        displayName,
        auth: authorizable ? ("oauth" as const) : ("password" as const),
        connectionId: authorizable ? chosenConnection : null,
        username,
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
    };
    const update = editing
        ? { ...shape, label, color, password: authorizable ? "" : password }
        : null;
    const checked = update
        ? mailAccountUpdateSchema.safeParse(update)
        : mailAccountSetupSchema.safeParse({
              ...shape,
              address,
              label: "",
              ...(authorizable ? {} : { password }),
              provider: discovery?.service ?? ""
          });
    /** The schema's sentence about one field, for the fields that have one
     *  worth saying while typing. A blank required field is not among them: it
     *  is unfinished, and the disabled button already says so. */
    const issue = (name: string): string =>
        checked.success
            ? ""
            : (checked.error.issues.find((one) => one.path[0] === name)?.message ?? "");

    /**
     * Whether anything would change. Compared with what was loaded rather than
     * with whether a field was touched, so a label typed and put back leaves
     * nothing to save. A refused mailbox always has something to save: pressing
     * it is asking whether the stored password works again.
     */
    const changed =
        !editing ||
        !checked.success ||
        editing.state === "auth" ||
        (update?.password ?? "") !== "" ||
        (checked.data as { label?: string }).label !== editing.label ||
        (checked.data as { color?: string | null }).color !== editing.color ||
        checked.data.displayName !== editing.displayName ||
        checked.data.auth !== editing.auth ||
        (checked.data.auth === "oauth" && checked.data.connectionId !== editing.connectionId) ||
        checked.data.username !== editing.username ||
        checked.data.imap.host !== editing.imapHost ||
        checked.data.imap.port !== editing.imapPort ||
        checked.data.imap.security !== editing.imapSecurity ||
        checked.data.smtp.host !== editing.smtpHost ||
        checked.data.smtp.port !== editing.smtpPort ||
        checked.data.smtp.security !== editing.smtpSecurity;

    function connect(): void {
        if (!discovery) return;
        if (editing && update) {
            // The row says the new name now and says it is being checked; a
            // refusal puts back exactly what it said before. Said here rather
            // than inside the transition below, which holds every update made
            // in it until it finishes - the opposite of saying it now.
            onPending?.({
                displayName: normalizeMailName(displayName),
                label: normalizeMailName(label),
                color,
                ...(editing.state === "auth" || update.password ? { state: "checking" } : {})
            });
        }
        startConnecting(async () => {
            setProblem("");
            setField("");
            if (editing && update) {
                const answer = await updateAccountAction(editing.id, update);
                const said = refusalOf(answer);
                if (said) {
                    onPending?.(null);
                    setProblem(said);
                    setField(fieldAtFault(answer));
                    if (said.toLowerCase().includes("server")) setShowServers(true);
                    return;
                }
                toast.show({
                    title:
                        editing.state === "auth"
                            ? `${editing.address} is connected again. Its mail is on its way.`
                            : `${editing.address} is saved.`
                });
                router.refresh();
                onClose();
                return;
            }
            const send = submit ?? addAccountAction;
            const answer = await send({
                address,
                ...shape,
                label: "",
                ...(authorizable ? {} : { password }),
                provider: discovery.service
            });
            const said = refusalOf(answer);
            if (said) {
                setProblem(said);
                setField(fieldAtFault(answer));
                // A refusal about the servers opens them, so the thing being
                // complained about is on screen.
                if (said.toLowerCase().includes("server")) setShowServers(true);
                return;
            }
            toast.show({ title: done || `${address} is connected. Its mail is on its way.` });
            router.refresh();
            onClose();
        });
    }

    // Checked as they are typed, with the server's own rules: a guessed or
    // edited server that would be refused keeps the button off and says why,
    // rather than the refusal arriving after the password.
    const serversProblem = authorizable
        ? null
        : (serverProblem(servers.imapHost, servers.imapPort) ??
          serverProblem(servers.smtpHost, servers.smtpPort));
    // A server that would be refused is shown, so the disabled button has its
    // reason on screen rather than behind a closed disclosure.
    const serversBroken = Boolean(discovery) && serversProblem !== null;
    useEffect(() => {
        if (serversBroken) setShowServers(true);
    }, [serversBroken]);
    /** Whether the servers or the login differ from the ones the saved password
     *  was entered for. The saved one is never sent anywhere else, so the box
     *  has to be filled again. */
    const sent = checked.success ? checked.data : shape;
    const movesServers =
        editing !== undefined &&
        (sent.username !== editing.username ||
            sent.imap.host !== editing.imapHost ||
            sent.imap.port !== editing.imapPort ||
            sent.imap.security !== editing.imapSecurity ||
            sent.smtp.host !== editing.smtpHost ||
            sent.smtp.port !== editing.smtpPort ||
            sent.smtp.security !== editing.smtpSecurity);
    /** Whether a blank password box is a kept password rather than a missing
     *  one: only for a mailbox that has one stored to keep, on the servers it
     *  was saved for. */
    const retypesPassword = editing?.auth === "password" && movesServers;
    const keepsPassword = editing?.auth === "password" && !movesServers;
    const ready =
        valid &&
        !already &&
        Boolean(discovery) &&
        serversProblem === null &&
        (authorizable ? Boolean(chosenConnection) : password.length > 0 || keepsPassword) &&
        (!editing || (checked.success && changed));

    /**
     * Come back from the provider with everything it needed, and add the
     * mailbox.
     *
     * Held until the lookup that fills in the servers has landed, which is what
     * `ready` is. Anything missing - no link for this address, because the
     * account authorized was a different one - leaves the form standing with the
     * reason on it rather than submitting something that would be refused.
     */
    useEffect(() => {
        if (!resuming || connecting || !ready || !authorizable || !chosenConnection) return;
        setResuming(false);
        connect();
    }, [resuming, connecting, ready, authorizable, chosenConnection]); // eslint-disable-line react-hooks/exhaustive-deps

    return (
        <Dialog open onOpenChange={(next) => (next ? undefined : onClose())}>
            <DialogContent className="max-w-lg">
                <DialogHeader>
                    <DialogTitle>{title}</DialogTitle>
                </DialogHeader>

                <div className="space-y-3">
                    {lead}
                    {editing ? (
                        <label className="block">
                            <span className="mb-1 block text-[12px] text-muted-foreground">
                                Email address
                            </span>
                            {/* Shown, not asked: it is what this mailbox is. A
                                different address is a different mailbox, and
                                its mail would land in this one's copy. */}
                            <Input value={address} readOnly aria-describedby="mailbox-fixed" />
                            <span
                                id="mailbox-fixed"
                                className="mt-1 block text-[12px] text-foreground-subtle"
                            >
                                To use a different address, add it as a new mailbox.
                            </span>
                        </label>
                    ) : (
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
                    )}

                    {discovery && !looking ? (
                        <>
                            {/* Before anything is typed, because it is the
                                reason the settings underneath do not mean what
                                they appear to. One service needs it, and
                                without it that service's form reads as
                                everything being fine. */}
                            {discovery.note ? (
                                <p className="rounded-md border border-warning-edge bg-warning-soft px-3 py-2 text-[12px]">
                                    {discovery.note}
                                </p>
                            ) : null}
                            {authorizable ? (
                                <div className="space-y-2">
                                    {/* Authorized here, and not this mailbox.
                                        The consent screen opens on whoever the
                                        browser is signed into, so this is the
                                        ordinary way to end up with a token for
                                        the wrong account - and the server
                                        refuses to link one, which is why there
                                        is something to say rather than a mailbox
                                        that cannot log in. */}
                                    {otherAccount ? (
                                        <p className="rounded-md border border-warning-edge bg-warning-soft px-3 py-2 text-[12px]">
                                            The {provider} account you authorized is not{" "}
                                            {forAddress || "this mailbox"}. Authorize that one to
                                            connect it, or use a password instead.
                                        </p>
                                    ) : null}
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
                                                No password is stored. Polaris uses the account you
                                                already authorized.
                                            </p>
                                        </>
                                    ) : (
                                        <>
                                            <p className="text-[13px] text-muted-foreground">
                                                {editing
                                                    ? `${provider} no longer lets Polaris into this mailbox. Authorize it again and you will be sent back here.`
                                                    : `${discovery.serviceName} can connect this without a password. You will be sent to their sign-in and back here.`}
                                            </p>
                                            <Button asChild className="w-full">
                                                <a
                                                    href={authorizeHref}
                                                    onClick={() => keepResume(forAddress)}
                                                >
                                                    {editing
                                                        ? `Reconnect with ${provider}`
                                                        : `Authorize ${discovery.serviceName}`}
                                                </a>
                                            </Button>
                                        </>
                                    )}
                                    {/* A mailbox that is here already and was
                                        refused needs the authorization redone,
                                        not another account picked: the token
                                        that stopped working is this one's. */}
                                    {editing && usable.length > 0 ? (
                                        <Button asChild variant="outline" className="w-full">
                                            <a href={authorizeHref} onClick={() => keepResume(forAddress)}>
                                                Reconnect with {provider}
                                            </a>
                                        </Button>
                                    ) : null}
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
                                    {discovery.oauth && !allowOauth ? (
                                        <span className="mb-2 block rounded-md border border-border bg-card px-3 py-2 text-[12px] text-muted-foreground">
                                            {discovery.serviceName} can connect this without a
                                            password, but only its holder can authorize that from
                                            their own account. Hand it out with a password, or ask
                                            them to add it themselves.
                                        </span>
                                    ) : null}
                                    {allowOauth && discovery.oauth && !publicAddress ? (
                                        <span className="mb-2 block rounded-md border border-border bg-card px-3 py-2 text-[12px] text-muted-foreground">
                                            {discovery.serviceName} could connect this without a
                                            password, but it has nowhere to send you back to:
                                            Polaris is only reachable on this network, and an
                                            address like that is one they refuse.{" "}
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
                                        {keepsPassword ? "New password" : "Password"}{" "}
                                        {keepsPassword ? null : <span aria-hidden>*</span>}
                                    </span>
                                    <Input
                                        type="password"
                                        value={password}
                                        autoComplete="off"
                                        autoFocus={focusPassword}
                                        placeholder={
                                            keepsPassword ? "Leave blank to keep the current one" : undefined
                                        }
                                        aria-invalid={field === "password" ? true : undefined}
                                        aria-describedby={
                                            keepsPassword || retypesPassword
                                                ? "mailbox-password-kept"
                                                : undefined
                                        }
                                        onChange={(event) => {
                                            setPassword(event.target.value);
                                            if (field === "password") setField("");
                                        }}
                                    />
                                    {retypesPassword ? (
                                        <span
                                            id="mailbox-password-kept"
                                            className="mt-1 block text-[12px] text-foreground-subtle"
                                        >
                                            The servers or login changed, so enter the password again.
                                        </span>
                                    ) : keepsPassword ? (
                                        <span
                                            id="mailbox-password-kept"
                                            className={cn(
                                                "mt-1 block text-[12px]",
                                                editing?.state === "auth"
                                                    ? "text-danger"
                                                    : "text-foreground-subtle"
                                            )}
                                        >
                                            {editing?.state === "auth"
                                                ? "The server stopped accepting the saved password. Type the new one - left blank, the saved one is tried again."
                                                : "Left blank, the saved password is kept."}
                                        </span>
                                    ) : null}
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
                                    aria-invalid={issue("displayName") ? true : undefined}
                                />
                                {issue("displayName") ? (
                                    <span className="mt-1 block text-[12px] text-danger">
                                        {issue("displayName")}
                                    </span>
                                ) : null}
                            </label>

                            {editing ? (
                                <>
                                    <label className="block">
                                        <span className="mb-1 block text-[12px] text-muted-foreground">
                                            Name in the rail
                                        </span>
                                        <Input
                                            value={label}
                                            onChange={(event) => setLabel(event.target.value)}
                                            placeholder="Left blank, the address is used"
                                            aria-invalid={issue("label") ? true : undefined}
                                        />
                                        {issue("label") ? (
                                            <span className="mt-1 block text-[12px] text-danger">
                                                {issue("label")}
                                            </span>
                                        ) : null}
                                    </label>
                                    <fieldset>
                                        <legend className="mb-1 block text-[12px] text-muted-foreground">
                                            Colour
                                        </legend>
                                        <div className="flex flex-wrap items-center gap-1.5">
                                            <button
                                                type="button"
                                                aria-pressed={color === null}
                                                onClick={() => setColor(null)}
                                                className={cn(
                                                    "h-6 rounded-full border border-border px-2 text-[12px] text-muted-foreground",
                                                    color === null && "ring-2 ring-foreground"
                                                )}
                                            >
                                                Automatic
                                            </button>
                                            {MAIL_PALETTE.map((swatch) => (
                                                <button
                                                    key={swatch.hex}
                                                    type="button"
                                                    title={swatch.name}
                                                    aria-label={swatch.name}
                                                    aria-pressed={color === swatch.hex}
                                                    onClick={() => setColor(swatch.hex)}
                                                    className={cn(
                                                        "size-6 shrink-0 rounded-full ring-offset-2 ring-offset-background",
                                                        color === swatch.hex && "ring-2 ring-foreground"
                                                    )}
                                                    style={{ backgroundColor: swatch.hex }}
                                                />
                                            ))}
                                        </div>
                                    </fieldset>
                                </>
                            ) : null}

                            {!authorizable ? (
                                <div className="rounded-md border border-border">
                                    <button
                                        type="button"
                                        className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] text-muted-foreground"
                                        aria-expanded={showServers}
                                        onClick={() => setShowServers((held) => !held)}
                                    >
                                        <ChevronDown
                                            className={cn(
                                                "size-3.5 shrink-0",
                                                showServers && "rotate-180"
                                            )}
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
                                                onChange={(next) =>
                                                    setServers({ ...servers, ...next })
                                                }
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
                                                onChange={(next) =>
                                                    setServers({ ...servers, ...next })
                                                }
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
                                                    onChange={(event) =>
                                                        setUsername(event.target.value)
                                                    }
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
                        <Button
                            className="w-full"
                            disabled={!ready || connecting}
                            onClick={connect}
                        >
                            {connecting ? (
                                <Loader2 className="size-4 shrink-0 animate-spin" aria-hidden />
                            ) : null}
                            {editing
                                ? connecting
                                    ? "Checking with the servers..."
                                    : "Save changes"
                                : "Connect this mailbox"}
                        </Button>
                    ) : null}
                </div>
            </DialogContent>
        </Dialog>
    );
}

/**
 * What a mailbox already here knows about itself, in the shape a lookup would
 * have answered with - so the rest of the form reads the same either way.
 *
 * Its servers are the ones it has, not the catalogue's: somebody may have
 * changed them, and a form that quietly put the defaults back would be
 * reconnecting a mailbox to somewhere it was moved away from.
 */
function seededDiscovery(account: MailAccountView): MailDiscovery {
    const service = findMailService(account.service);
    return {
        address: account.address,
        service: account.service,
        serviceName: service?.name ?? account.serviceName,
        imap: {
            host: account.imapHost,
            port: account.imapPort,
            security: account.imapSecurity as MailSocketSecurity
        },
        smtp: {
            host: account.smtpHost,
            port: account.smtpPort,
            security: account.smtpSecurity as MailSocketSecurity
        },
        oauth: service?.oauth ?? null,
        passwordHelp: service?.passwordHelp ?? "",
        note: service?.note ?? "",
        passwordUrl: service?.passwordUrl ?? "",
        source: service ? "catalogue" : "none"
    };
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
        case "polaris":
            return "A mail server this Polaris runs. Nothing else to fill in.";
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

/**
 * What is wrong with one server's host and port, read with the schemas the
 * server will read them with. Null when both would be accepted.
 */
export function serverProblem(host: string, port: string): string | null {
    const hostCheck = mailHost.safeParse(host);
    if (!hostCheck.success) return hostCheck.error.issues[0]?.message ?? "That is not a server name";
    if (!mailPort.safeParse(port).success) return "The port is a number from 1 to 65535";
    return null;
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
    const problem = serverProblem(host, port);
    const hostBad = invalid || (problem !== null && !mailHost.safeParse(host).success);
    const portBad = problem !== null && !hostBad;
    return (
        <fieldset className="space-y-2 rounded-md border border-border p-2">
            <legend className="px-1 text-[12px] text-muted-foreground">{legend}</legend>
            <div className="flex gap-2">
                <Input
                    className="flex-1"
                    value={host}
                    aria-label={`${legend} server`}
                    aria-invalid={hostBad ? true : undefined}
                    onChange={(event) => onChange({ [names.host]: event.target.value })}
                />
                <Input
                    className="w-20"
                    value={port}
                    inputMode="numeric"
                    aria-label={`${legend} port`}
                    aria-invalid={portBad ? true : undefined}
                    onChange={(event) => onChange({ [names.port]: event.target.value })}
                />
            </div>
            {problem ? <p className="text-[12px] text-danger">{problem}</p> : null}
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
