"use client";

/**
 * One card per service, listing the accounts of it this person has linked.
 *
 * Unlinking is optimistic and rolls back, because the row is the whole answer to
 * "is this connected" and waiting on a round trip to redraw it reads as a dead
 * button. It is also confirmed first: an account somebody removes by accident
 * takes their deployments and their runner pools with it.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { runAction } from "@/lib/run-action";
import { IntegrationLogo } from "@/components/logos";
import { RelativeTime } from "@/components/relative-time";
import { useEffect, useMemo, useState, useTransition } from "react";
import { ExternalLink, KeyRound, Loader2, Plus, Unlink } from "lucide-react";
import { connectGithubTokenAction, disconnectAccountAction } from "./actions";
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
    Input
} from "@polaris/ui";

export interface LinkedAccount {
    id: string;
    provider: string;
    label: string;
    avatarUrl: string | null;
    method: "oauth" | "token";
    /** Whether this account is also a way into Polaris. Decided under Security,
     *  and shown here because this is the screen where somebody has just added
     *  one and is wondering what it now does. */
    signsIn: boolean;
    linkedAt: string;
}

export interface ConnectionProviderCard {
    slug: string;
    name: string;
    summary: string;
    description: string;
    acceptsToken: boolean;
    tokenLabel?: string;
    tokenHelp?: string;
    tokenUrl?: string;
    /** What the operator has to connect first, for the card that cannot offer one. */
    requires: string;
    /** How many accounts of this service the person may link. */
    limit: number;
    /** Whether this deployment can send anybody to the provider's own screen. */
    canAuthorize: boolean;
    /** Whether the operator allows this service as a way into Polaris at all. */
    canSignIn: boolean;
    accounts: LinkedAccount[];
}

/** What the round trip to a provider came back with, as the callback flagged it. */
const OUTCOMES: Record<string, { text: string; bad: boolean }> = {
    linked: { text: "Account connected.", bad: false },
    cancelled: { text: "The authorization was cancelled.", bad: true },
    state_error: { text: "That request did not come from this page. Start it again.", bad: true },
    taken: { text: "That account is already linked to another Polaris account.", bad: true },
    limit: { text: "You have already linked as many accounts of that service as you are allowed.", bad: true },
    unavailable: { text: "This Polaris cannot connect that service yet.", bad: true },
    // Nothing here is this person's to fix, and the reason lives in a console
    // they cannot open - so the one useful thing to tell them is that the people
    // who can open it now know.
    error: {
        text: "The service did not complete the authorization. Nothing was wrong on your side: this Polaris has told its administrators.",
        bad: true
    }
};

export function ConnectionsView({ providers }: { providers: ConnectionProviderCard[] }) {
    const [notice, setNotice] = useState<{ provider: string; text: string; bad: boolean } | null>(null);

    // The callbacks return here with ?provider=&connection=, read once and cleared
    // so a refresh does not keep re-announcing something that happened minutes ago.
    useEffect(() => {
        const params = new URLSearchParams(window.location.search);
        const outcome = params.get("connection");
        const provider = params.get("provider");
        if (!outcome || !provider) return;
        const known = OUTCOMES[outcome];
        if (known) setNotice({ provider, ...known });
        const url = new URL(window.location.href);
        url.searchParams.delete("connection");
        url.searchParams.delete("provider");
        window.history.replaceState(null, "", url.toString());
    }, []);

    return (
        <div className="flex flex-col gap-3">
            {providers.map((provider) => (
                <ProviderCard
                    key={provider.slug}
                    provider={provider}
                    notice={notice?.provider === provider.slug ? notice : null}
                />
            ))}
        </div>
    );
}

function ProviderCard({
    provider,
    notice
}: {
    provider: ConnectionProviderCard;
    notice: { text: string; bad: boolean } | null;
}) {
    const router = useRouter();
    const [pending, startTransition] = useTransition();
    const [removed, setRemoved] = useState<string[]>([]);
    const [confirming, setConfirming] = useState<LinkedAccount | null>(null);
    const [tokenOpen, setTokenOpen] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const accounts = useMemo(
        () => provider.accounts.filter((account) => !removed.includes(account.id)),
        [provider.accounts, removed]
    );
    const slotsLeft = Math.max(0, provider.limit - accounts.length);
    const canAdd = slotsLeft > 0;

    function disconnect(account: LinkedAccount) {
        setConfirming(null);
        setError(null);
        setRemoved((current) => [...current, account.id]);
        startTransition(async () => {
            const result = await runAction(() => disconnectAccountAction(account.id), (message) => setError(message));
            if (!result || result.error) {
                setRemoved((current) => current.filter((id) => id !== account.id));
                if (result?.error) setError(result.error);
                return;
            }
            router.refresh();
        });
    }

    return (
        <Card>
            <CardBody className="flex flex-col gap-3">
                <div className="flex items-start gap-3">
                    <div className="grid size-10 shrink-0 place-items-center rounded-md border border-border bg-surface">
                        <IntegrationLogo slug={provider.slug} className="size-6" />
                    </div>
                    <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                            <h2 className="truncate text-sm font-medium">{provider.name}</h2>
                            {provider.limit > 1 ? (
                                <Badge variant="neutral">
                                    {accounts.length} of {provider.limit}
                                </Badge>
                            ) : null}
                        </div>
                        <p className="mt-0.5 text-xs text-muted-foreground">{provider.summary}</p>
                    </div>
                </div>

                {accounts.length > 0 ? (
                    <ul className="flex flex-col gap-2">
                        {accounts.map((account) => (
                            <li
                                key={account.id}
                                className="flex items-center gap-3 rounded-md border border-border/60 px-3 py-2"
                            >
                                {account.avatarUrl ? (
                                    // eslint-disable-next-line @next/next/no-img-element -- one remote avatar, no loader needed
                                    <img src={account.avatarUrl} alt="" className="size-6 shrink-0 rounded-full" />
                                ) : (
                                    <IntegrationLogo slug={provider.slug} className="size-5 shrink-0" />
                                )}
                                <span className="min-w-0 flex-1 truncate text-sm">{account.label}</span>
                                {account.signsIn ? (
                                    <Badge variant="neutral" title="This account can sign you in">
                                        Signs you in
                                    </Badge>
                                ) : null}
                                {account.method === "token" ? (
                                    <Badge variant="neutral" title="Connected with a personal access token">
                                        Token
                                    </Badge>
                                ) : null}
                                <span className="hidden text-xs text-muted-foreground sm:inline">
                                    <RelativeTime iso={account.linkedAt} />
                                </span>
                                <Button
                                    size="sm"
                                    variant="ghost"
                                    aria-label={`Disconnect ${account.label}`}
                                    title={`Disconnect ${account.label}`}
                                    disabled={pending}
                                    onClick={() => setConfirming(account)}
                                >
                                    <Unlink className="size-4" />
                                </Button>
                            </li>
                        ))}
                    </ul>
                ) : (
                    <p className="text-sm text-muted-foreground">No {provider.name} account connected.</p>
                )}

                <p className="text-xs text-muted-foreground">
                    {provider.description}
                    {provider.canSignIn ? (
                        <>
                            {" "}
                            An account you connect can also sign you in - choose which under{" "}
                            <Link href="/account/security" className="underline underline-offset-2 hover:text-foreground">
                                Security
                            </Link>
                            .
                        </>
                    ) : null}
                </p>

                {provider.canAuthorize || provider.acceptsToken ? (
                    <div className="flex flex-wrap items-center gap-2">
                        {provider.canAuthorize ? (
                            <Button
                                size="sm"
                                variant="secondary"
                                disabled={!canAdd || pending}
                                onClick={() => router.push(`/api/connections/${provider.slug}/link`)}
                            >
                                <Plus className="size-4" />
                                Connect {provider.name}
                            </Button>
                        ) : null}
                        {provider.acceptsToken ? (
                            <Button size="sm" variant="ghost" disabled={!canAdd || pending} onClick={() => setTokenOpen(true)}>
                                <KeyRound className="size-4" />
                                Use a token
                            </Button>
                        ) : null}
                        {!canAdd ? (
                            <span className="text-xs text-muted-foreground">
                                Disconnect one to connect another account.
                            </span>
                        ) : null}
                    </div>
                ) : null}

                {!provider.canAuthorize && !provider.acceptsToken ? (
                    <p className="text-sm text-muted-foreground">
                        Available once whoever administers this Polaris connects {provider.requires} under
                        Integrations.
                    </p>
                ) : null}

                {error ? <p className="text-sm text-danger">{error}</p> : null}
                {notice ? (
                    <p className={`text-sm ${notice.bad ? "text-danger" : "text-success"}`}>{notice.text}</p>
                ) : null}
            </CardBody>

            {confirming ? (
                <DisconnectDialog
                    account={confirming}
                    providerName={provider.name}
                    onCancel={() => setConfirming(null)}
                    onConfirm={() => disconnect(confirming)}
                />
            ) : null}

            {tokenOpen ? (
                <TokenDialog
                    providerName={provider.name}
                    label={provider.tokenLabel ?? "Access token"}
                    help={provider.tokenHelp}
                    tokenUrl={provider.tokenUrl}
                    onClose={() => setTokenOpen(false)}
                    onDone={() => {
                        setTokenOpen(false);
                        router.refresh();
                    }}
                />
            ) : null}
        </Card>
    );
}

function DisconnectDialog({
    account,
    providerName,
    onCancel,
    onConfirm
}: {
    account: LinkedAccount;
    providerName: string;
    onCancel: () => void;
    onConfirm: () => void;
}) {
    return (
        <Dialog open onOpenChange={(open) => (open ? undefined : onCancel())}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>Disconnect {account.label}?</DialogTitle>
                    <DialogDescription>
                        Polaris stops reaching anything in this {providerName} account. Services that build from its
                        repositories stop deploying, and any runner pool serving you stops serving them.
                    </DialogDescription>
                </DialogHeader>
                <div className="flex justify-end gap-2">
                    <Button variant="ghost" onClick={onCancel}>
                        Cancel
                    </Button>
                    <Button onClick={onConfirm}>Disconnect</Button>
                </div>
            </DialogContent>
        </Dialog>
    );
}

function TokenDialog({
    providerName,
    label,
    help,
    tokenUrl,
    onClose,
    onDone
}: {
    providerName: string;
    label: string;
    help?: string;
    tokenUrl?: string;
    onClose: () => void;
    onDone: () => void;
}) {
    const [token, setToken] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();

    function submit() {
        setError(null);
        startTransition(async () => {
            const result = await runAction(() => connectGithubTokenAction(token), (message) => setError(message));
            if (!result) return;
            if (result.error) {
                setError(result.error);
                return;
            }
            onDone();
        });
    }

    return (
        <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>Connect {providerName} with a token</DialogTitle>
                    <DialogDescription>
                        Polaris checks the token with {providerName} and connects whichever account it belongs to.
                    </DialogDescription>
                </DialogHeader>
                <div className="flex flex-col gap-2">
                    <label className="text-sm font-medium" htmlFor="connection-token">
                        {label}
                    </label>
                    <Input
                        id="connection-token"
                        type="password"
                        autoComplete="off"
                        value={token}
                        placeholder="ghp_..."
                        onChange={(event) => setToken(event.target.value)}
                    />
                    {help ? <p className="text-xs text-muted-foreground">{help}</p> : null}
                    {tokenUrl ? (
                        <a
                            href={tokenUrl}
                            target="_blank"
                            rel="noreferrer noopener"
                            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                        >
                            Create one
                            <ExternalLink className="size-3" />
                        </a>
                    ) : null}
                    {error ? <p className="text-sm text-danger">{error}</p> : null}
                </div>
                <div className="flex justify-end gap-2">
                    <Button variant="ghost" onClick={onClose} disabled={pending}>
                        Cancel
                    </Button>
                    <Button onClick={submit} disabled={pending || token.trim().length === 0}>
                        {pending ? <Loader2 className="size-4 animate-spin" /> : null}
                        Connect
                    </Button>
                </div>
            </DialogContent>
        </Dialog>
    );
}
