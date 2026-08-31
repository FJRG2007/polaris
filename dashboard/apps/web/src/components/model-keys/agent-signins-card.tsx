"use client";

/**
 * Linking the account an agent signs in with.
 *
 * The credentials that no model provider serves. A Claude subscription token is
 * the one that matters most: most people running Claude Code run it on a plan
 * rather than on metered credits, and until this existed the only thing Polaris
 * could offer them was an Anthropic API key - which is asking somebody to start
 * paying a second time for work their subscription already covers.
 *
 * One row per credential rather than a list you add to, because that is what
 * these are: there is exactly one Claude subscription token that matters, and a
 * screen that let somebody keep six of them in an order would be a screen built
 * for a problem nobody has. The stored one is never shown again - it is removed
 * and re-linked, not edited.
 *
 * enigma:allow-no-reset - the masked field here is a credential being pasted in,
 * not a password being entered: nobody signs in on this screen, there is no
 * account behind the value, and a "forgot it" link would lead to the vendor's
 * page, which the row already links to. The person is already signed in to
 * Polaris to be looking at it.
 */

import { useRouter } from "next/navigation";
import { runAction } from "@/lib/run-action";
import { AgentLogo } from "@/components/logos";
import { useState, useTransition } from "react";
import type { AgentSignin } from "@/lib/agents/agent-signins";
import { Check, ExternalLink, Loader2, Trash2, Wand2 } from "lucide-react";
import { SigninDialog, type SigninDialogActions } from "./signin-dialog";
import { Badge, Button, Card, CardBody, ConfirmDeleteDialog, Input } from "@polaris/ui";

/**
 * A stored one, as the card needs it.
 *
 * Never the credential itself - only that there is one, what its owner calls it,
 * whose account it turned out to be, and enough to remove it.
 *
 * `lastUsedAt` is the closest thing to consumption there is here, and it is
 * deliberately the only one. What a subscription has spent lives with the
 * vendor and Polaris cannot ask; a figure invented for this screen would read as
 * fact and never be re-checked.
 */
export interface StoredSignin {
    readonly id: string;
    readonly provider: string;
    readonly name: string;
    /** Whose account it is, as the login reported. Empty for one linked by
     *  pasting, or by a tool that would not say. */
    readonly config: Record<string, unknown>;
    readonly lastUsedAt: string | null;
}

interface SigninActions {
    add: (input: unknown) => Promise<{ error?: string }>;
    /** Puts them in the order they are tried in, exactly as the provider keys
     *  are ordered. Absent where a screen shows one of each. */
    reorder?: (input: unknown) => Promise<{ error?: string }>;
    remove: (input: unknown) => Promise<{ error?: string }>;
    /** The assisted flow, where Polaris supplies the machine and runs the
     *  vendor's own login on it. Absent on a screen that only takes a paste -
     *  the deployment's own, where an administrator is signing in an account
     *  that is not theirs to authorise in a browser. */
    assist?: Omit<SigninDialogActions, "save">;
}

/**
 * Whose credentials this card is editing.
 *
 * The two tiers are the same two the model keys have, for the same reason: a
 * deployment holds accounts of its own that an administrator sets once and
 * everybody runs on, and a person can bring their own instead. Which one is
 * being edited changes every sentence on the card - and, on the account tier,
 * whether a row that is already covered still needs anything at all.
 */
export type SigninTier = "account" | "platform";

/**
 * Which credentials Polaris can run the login for.
 *
 * Mirrors `LOGIN_COMMANDS` in the sign-in runtime, and is a set rather than a
 * flag on the catalogue because it is a property of what Polaris can DO rather
 * than of the credential: a vendor whose login command nobody has sourced still
 * has a perfectly good credential, it just cannot be walked through. A row that
 * is not here shows the field on its own, which is the screen that existed
 * before any of this.
 */
const ASSISTED = new Set(["CLAUDE_CODE_OAUTH_TOKEN"]);

/** What the paste field says when the button beside it is the better route. */
const PASTE = "Or paste a ";

export function AgentSigninsCard({
    signins,
    stored,
    platform = [],
    tier = "account",
    actions
}: {
    signins: AgentSignin[];
    stored: StoredSignin[];
    /** Variables the deployment provides and shares. Account tier only: it is
     *  what turns "not linked" into "already covered, and not by you". */
    platform?: readonly string[];
    tier?: SigninTier;
    actions: SigninActions;
}) {
    const [error, setError] = useState<string | null>(null);
    const covered = new Set(platform);

    return (
        <Card>
            <CardBody className="flex flex-col gap-3">
                <div>
                    <h2 className="text-sm font-medium">
                        {tier === "platform" ? "The deployment's agent accounts" : "Agent accounts"}
                    </h2>
                    <p className="text-muted-foreground text-xs">
                        {tier === "platform"
                            ? "Signs an agent in for anybody whose own account does not. Each account's own is used first, and the bill for these is yours."
                            : "What a session on this box signs an agent in with. A session on a server you have already signed the tool in on uses that instead and needs nothing here."}
                    </p>
                </div>

                {error ? <p className="text-sm text-red-400">{error}</p> : null}

                {/* Two groups, and the order is the recommendation. A coding agent
                    reads a repository and writes to it all day, so the metered
                    route is the expensive one by a wide margin - listing the two
                    together as interchangeable ways to fill one slot is how
                    somebody ends up paying per token for work a plan they already
                    hold would have covered. */}
                <Group
                    title="Subscriptions"
                    hint="A plan you already pay a flat rate for. Signing one in costs nothing extra, and Polaris can do it for you."
                    rows={signins.filter((signin) => signin.subscription)}
                    stored={stored}
                    covered={covered}
                    tier={tier}
                    actions={actions}
                    onError={setError}
                />
                <Group
                    title="API keys"
                    hint="Metered from the first token. Use one where the vendor offers no subscription, or where you would rather bill per run."
                    rows={signins.filter((signin) => !signin.subscription)}
                    stored={stored}
                    covered={covered}
                    tier={tier}
                    actions={actions}
                    onError={setError}
                />
            </CardBody>
        </Card>
    );
}

/** One heading and its rows, or nothing at all when there are none of that kind
 *  - an empty heading is a section somebody reads twice looking for what is
 *  under it. */
function Group({
    title,
    hint,
    rows,
    stored,
    covered,
    tier,
    actions,
    onError
}: {
    title: string;
    hint: string;
    rows: AgentSignin[];
    stored: StoredSignin[];
    covered: Set<string>;
    tier: SigninTier;
    actions: SigninActions;
    onError: (message: string | null) => void;
}) {
    if (rows.length === 0) return null;
    return (
        <div className="flex flex-col gap-2">
            <div>
                <h3 className="text-xs font-medium">{title}</h3>
                <p className="text-muted-foreground text-xs">{hint}</p>
            </div>
            {rows.map((signin) => (
                <SigninRow
                    key={signin.slug}
                    signin={signin}
                    accounts={stored.filter((row) => row.provider === signin.slug)}
                    fromPlatform={covered.has(signin.env)}
                    tier={tier}
                    actions={actions}
                    assisted={Boolean(actions.assist) && ASSISTED.has(signin.env)}
                    onError={onError}
                />
            ))}
        </div>
    );
}

function SigninRow({
    signin,
    accounts,
    fromPlatform,
    tier,
    actions,
    assisted,
    onError
}: {
    signin: AgentSignin;
    accounts: StoredSignin[];
    fromPlatform: boolean;
    tier: SigninTier;
    actions: SigninActions;
    assisted: boolean;
    onError: (message: string | null) => void;
}) {
    const [secret, setSecret] = useState("");
    const [signingIn, setSigningIn] = useState(false);
    const [removing, setRemoving] = useState<StoredSignin | null>(null);
    const [busy, startTransition] = useTransition();
    const router = useRouter();

    const save = () => {
        onError(null);
        startTransition(() => {
            void runAction(
                () =>
                    actions.add({
                        provider: signin.slug,
                        // Numbered, because an account may hold several and the
                        // store keeps names unique. Nothing is known about a
                        // pasted credential - there was no login to ask - so it
                        // is named after what it is and its owner renames it.
                        name: nextName(signin.env, accounts),
                        secret: secret.trim(),
                        expiresAt: null
                    }),
                onError
            ).then((result) => {
                if (result?.error) {
                    onError(result.error);
                    return;
                }
                setSecret("");
                // The refresh rather than a local flag: the row that comes back
                // carries whose account it is, which is something only the
                // server knows. Showing one without it and swapping it a moment
                // later is a worse second than waiting for the real one.
                router.refresh();
            });
        });
    };

    const remove = () => {
        if (!removing) return;
        const id = removing.id;
        startTransition(() => {
            void runAction(() => actions.remove({ id }), onError).then((result) => {
                if (result?.error) onError(result.error);
                setRemoving(null);
                router.refresh();
            });
        });
    };

    const serves = signin.serves.map((tool) => tool.label).join(", ");
    return (
        <div className="rounded-md border border-border p-3">
            <div className="flex flex-wrap items-center gap-2">
                {/* The first tool it signs in, as the face of the credential: that
                    is what somebody recognises, and a variable's name is not. */}
                <AgentLogo
                    id={signin.serves[0]?.id ?? "custom"}
                    label={signin.serves[0]?.label ?? signin.label}
                    className="size-4 shrink-0"
                />
                <span className="min-w-0 flex-1 truncate text-sm" title={signin.label}>{signin.label}</span>
                {accounts.length > 0 ? (
                    <Badge variant="success">
                        <Check className="size-3 shrink-0" />
                        {accounts.length === 1
                            ? tier === "platform"
                                ? "Set"
                                : "Yours"
                            : `${accounts.length} accounts`}
                    </Badge>
                ) : fromPlatform ? (
                    // Held by the deployment and shared. Worth saying rather than
                    // leaving the row looking empty: nothing is missing, the work
                    // will run, and whoever is reading is about to go and pay for
                    // a second credential they do not need. Their own would still
                    // be used first, which is why the field stays.
                    <Badge variant="neutral">From this Polaris</Badge>
                ) : null}
            </div>

            <p className="text-muted-foreground mt-1 text-xs">
                Signs in {serves}.
                {fromPlatform && accounts.length === 0
                    ? " This deployment already provides one, so nothing here is needed."
                    : ""}
            </p>

            {/* One line per account, in the order they are tried. Several is the
                ordinary case rather than the exotic one - a personal
                subscription and a work one - and it is the whole reason the
                identity is read at the end of a login: two rows called "Claude
                subscription token" are a list nobody can choose from. */}
            {accounts.length > 0 ? (
                <ul className="mt-2 flex flex-col gap-1">
                    {accounts.map((account, index) => (
                        <li
                            key={account.id}
                            className="flex flex-wrap items-center gap-2 rounded border border-border px-2 py-1.5"
                        >
                            <span className="text-muted-foreground w-4 shrink-0 text-center text-xs">
                                {index + 1}
                            </span>
                            <span className="min-w-0 flex-1 truncate text-xs">
                                {identityOf(account) ?? account.name}
                            </span>
                            {identityOf(account) ? (
                                <span className="text-muted-foreground shrink-0 text-xs">{account.name}</span>
                            ) : null}
                            <span className="text-muted-foreground shrink-0 text-xs">
                                {account.lastUsedAt
                                    ? `used ${new Date(account.lastUsedAt).toLocaleDateString()}`
                                    : "never used"}
                            </span>
                            <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => setRemoving(account)}
                                disabled={busy}
                                aria-label={`Remove ${account.name}`}
                            >
                                <Trash2 className="size-4 shrink-0" />
                            </Button>
                        </li>
                    ))}
                </ul>
            ) : null}

            {/* Always offered, even once there is one: an account may hold a
                personal subscription and a work one, and the field beside the
                button is for somebody pasting a credential they already have. */}
            {(
                <div className="mt-2 flex flex-wrap items-center gap-2">
                    {/* The assisted route first, and as the filled button, because
                        it is the one that works for somebody who has never opened
                        a terminal. The field stays beside it: an administrator
                        pasting a credential they already hold should not have to
                        sit through a login to do it. */}
                    {assisted ? (
                        <Button size="sm" onClick={() => setSigningIn(true)} disabled={busy}>
                            <Wand2 className="size-4 shrink-0" />
                            {accounts.length > 0 ? "Add another" : "Sign in here"}
                        </Button>
                    ) : null}
                    <Input
                        type="password"
                        value={secret}
                        onChange={(event) => setSecret(event.target.value)}
                        placeholder={assisted ? PASTE + signin.label.toLowerCase() : signin.label}
                        className="min-w-0 flex-1"
                    />
                    <Button
                        size="sm"
                        variant={assisted ? "ghost" : "primary"}
                        onClick={save}
                        disabled={busy || secret.trim().length === 0}
                    >
                        {busy ? <Loader2 className="size-4 shrink-0 animate-spin" /> : null}
                        Link
                    </Button>
                    <a
                        href={signin.url}
                        target="_blank"
                        rel="noreferrer"
                        className="text-muted-foreground inline-flex items-center gap-1 text-xs underline"
                    >
                        Where to get one
                        <ExternalLink className="size-3 shrink-0" />
                    </a>
                </div>
            )}

            {signingIn && actions.assist ? (
                <SigninDialog
                    signin={signin}
                    actions={{
                        ...actions.assist,
                        // Stored through the same write as the field beside it, so
                        // a credential that arrived by either route is checked
                        // exactly as carefully.
                        save: (value: string, identity, chosen: string) =>
                            actions.add({
                                provider: signin.slug,
                                name: chosen,
                                secret: value,
                                // Whose account it is, stored beside it. It is the
                                // only thing that tells two subscriptions apart
                                // once they are both in the list.
                                identity,
                                expiresAt: null
                            })
                    }}
                    onClose={() => setSigningIn(false)}
                    onDone={() => {
                        setSigningIn(false);
                        router.refresh();
                    }}
                />
            ) : null}

            {/* No typing to confirm: this is one credential of several on a
                screen, and it can be linked again in a minute from the same row.
                The rule is the component's own - typing is for the things that
                hold other work. */}
            <ConfirmDeleteDialog
                open={removing !== null}
                onOpenChange={(open) => !open && setRemoving(null)}
                name={removing?.name ?? signin.label}
                kind="sign-in"
                requireTyping={false}
                title={`Remove ${removing?.name ?? "this account"}?`}
                // Says what removing does NOT do, which is the part that matters.
                // A token minted by one of these lives a year at the vendor and
                // Polaris cannot revoke it - forgetting a credential here and
                // believing it dead is how one stays valid on somebody's account
                // long after they thought they had taken it back.
                description="Sessions on this box will stop being able to sign that agent in. Nothing already running is stopped, and the credential itself keeps working: Polaris can forget it, but only the vendor can revoke it, on your account settings with them."
                confirmLabel="Remove"
                onConfirm={remove}
            />
        </div>
    );
}

/** Whose account a row belongs to, or null where the login would not say. The
 *  address, since that is what somebody holding two of these tells them apart
 *  by; the organisation only when there is no address. */
function identityOf(account: StoredSignin): string | null {
    const email = account.config.email;
    if (typeof email === "string" && email.trim()) return email.trim();
    const organization = account.config.organization;
    if (typeof organization === "string" && organization.trim()) return organization.trim();
    return null;
}

/**
 * A name no other row of this owner's is using.
 *
 * The store keeps names unique across a whole account, so a second credential
 * pasted for the same thing collides with the first - and the failure is a
 * dialog refusing to save with a message about a name the person never typed.
 * Numbered from what is already there.
 */
function nextName(env: string, accounts: StoredSignin[]): string {
    const base = env.toLowerCase().replace(/_/g, "-").slice(0, 16);
    if (!accounts.some((account) => account.name === base)) return base;
    for (let index = 2; index < 100; index += 1) {
        const candidate = `${base}-${index}`;
        if (!accounts.some((account) => account.name === candidate)) return candidate;
    }
    return `${base}-${Date.now() % 1000}`;
}
