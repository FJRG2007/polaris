"use client";

import Link from "next/link";
import { KeyRound } from "lucide-react";
import { QrSignInPanel } from "./qr-panel";
import { useRouter } from "next/navigation";
import { loginSchema } from "@polaris/core";
import { useZodForm } from "@/lib/use-zod-form";
import { IntegrationLogo } from "@/components/logos";
import { postLoginTarget } from "./post-login-target";
import { authClient, signIn } from "@/lib/auth-client";
import { useEffect, useState, type FormEvent } from "react";
import { EnrollView } from "@/app/oauth/enroll/enroll-view";
import { accountHasPasskey, emailLinkOffered, resolveIdentifier } from "./actions";
import { pendingEnrollmentAction, type PendingEnrollment } from "@/app/oauth/enroll/actions";
import { Button, Card, CardBody, CardHeader, CardTitle, Input, PolarisMark } from "@polaris/ui";

/** Where the last-used identifier is remembered so the field is prefilled. */
const LAST_IDENTIFIER_KEY = "polaris:last-identifier";
const GENERIC_ERROR = "Invalid email/username or password";

/** Why the previous session ended, when it ended for a reason worth explaining.
 *  Deliberately vague about network rules: the page is public, so it says the
 *  access was refused without describing the rule that refused it. */
const SESSION_NOTICES: Readonly<Record<string, string>> = {
    banned: "That account has been suspended.",
    expired: "Your session reached its time limit. Sign in again.",
    blocked: "Sign-in is not allowed from this location.",
    denied: "That sign-in was denied from another device."
};

/**
 * How a sign-in with a linked account ended, when it did not end signed in.
 *
 * `refused` is deliberately one answer for several: the account is not linked
 * here, its owner does not allow it as a way in, or the operator does not. Any
 * more detail would tell whoever holds that account something about this
 * deployment that is not theirs to know.
 */
const CONNECTION_NOTICES: Readonly<Record<string, string>> = {
    refused: "That account cannot sign in here. Sign in another way, then connect it and allow it under Security.",
    unavailable: "That way of signing in is turned off here.",
    cancelled: "That sign-in was cancelled.",
    state_error: "That sign-in did not start on this page. Try again.",
    error: "That service could not complete the sign-in."
};

function sessionNotice(): string | null {
    const params = new URLSearchParams(window.location.search);
    for (const [key, message] of Object.entries(SESSION_NOTICES)) {
        if (params.get(key) === "1") return message;
    }
    // Checked for ownership rather than indexed straight: the value is the
    // caller's to write, and "toString" would otherwise resolve through the
    // prototype into something that is not a message at all.
    const outcome = params.get("signin") ?? "";
    return Object.hasOwn(CONNECTION_NOTICES, outcome) ? CONNECTION_NOTICES[outcome]! : null;
}

/** An outside service this deployment can sign somebody in with. */
export interface SignInProvider {
    slug: string;
    name: string;
}

export function LoginForm({
    awaitingSetup,
    providers
}: {
    awaitingSetup: boolean;
    /** The services offered as a way in. Empty on a deployment whose operator
     *  has connected none or allows none. */
    providers: SignInProvider[];
}) {
    const router = useRouter();
    const form = useZodForm(loginSchema);
    const [values, setValues] = useState({ identifier: "", password: "" });
    const [error, setError] = useState<string | null>(null);
    const [notice, setNotice] = useState<string | null>(null);
    const [pending, setPending] = useState(false);
    const [canEmailLink, setCanEmailLink] = useState(false);
    const [linkSent, setLinkSent] = useState(false);
    const [hasPasskey, setHasPasskey] = useState(false);
    /** Set when signing in worked and this deployment still wants a second
     *  factor from the account. The whole screen becomes that step. */
    const [enrollment, setEnrollment] = useState<PendingEnrollment | null>(null);

    // Prefill the identifier with the one used last on this device, and explain
    // why the last session ended if it ended for a reason.
    useEffect(() => {
        const remembered = window.localStorage.getItem(LAST_IDENTIFIER_KEY);
        if (remembered) setValues((prev) => ({ ...prev, identifier: remembered }));
        setNotice(sessionNotice());
    }, []);

    // Look up the ways in the typed account has beyond its password - a passkey,
    // a link it can be sent - so each is offered without the user having to
    // remember they set it up, and neither is offered to an account that would
    // get nothing out of pressing it. Debounced because it runs as they type, and
    // re-asked from scratch whenever the identifier changes.
    useEffect(() => {
        const identifier = values.identifier.trim();
        if (!identifier) {
            setHasPasskey(false);
            setCanEmailLink(false);
            return;
        }
        let current = true;
        const timer = setTimeout(() => {
            void accountHasPasskey(identifier).then((found) => {
                if (current) setHasPasskey(found);
            });
            void emailLinkOffered(identifier).then((offered) => {
                if (current) setCanEmailLink(offered);
            });
        }, 400);
        return () => {
            current = false;
            clearTimeout(timer);
        };
    }, [values.identifier]);

    /**
     * Hand the browser to a provider's own screen.
     *
     * A full navigation rather than a fetch: what comes back is a redirect chain
     * that ends by setting this deployment's own cookies, and where it lands is
     * decided by the callback - the app, or the second-factor challenge.
     */
    function signInWithProvider(slug: string) {
        setPending(true);
        window.location.href = `/api/connections/${slug}/signin?redirect=${encodeURIComponent(postLoginTarget())}`;
    }

    /** Sign in with the device's passkey. The ceremony is the browser's; a
     *  cancelled prompt just leaves the form as it was. */
    async function signInWithPasskey() {
        setPending(true);
        setError(null);
        const result = await authClient.signIn.passkey();
        setPending(false);
        if (result?.error) {
            setError("That passkey did not work. Use your password instead.");
            return;
        }
        window.localStorage.setItem(LAST_IDENTIFIER_KEY, values.identifier.trim());
        router.push(postLoginTarget());
        router.refresh();
    }

    /**
     * Email a one-time sign-in link. The answer is the same whether or not the
     * address has an account: the page must not become a way to find out which
     * addresses are registered here.
     */
    async function sendLink() {
        const identifier = values.identifier.trim();
        if (!identifier) {
            form.markTouched("identifier");
            return;
        }
        setPending(true);
        setError(null);
        const email = await resolveIdentifier(identifier);
        if (email) {
            await authClient.signIn.magicLink({ email, callbackURL: postLoginTarget() });
        }
        setPending(false);
        setLinkSent(true);
    }

    function update(field: "identifier" | "password", value: string) {
        const next = { ...values, [field]: value };
        setValues(next);
        form.revalidate(next);
    }

    async function onSubmit(event: FormEvent) {
        event.preventDefault();
        const parsed = form.submit(values);
        if (!parsed) return;
        setPending(true);
        setError(null);
        // An identifier may be an email or a username; resolve it to the email.
        const email = await resolveIdentifier(parsed.identifier);
        if (!email) {
            setPending(false);
            setError(GENERIC_ERROR);
            return;
        }
        const { data, error: signInError } = await signIn.email({ email, password: parsed.password });
        setPending(false);
        if (signInError) {
            setError(GENERIC_ERROR);
            return;
        }
        window.localStorage.setItem(LAST_IDENTIFIER_KEY, parsed.identifier);
        // With a second factor armed, the password alone issues no session: the
        // challenge page completes the sign-in. Carry the destination across.
        if ((data as { twoFactorRedirect?: boolean } | null)?.twoFactorRedirect) {
            router.push(`/oauth/2fa?redirect=${encodeURIComponent(postLoginTarget())}`);
            return;
        }
        // An account that owes this deployment a second factor is about to be
        // sent to the enrollment screen by the session guard - and arming one
        // costs the password, which that screen would have to ask for again.
        // Asked here instead, so it happens on the page still holding the
        // password typed two seconds ago. Nothing is stored to make that work:
        // it is the value in this form's own state, and the page never
        // navigates. The same hand-off registering and accepting an invite
        // already do.
        // Held busy across the question: the screen is about to change either
        // way, and a form that goes live again for half a second invites a
        // second sign-in nobody meant to make.
        setPending(true);
        const owed = await pendingEnrollmentAction().catch(() => null);
        if (owed) {
            setEnrollment(owed);
            return;
        }
        router.push(postLoginTarget());
        router.refresh();
    }

    if (enrollment) {
        return (
            <EnrollView
                account={enrollment.account}
                name={enrollment.name}
                options={enrollment.options}
                password={values.password}
                onDone={() => {
                    router.push(postLoginTarget());
                    router.refresh();
                }}
            />
        );
    }

    return (
        <main className="grid min-h-screen place-items-center p-4">
            <Card className="w-full max-w-sm sm:max-w-2xl">
                <CardHeader className="items-center">
                    <PolarisMark className="mb-1" />
                    <CardTitle>Sign in to Polaris</CardTitle>
                </CardHeader>
                {/* The QR sits beside the form from the `sm` breakpoint up, and is
                    left out below it - a phone cannot scan its own screen. */}
                <CardBody className="grid gap-6 sm:grid-cols-2">
                    <div>
                    {notice ? (
                        <p className="mb-3 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                            {notice}
                        </p>
                    ) : null}
                    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-3">
                        <div className="flex flex-col gap-1">
                            <Input
                                placeholder="Email or username"
                                autoComplete="username"
                                value={values.identifier}
                                onChange={(event) => update("identifier", event.target.value)}
                                onBlur={() => form.markTouched("identifier")}
                                aria-invalid={Boolean(form.error("identifier"))}
                            />
                            {form.error("identifier") ? (
                                <p className="text-xs text-danger">{form.error("identifier")}</p>
                            ) : null}
                        </div>
                        <div className="flex flex-col gap-1">
                            <Input
                                type="password"
                                placeholder="Password"
                                autoComplete="current-password"
                                value={values.password}
                                onChange={(event) => update("password", event.target.value)}
                                onBlur={() => form.markTouched("password")}
                                aria-invalid={Boolean(form.error("password"))}
                            />
                            {form.error("password") ? (
                                <p className="text-xs text-danger">{form.error("password")}</p>
                            ) : null}
                        </div>
                        {error ? <p className="text-sm text-danger">{error}</p> : null}
                        <Button type="submit" disabled={pending}>
                            {pending ? "Signing in..." : "Sign in"}
                        </Button>
                        {hasPasskey ? (
                            <Button
                                type="button"
                                variant="secondary"
                                disabled={pending}
                                onClick={() => void signInWithPasskey()}
                            >
                                <KeyRound className="size-4" />
                                Use your passkey
                            </Button>
                        ) : null}
                        {providers.length > 0 ? (
                            <div className="flex flex-col gap-2">
                                <span className="text-center text-xs text-muted-foreground">or</span>
                                {providers.map((provider) => (
                                    <Button
                                        key={provider.slug}
                                        type="button"
                                        variant="secondary"
                                        disabled={pending}
                                        onClick={() => signInWithProvider(provider.slug)}
                                    >
                                        <IntegrationLogo slug={provider.slug} className="size-4" />
                                        Continue with {provider.name}
                                    </Button>
                                ))}
                            </div>
                        ) : null}
                        {canEmailLink ? (
                            linkSent ? (
                                <p className="text-center text-xs text-muted-foreground">
                                    If that account exists, a sign-in link is on its way. It works
                                    once and expires in 10 minutes.
                                </p>
                            ) : (
                                <Button
                                    type="button"
                                    variant="ghost"
                                    disabled={pending}
                                    onClick={() => void sendLink()}
                                >
                                    Email me a sign-in link
                                </Button>
                            )
                        ) : null}
                    </form>
                    <p className="mt-4 text-center text-xs text-muted-foreground">
                        <Link href="/oauth/recover" className="underline underline-offset-2 hover:text-foreground">
                            Forgot your password?
                        </Link>
                    </p>
                    {awaitingSetup ? (
                        <p className="mt-2 text-center text-xs text-muted-foreground">
                            New accounts are by invitation. Setting up a new instance? The installer
                            printed the link that creates the administrator;{" "}
                            <code className="rounded bg-muted px-1">polaris setup</code> prints it again.
                        </p>
                    ) : null}
                    </div>
                    <QrSignInPanel />
                </CardBody>
            </Card>
        </main>
    );
}
