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

/** A stored one, as the card needs it. Never the credential - only that there is
 *  one, and enough to remove it. */
export interface StoredSignin {
    readonly id: string;
    readonly provider: string;
}

interface SigninActions {
    add: (input: unknown) => Promise<{ error?: string }>;
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
                        {tier === "platform" ? "The deployment's agent sign-ins" : "Agent sign-ins"}
                    </h2>
                    <p className="text-muted-foreground text-xs">
                        {tier === "platform"
                            ? "Signs an agent in for anybody whose own account does not. Each account's own is used first, and the bill for these is yours."
                            : "What a session on this box signs an agent in with. A session on a server you have already signed the tool in on uses that instead and needs nothing here."}
                    </p>
                </div>

                {error ? <p className="text-sm text-red-400">{error}</p> : null}

                <div className="flex flex-col gap-2">
                    {signins.map((signin) => (
                        <SigninRow
                            key={signin.slug}
                            signin={signin}
                            held={stored.find((row) => row.provider === signin.slug) ?? null}
                            fromPlatform={covered.has(signin.env)}
                            tier={tier}
                            actions={actions}
                            assisted={Boolean(actions.assist) && ASSISTED.has(signin.env)}
                            onError={setError}
                        />
                    ))}
                </div>
            </CardBody>
        </Card>
    );
}

function SigninRow({
    signin,
    held,
    fromPlatform,
    tier,
    actions,
    assisted,
    onError
}: {
    signin: AgentSignin;
    held: StoredSignin | null;
    fromPlatform: boolean;
    tier: SigninTier;
    actions: SigninActions;
    assisted: boolean;
    onError: (message: string | null) => void;
}) {
    const [secret, setSecret] = useState("");
    const [signingIn, setSigningIn] = useState(false);
    const [removing, setRemoving] = useState(false);
    const [busy, startTransition] = useTransition();
    const router = useRouter();

    const save = () => {
        onError(null);
        startTransition(() => {
            void runAction(
                () =>
                    actions.add({
                        provider: signin.slug,
                        // Not asked for. There is one of each of these, so a field
                        // that only ever gets one answer is a field that should
                        // not have been put on the screen.
                        name: signin.env.toLowerCase().replace(/_/g, "-").slice(0, 20),
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
                router.refresh();
            });
        });
    };

    const remove = () => {
        if (!held) return;
        startTransition(() => {
            void runAction(() => actions.remove({ id: held.id }), onError).then((result) => {
                if (result?.error) onError(result.error);
                setRemoving(false);
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
                {signin.subscription ? <Badge variant="neutral">Subscription</Badge> : null}
                {held ? (
                    <Badge variant="success">
                        <Check className="size-3 shrink-0" />
                        {tier === "platform" ? "Set" : "Yours"}
                    </Badge>
                ) : fromPlatform ? (
                    // Held by the deployment and shared. Worth saying rather than
                    // leaving the row looking empty: nothing is missing, the work
                    // will run, and whoever is reading is about to go and pay for
                    // a second credential they do not need. Their own would still
                    // be used first, which is why the field stays.
                    <Badge variant="neutral">From this Polaris</Badge>
                ) : null}
                {held ? (
                    <Button size="sm" variant="ghost" onClick={() => setRemoving(true)} disabled={busy}>
                        <Trash2 className="size-4 shrink-0" />
                    </Button>
                ) : null}
            </div>

            <p className="text-muted-foreground mt-1 text-xs">
                Signs in {serves}.
                {fromPlatform && !held ? " This deployment already provides one, so nothing here is needed." : ""}
            </p>

            {held ? null : (
                <div className="mt-2 flex flex-wrap items-center gap-2">
                    {/* The assisted route first, and as the filled button, because
                        it is the one that works for somebody who has never opened
                        a terminal. The field stays beside it: an administrator
                        pasting a credential they already hold should not have to
                        sit through a login to do it. */}
                    {assisted ? (
                        <Button size="sm" onClick={() => setSigningIn(true)} disabled={busy}>
                            <Wand2 className="size-4 shrink-0" />
                            Sign in here
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
                        save: (value: string) =>
                            actions.add({
                                provider: signin.slug,
                                name: signin.env.toLowerCase().replace(/_/g, "-").slice(0, 20),
                                secret: value,
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
                open={removing}
                onOpenChange={setRemoving}
                name={signin.label}
                kind="sign-in"
                requireTyping={false}
                title={`Remove the ${signin.label}?`}
                description="Sessions on this box will stop being able to sign that agent in. Nothing already running is stopped."
                confirmLabel="Remove"
                onConfirm={remove}
            />
        </div>
    );
}
