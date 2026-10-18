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
import { FAILURE_RECORDED } from "@/lib/connections/outcome-params";
import { IntegrationLogo } from "@/components/logos";
import {
    CONNECTION_CATEGORIES,
    lastfmNameSchema,
    minecraftNameSchema,
    type ConnectionCategory
} from "@polaris/core";
import { strictSafeRedirect } from "@/lib/safe-redirect";
import { RETURN_PARAM } from "@/lib/connections/hub-href";
import { arrangeProviders } from "@/lib/connections/arrange";
import { RelativeTime } from "@/components/relative-time";
import type { NamespaceTranslator } from "@/lib/i18n/types";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { useEffect, useMemo, useState, useTransition, type ReactNode } from "react";
import {
    ArrowLeft,
    ExternalLink,
    KeyRound,
    Loader2,
    Pencil,
    Plus,
    RefreshCw,
    Search,
    Unlink
} from "lucide-react";
import {
    connectAwsAction,
    connectTokenAction,
    disconnectAccountAction,
    saveLastfmNameAction,
    saveMinecraftNameAction
} from "./actions";
import {
    Badge,
    Button,
    Card,
    CardBody,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Input
} from "@polaris/ui";

export interface LinkedAccount {
    id: string;
    provider: string;
    label: string;
    avatarUrl: string | null;
    /** "manual" is a name its owner typed, which nothing has confirmed. */
    method: "oauth" | "token" | "manual";
    /** Whether this account is also a way into Polaris. Decided under Security,
     *  and shown here because this is the screen where somebody has just added
     *  one and is wondering what it now does. */
    signsIn: boolean;
    /** Whether Polaris now asks this service for more than this link was granted.
     *  Nothing has broken; a consent is outstanding and only its owner can give
     *  it, so the row says so and offers the way to. */
    needsReauthorization?: boolean;
    /** The permissions it is short of, named so somebody can decide rather than
     *  being asked to approve an unspecified "more". */
    missingScopes?: string[];
    linkedAt: string;
}

export interface ConnectionProviderCard {
    slug: string;
    name: string;
    /** Which section it is listed under, from the provider catalogue. */
    category: ConnectionCategory;
    summary: string;
    description: string;
    acceptsToken: boolean;
    tokenLabel?: string;
    tokenHelp?: string;
    tokenUrl?: string;
    /** Whether a name may be typed instead of proved. Such a link is shown as not
     *  verified, and a proved account replaces it. */
    acceptsTypedName?: boolean;
    /** A typed name is the only way this one is linked, so it is never "not verified". */
    typedOnly?: boolean;
    /** What the operator has to connect first, for the card that cannot offer one. */
    requires: string;
    /** How many accounts of this service the person may link. */
    limit: number;
    /** Whether this deployment can send anybody to the provider's own screen. */
    canAuthorize: boolean;
    /** Whether the operator allows this service as a way into Polaris at all. */
    canSignIn: boolean;
    accounts: LinkedAccount[];
    /** Why the provider last refused an authorization, sent to administrators only. */
    lastFailure?: string;
}

/** What the round trip to a provider came back with, as the callback flagged it. */
const OUTCOMES: Record<
    string,
    {
        key: "linked" | "cancelled" | "stateError" | "taken" | "limit" | "unavailable" | "error";
        bad: boolean;
    }
> = {
    linked: { key: "linked", bad: false },
    cancelled: { key: "cancelled", bad: true },
    state_error: { key: "stateError", bad: true },
    taken: { key: "taken", bad: true },
    limit: { key: "limit", bad: true },
    unavailable: { key: "unavailable", bad: true },
    // Nothing here is this person's to fix, and the reason lives in a console
    // they cannot open - so the one useful thing to tell them is that the people
    // who can open it now know.
    error: { key: "error", bad: true }
};

/**
 * The screen an app sent somebody here from, as `?return=` named it: only a path
 * on this origin, and nothing when it would resolve anywhere else.
 */
export function readReturnTo(search: string): string | null {
    return strictSafeRedirect(new URLSearchParams(search).get(RETURN_PARAM));
}

/** Where a card's Connect button starts the trip, carrying the way back. */
export function linkHref(slug: string, returnTo: string | null): string {
    const base = `/api/connections/${slug}/link`;
    return returnTo ? `${base}?${RETURN_PARAM}=${encodeURIComponent(returnTo)}` : base;
}

export function ConnectionsView({
    providers,
    initialSearch = ""
}: {
    providers: ConnectionProviderCard[];
    /** The page's query string, so the first render already knows where it came
     *  from and which service it was sent for. */
    initialSearch?: string;
}) {
    const t = useTranslations("account");
    const [notice, setNotice] = useState<{ provider: string; text: string; bad: boolean } | null>(
        null
    );
    const [query, setQuery] = useState("");
    const [category, setCategory] = useState<ConnectionCategory | null>(null);
    const [returnTo] = useState<string | null>(() => readReturnTo(initialSearch));
    const [focused] = useState<string | null>(() => {
        const wanted = new URLSearchParams(initialSearch).get("provider");
        return wanted && providers.some((entry) => entry.slug === wanted) ? wanted : null;
    });

    // `?provider=` is an app pointing at one service: that card is scrolled to
    // and marked, so nobody has to find it among the rest.
    useEffect(() => {
        if (!focused) return;
        document
            .getElementById(`connection-${focused}`)
            ?.scrollIntoView({ block: "center", behavior: "smooth" });
    }, []);

    const sections = arrangeProviders(providers, { query, category });

    // The callbacks return here with ?provider=&connection=, read once and cleared
    // so a refresh does not keep re-announcing something that happened minutes ago.
    useEffect(() => {
        const params = new URLSearchParams(window.location.search);
        const outcome = params.get("connection");
        const provider = params.get("provider");
        if (!outcome || !provider) return;
        const known = OUTCOMES[outcome];
        // An administrator is the person the reason was recorded for, so they
        // read it here instead of being told that they have been told.
        const reason =
            outcome === "error" && params.get(FAILURE_RECORDED) === "1"
                ? providers.find((entry) => entry.slug === provider)?.lastFailure
                : undefined;
        if (known)
            setNotice({
                provider,
                text: reason
                    ? t("connections.outcomes.errorReason", { reason })
                    : t(`connections.outcomes.${known.key}` as const),
                bad: known.bad
            });
        const url = new URL(window.location.href);
        url.searchParams.delete("connection");
        url.searchParams.delete("provider");
        url.searchParams.delete(FAILURE_RECORDED);
        window.history.replaceState(null, "", url.toString());
    }, []);

    // The accounts most people link come first; the ones for building and
    // shipping sit under a heading of their own below them. Which is which is
    // the catalogue's to say, so a provider added later lands in its section
    // without this screen being touched.
    return (
        <div className="flex flex-col gap-6">
            {returnTo ? (
                <div>
                    <Button asChild size="sm" variant="secondary">
                        <Link href={returnTo}>
                            <ArrowLeft className="size-4" />
                            {t("connections.hub.back")}
                        </Link>
                    </Button>
                </div>
            ) : null}
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                <div className="relative min-w-0 flex-1">
                    <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 shrink-0 -translate-y-1/2 text-muted-foreground" />
                    <Input
                        type="search"
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                        placeholder={t("connections.hub.search")}
                        aria-label={t("connections.hub.search")}
                        className="pl-8"
                    />
                </div>
                <div
                    role="group"
                    aria-label={t("connections.hub.categories")}
                    className="flex flex-wrap gap-1"
                >
                    {[null, ...CONNECTION_CATEGORIES.map((entry) => entry.id)].map((id) => (
                        <Button
                            key={id ?? "all"}
                            size="sm"
                            variant={category === id ? "secondary" : "ghost"}
                            aria-pressed={category === id}
                            onClick={() => setCategory(id)}
                        >
                            {t(`connections.hub.category.${id ?? "all"}` as const)}
                            <span
                                className="text-xs text-muted-foreground tabular-nums"
                                title={t("connections.hub.connectedCount")}
                            >
                                {
                                    providers.filter(
                                        (entry) =>
                                            (id === null || entry.category === id) &&
                                            entry.accounts.length > 0
                                    ).length
                                }
                            </span>
                        </Button>
                    ))}
                </div>
            </div>
            {sections.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                    {t("connections.hub.noMatch", { query: query.trim() })}
                </p>
            ) : null}
            {sections.map((section) => (
                <section
                    key={section.id}
                    aria-labelledby={`connections-${section.id}`}
                    className="flex flex-col gap-3"
                >
                    <h2
                        id={`connections-${section.id}`}
                        className="text-sm font-medium text-muted-foreground"
                    >
                        {t(`connections.hub.category.${section.id}` as const)}
                    </h2>
                    {section.providers.map((provider) => (
                        <ProviderCard
                            key={provider.slug}
                            provider={provider}
                            notice={notice?.provider === provider.slug ? notice : null}
                            returnTo={returnTo}
                            focused={focused === provider.slug}
                        />
                    ))}
                </section>
            ))}
        </div>
    );
}

function ProviderCard({
    provider,
    notice,
    returnTo = null,
    focused = false
}: {
    provider: ConnectionProviderCard;
    notice: { text: string; bad: boolean } | null;
    returnTo?: string | null;
    focused?: boolean;
}) {
    const router = useRouter();
    const t = useTranslations("account");
    const [pending, startTransition] = useTransition();
    const [removed, setRemoved] = useState<string[]>([]);
    const [confirming, setConfirming] = useState<LinkedAccount | null>(null);
    const [tokenOpen, setTokenOpen] = useState(false);
    const [typing, setTyping] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const accounts = useMemo(
        () => provider.accounts.filter((account) => !removed.includes(account.id)),
        [provider.accounts, removed]
    );
    // A typed name holds no slot: connecting the real account replaces it, so it
    // must not be what stands in the way of connecting the real account.
    const typed = accounts.find((account) => account.method === "manual") ?? null;
    const proved = accounts.filter((account) => account.method !== "manual");
    const slotsLeft = Math.max(0, provider.limit - proved.length);
    // Offered only while nothing is proved: a verified account is the better
    // answer, and typing over it would trade it for a claim.
    const canType = Boolean(provider.acceptsTypedName) && proved.length === 0 && provider.limit > 0;
    // Whether any of them is short of what this deployment now asks for, which
    // changes what the line under a full list should be telling somebody to do.
    const needsApproval = accounts.some((account) => account.needsReauthorization);
    const canAdd = slotsLeft > 0;

    function disconnect(account: LinkedAccount) {
        setConfirming(null);
        setError(null);
        setRemoved((current) => [...current, account.id]);
        startTransition(async () => {
            const result = await runAction(
                () => disconnectAccountAction(account.id),
                (message) => setError(message)
            );
            if (!result || result.error) {
                setRemoved((current) => current.filter((id) => id !== account.id));
                if (result?.error) setError(result.error);
                return;
            }
            router.refresh();
        });
    }

    return (
        <Card
            id={`connection-${provider.slug}`}
            data-focused={focused ? "" : undefined}
            className={focused ? "ring-2 ring-primary/60" : undefined}
        >
            <CardBody className="flex flex-col gap-3">
                <div className="flex items-start gap-3">
                    <div className="grid size-10 shrink-0 place-items-center rounded-md border border-border bg-surface">
                        <IntegrationLogo slug={provider.slug} className="size-6" />
                    </div>
                    <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                            <h3 className="truncate text-sm font-medium">{provider.name}</h3>
                            {provider.limit > 1 ? (
                                <Badge variant="neutral">
                                    {t("connections.ofLimit", {
                                        count: accounts.length,
                                        limit: provider.limit
                                    })}
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
                                    <img
                                        src={account.avatarUrl}
                                        alt=""
                                        className="size-6 shrink-0 rounded-full"
                                    />
                                ) : (
                                    <IntegrationLogo
                                        slug={provider.slug}
                                        className="size-5 shrink-0"
                                    />
                                )}
                                <span className="min-w-0 flex-1 truncate text-sm">
                                    {account.label}
                                </span>
                                {account.needsReauthorization ? (
                                    <Badge
                                        variant="warning"
                                        title={
                                            account.missingScopes?.length
                                                ? t("connections.badges.notGranted", {
                                                      scopes: account.missingScopes.join(", ")
                                                  })
                                                : t("connections.badges.connectAgain")
                                        }
                                    >
                                        {t("connections.badges.needsApproving")}
                                    </Badge>
                                ) : null}
                                {account.signsIn ? (
                                    <Badge
                                        variant="neutral"
                                        title={t("connections.badges.signsInTitle")}
                                    >
                                        {t("connections.badges.signsIn")}
                                    </Badge>
                                ) : null}
                                {account.method === "token" ? (
                                    <Badge
                                        variant="neutral"
                                        title={t("connections.badges.tokenTitle")}
                                    >
                                        {t("connections.badges.token")}
                                    </Badge>
                                ) : null}
                                {provider.acceptsTypedName && !provider.typedOnly ? (
                                    account.method === "manual" ? (
                                        <Badge
                                            variant="warning"
                                            title={t("connections.badges.notVerifiedTitle")}
                                        >
                                            {t("connections.badges.notVerified")}
                                        </Badge>
                                    ) : (
                                        <Badge
                                            variant="success"
                                            title={t("connections.badges.verifiedTitle", {
                                                provider: provider.name
                                            })}
                                        >
                                            {t("connections.badges.verified")}
                                        </Badge>
                                    )
                                ) : null}
                                <span className="hidden text-xs text-muted-foreground sm:inline">
                                    <RelativeTime iso={account.linkedAt} />
                                </span>
                                {account.method === "oauth" && provider.canAuthorize ? (
                                    /*
                                     * Authorize this same account again, in place.
                                     *
                                     * Without it, approving a widened consent meant
                                     * disconnecting and connecting - because Connect is
                                     * capped by the account limit, and somebody already at
                                     * it is told to disconnect one first. Two deliberate
                                     * actions, one of them destructive, to grant a
                                     * permission.
                                     *
                                     * Nothing is spent: the store upserts on
                                     * (provider, accountId), so an account its owner
                                     * already holds is refreshed rather than counted
                                     * again, and the sign-in choice on the row is left
                                     * alone because only a first write sets it.
                                     */
                                    <Button
                                        size="sm"
                                        variant={
                                            account.needsReauthorization ? "secondary" : "ghost"
                                        }
                                        aria-label={
                                            account.needsReauthorization
                                                ? t("connections.reconnectToApprove", {
                                                      account: account.label
                                                  })
                                                : t("connections.reconnect", {
                                                      account: account.label
                                                  })
                                        }
                                        title={
                                            account.needsReauthorization
                                                ? t("connections.reconnectToApprove", {
                                                      account: account.label
                                                  })
                                                : t("connections.reconnect", {
                                                      account: account.label
                                                  })
                                        }
                                        disabled={pending}
                                        onClick={() =>
                                            router.push(linkHref(provider.slug, returnTo))
                                        }
                                    >
                                        <RefreshCw className="size-4" />
                                    </Button>
                                ) : null}
                                {account.method === "manual" ? (
                                    <Button
                                        size="sm"
                                        variant="ghost"
                                        aria-label={t("connections.change", {
                                            account: account.label
                                        })}
                                        title={t("connections.change", { account: account.label })}
                                        disabled={pending}
                                        onClick={() => setTyping(true)}
                                    >
                                        <Pencil className="size-4" />
                                    </Button>
                                ) : null}
                                <Button
                                    size="sm"
                                    variant="ghost"
                                    aria-label={t("connections.disconnect", {
                                        account: account.label
                                    })}
                                    title={t("connections.disconnect", { account: account.label })}
                                    disabled={pending}
                                    onClick={() => setConfirming(account)}
                                >
                                    <Unlink className="size-4" />
                                </Button>
                            </li>
                        ))}
                    </ul>
                ) : (
                    <p className="text-sm text-muted-foreground">
                        {t("connections.none", { provider: provider.name })}
                    </p>
                )}

                <p className="text-xs text-muted-foreground">
                    {provider.description}
                    {provider.canSignIn ? (
                        <>
                            {" "}
                            {t.rich<ReactNode>("connections.canSignIn", {
                                link: (chunks) => (
                                    <Link
                                        key="link"
                                        href="/account/security"
                                        className="underline underline-offset-2 hover:text-foreground"
                                    >
                                        {chunks}
                                    </Link>
                                )
                            })}
                        </>
                    ) : null}
                </p>

                {provider.canAuthorize || provider.acceptsToken || canType ? (
                    <div className="flex flex-wrap items-center gap-2">
                        {provider.canAuthorize ? (
                            <Button
                                size="sm"
                                variant="secondary"
                                disabled={!canAdd || pending}
                                onClick={() => router.push(linkHref(provider.slug, returnTo))}
                            >
                                <Plus className="size-4" />
                                {t("connections.connectProvider", { provider: provider.name })}
                            </Button>
                        ) : null}
                        {provider.acceptsToken ? (
                            <Button
                                size="sm"
                                variant="ghost"
                                disabled={!canAdd || pending}
                                onClick={() => setTokenOpen(true)}
                            >
                                <KeyRound className="size-4" />
                                {t("connections.useToken")}
                            </Button>
                        ) : null}
                        {/* Once a name is typed, changing it is the pencil on its row. */}
                        {canType && !typed ? (
                            <Button
                                size="sm"
                                variant={provider.canAuthorize ? "ghost" : "secondary"}
                                disabled={pending}
                                onClick={() => setTyping(true)}
                            >
                                <Pencil className="size-4" />
                                {provider.typedOnly
                                    ? t("connections.enterUsername")
                                    : t("connections.typeUsername")}
                            </Button>
                        ) : null}
                        {!canAdd && (provider.canAuthorize || provider.acceptsToken) ? (
                            <span className="text-xs text-muted-foreground">
                                {needsApproval
                                    ? // The literal advice - disconnect one first - is true of
                                      // connecting a different account and useless here, where
                                      // what is wanted is the one already listed, authorized
                                      // again. Pointing at the wrong action is what made people
                                      // unlink a working account to grant a permission.
                                      t("connections.useReconnect")
                                    : t("connections.disconnectOne")}
                            </span>
                        ) : null}
                    </div>
                ) : null}

                {!provider.canAuthorize && !provider.acceptsToken && !canType ? (
                    <p className="text-sm text-muted-foreground">
                        {t("connections.availableOnce", { requires: provider.requires })}
                    </p>
                ) : null}

                {error ? <p className="text-sm text-danger">{error}</p> : null}
                {notice ? (
                    <p className={`text-sm ${notice.bad ? "text-danger" : "text-success"}`}>
                        {notice.text}
                    </p>
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

            {/* AWS asks for three things rather than one, because it issues no
                token at all - a request is signed with the secret. */}
            {tokenOpen && provider.slug === "aws" ? (
                <AwsDialog
                    onClose={() => setTokenOpen(false)}
                    onDone={() => {
                        setTokenOpen(false);
                        router.refresh();
                    }}
                />
            ) : null}

            {typing && (provider.slug === "minecraft" || provider.slug === "lastfm") ? (
                <TypedNameDialog
                    kind={provider.slug}
                    current={typed?.label ?? null}
                    onClose={() => setTyping(false)}
                    onDone={() => {
                        setTyping(false);
                        router.refresh();
                    }}
                />
            ) : null}

            {tokenOpen && provider.slug !== "aws" ? (
                <TokenDialog
                    provider={provider.slug}
                    providerName={provider.name}
                    label={provider.tokenLabel ?? t("connections.token.accessToken")}
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

/**
 * What disconnecting this one account actually stops, said for that account.
 *
 * One sentence served every service and spoke of repositories and runner pools
 * - true of GitHub and nonsense on a Minecraft name somebody typed.
 */
function disconnectSays(
    account: LinkedAccount,
    providerName: string,
    t: NamespaceTranslator<"account">
): string {
    if (account.method === "manual") return t("connections.disconnectDialog.manual");
    if (account.provider === "github")
        return t("connections.disconnectDialog.github", { provider: providerName });
    return account.signsIn
        ? t("connections.disconnectDialog.signsIn", { provider: providerName })
        : t("connections.disconnectDialog.other", { provider: providerName });
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
    const t = useTranslations("account");
    const tc = useTranslations("common");
    return (
        <Dialog open onOpenChange={(open) => (open ? undefined : onCancel())}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>
                        {account.method === "manual"
                            ? t("connections.disconnectDialog.removeTitle", {
                                  account: account.label
                              })
                            : t("connections.disconnectDialog.title", { account: account.label })}
                    </DialogTitle>
                    <DialogDescription>
                        {disconnectSays(account, providerName, t)}
                    </DialogDescription>
                </DialogHeader>
                <div className="flex justify-end gap-2">
                    <Button variant="ghost" onClick={onCancel}>
                        {tc("actions.cancel")}
                    </Button>
                    <Button onClick={onConfirm}>{t("connections.disconnectDialog.confirm")}</Button>
                </div>
            </DialogContent>
        </Dialog>
    );
}

/**
 * AWS, which has no token to paste.
 *
 * Every other service here issues one string; AWS issues a key and a secret, and
 * signs each request with them. The region is asked for at the same time because
 * a key is not regional and everything it reaches is - the same key lists nothing
 * at all in the wrong region, with no error to say why, which is the one failure
 * somebody would spend an afternoon on.
 */
function AwsDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
    const t = useTranslations("account");
    const tc = useTranslations("common");
    const [accessKeyId, setAccessKeyId] = useState("");
    const [secretAccessKey, setSecretAccessKey] = useState("");
    const [region, setRegion] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();

    const ready = accessKeyId.trim() && secretAccessKey.trim() && region.trim();

    function submit() {
        setError(null);
        startTransition(async () => {
            const result = await runAction(
                () =>
                    connectAwsAction({
                        accessKeyId: accessKeyId.trim(),
                        secretAccessKey: secretAccessKey.trim(),
                        region: region.trim()
                    }),
                (message) => setError(message)
            );
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
                    <DialogTitle>{t("connections.aws.title")}</DialogTitle>
                    <DialogDescription>{t("connections.aws.description")}</DialogDescription>
                </DialogHeader>
                <div className="flex flex-col gap-3">
                    <label className="flex flex-col gap-1.5">
                        <span className="text-sm font-medium">
                            {t("connections.aws.accessKeyId")}
                        </span>
                        <Input
                            autoComplete="off"
                            value={accessKeyId}
                            // i18n-ignore: the shape of an AWS key
                            placeholder="AKIA..."
                            onChange={(event) => setAccessKeyId(event.target.value)}
                        />
                    </label>
                    <label className="flex flex-col gap-1.5">
                        <span className="text-sm font-medium">
                            {t("connections.aws.secretAccessKey")}
                        </span>
                        <Input
                            type="password"
                            autoComplete="off"
                            value={secretAccessKey}
                            onChange={(event) => setSecretAccessKey(event.target.value)}
                        />
                    </label>
                    <label className="flex flex-col gap-1.5">
                        <span className="text-sm font-medium">{t("connections.aws.region")}</span>
                        <Input
                            autoComplete="off"
                            value={region}
                            placeholder="eu-west-1"
                            onChange={(event) => setRegion(event.target.value)}
                        />
                        <span className="text-xs text-muted-foreground">
                            {t("connections.aws.regionHint")}
                        </span>
                    </label>
                    {error ? <p className="text-sm text-danger">{error}</p> : null}
                </div>
                <DialogFooter>
                    <Button variant="ghost" onClick={onClose} disabled={pending}>
                        {tc("actions.cancel")}
                    </Button>
                    <Button onClick={submit} disabled={pending || !ready}>
                        {pending ? <Loader2 className="size-4 animate-spin" /> : null}
                        {t("connections.connect")}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

/** What each service that takes a typed name checks it with and saves it through. */
const TYPED_NAMES = {
    minecraft: {
        schema: minecraftNameSchema,
        save: (name: string) => saveMinecraftNameAction(name),
        maxLength: 32,
        example: "Steve"
    },
    lastfm: {
        schema: lastfmNameSchema,
        save: (name: string) => saveLastfmNameAction(name),
        maxLength: 64,
        example: "listener_01"
    }
} as const;

/**
 * A Minecraft or Last.fm username, typed rather than proved.
 *
 * Checked as it is typed against the same schema the action checks, so what the
 * form accepts is what gets saved. An empty field is unfinished rather than
 * wrong, so it says nothing until there is something to judge, and saving the
 * name that is already there is not offered.
 */
function TypedNameDialog({
    kind,
    current,
    onClose,
    onDone
}: {
    kind: keyof typeof TYPED_NAMES;
    /** The name typed before, when this is a change. */
    current: string | null;
    onClose: () => void;
    onDone: () => void;
}) {
    const t = useTranslations("account");
    const tc = useTranslations("common");
    const [name, setName] = useState(current ?? "");
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();

    // A schema names its complaint by catalog key or, the older ones, in English.
    const said = (message: string | undefined) =>
        message && t.has(message) ? t(message as Parameters<typeof t>[0]) : message;
    const typed = TYPED_NAMES[kind];
    const checked = typed.schema.safeParse(name);
    const problem =
        name.trim().length > 0 && !checked.success
            ? (said(checked.error.issues[0]?.message) ?? null)
            : null;
    const unchanged = checked.success && checked.data === current;

    function submit() {
        if (!checked.success || unchanged) return;
        setError(null);
        startTransition(async () => {
            const result = await runAction(
                () => typed.save(checked.data),
                (message) => setError(message)
            );
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
                    <DialogTitle>
                        {current
                            ? t(`connections.${kind}.changeTitle`)
                            : t(`connections.${kind}.typeTitle`)}
                    </DialogTitle>
                    <DialogDescription>{t(`connections.${kind}.description`)}</DialogDescription>
                </DialogHeader>
                <form
                    className="flex flex-col gap-2"
                    onSubmit={(event) => {
                        event.preventDefault();
                        submit();
                    }}
                >
                    <label className="text-sm font-medium" htmlFor={`${kind}-name`}>
                        {t(`connections.${kind}.username`)}
                    </label>
                    <Input
                        id={`${kind}-name`}
                        autoFocus
                        autoComplete="off"
                        spellCheck={false}
                        maxLength={typed.maxLength}
                        value={name}
                        placeholder={typed.example}
                        aria-invalid={problem ? true : undefined}
                        aria-describedby={`${kind}-name-hint`}
                        onChange={(event) => setName(event.target.value)}
                    />
                    <p
                        id={`${kind}-name-hint`}
                        className={`text-xs ${problem ? "text-danger" : "text-muted-foreground"}`}
                    >
                        {problem ?? t(`connections.${kind}.hint`)}
                    </p>
                    {error ? <p className="text-sm text-danger">{error}</p> : null}
                </form>
                <DialogFooter>
                    <Button variant="ghost" onClick={onClose} disabled={pending}>
                        {tc("actions.cancel")}
                    </Button>
                    <Button onClick={submit} disabled={pending || !checked.success || unchanged}>
                        {pending ? <Loader2 className="size-4 animate-spin" /> : null}
                        {tc("actions.save")}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

function TokenDialog({
    provider,
    providerName,
    label,
    help,
    tokenUrl,
    onClose,
    onDone
}: {
    /** Which service this token is for. Passed rather than assumed: the form is
     *  the same for all of them and the call behind it is not. */
    provider: string;
    providerName: string;
    label: string;
    help?: string;
    tokenUrl?: string;
    onClose: () => void;
    onDone: () => void;
}) {
    const t = useTranslations("account");
    const tc = useTranslations("common");
    const [token, setToken] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();

    function submit() {
        setError(null);
        startTransition(async () => {
            const result = await runAction(
                () => connectTokenAction(provider, token),
                (message) => setError(message)
            );
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
                    <DialogTitle>
                        {t("connections.token.title", { provider: providerName })}
                    </DialogTitle>
                    <DialogDescription>
                        {t("connections.token.description", { provider: providerName })}
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
                            {t("connections.token.createOne")}
                            <ExternalLink className="size-3" />
                        </a>
                    ) : null}
                    {error ? <p className="text-sm text-danger">{error}</p> : null}
                </div>
                <DialogFooter>
                    <Button variant="ghost" onClick={onClose} disabled={pending}>
                        {tc("actions.cancel")}
                    </Button>
                    <Button onClick={submit} disabled={pending || token.trim().length === 0}>
                        {pending ? <Loader2 className="size-4 animate-spin" /> : null}
                        {t("connections.connect")}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
