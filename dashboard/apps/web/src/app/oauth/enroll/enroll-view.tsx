"use client";

/**
 * The step that arms a second factor, for somebody who has just been told they
 * need one.
 *
 * Two ways in, and which of them are drawn is decided on the server from what this
 * deployment can actually do - so nobody is offered an emailed code on an instance
 * with no way to send mail. The authenticator is always among them, which is what
 * makes this screen always completable.
 *
 * The authenticator path runs through better-auth's browser client, the same calls
 * the Account > Security dialog makes, because two ways of arming the same factor
 * that are not the same code are two things to keep in step. The email path is a
 * server action, because the code and the factor are both Polaris's to mint.
 *
 * Backup codes end both paths and are shown once. They are the way back in for an
 * account whose phone is gone or whose mail has stopped, and this is the only time
 * anybody sees them - so the screen does not leave until they have been
 * acknowledged.
 *
 * Both paths need the account's password, because arming a factor is a change to
 * how the account is signed into and better-auth asks to see it again before
 * making one. That is right for somebody who has been signed in since yesterday
 * and wrong for somebody who typed it four seconds ago to register - so when
 * registering renders this itself it hands the password over, and neither path
 * asks for it. Nothing is stored anywhere to make that work: it is the same value
 * still sitting in the form's own state, on the page that never navigated away.
 */

import { QRCodeSVG } from "qrcode.react";
import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth-client";
import { KeyRound, Mail, ShieldCheck } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { Button, Card, CardBody, Input, PolarisMark } from "@polaris/ui";
import { SECOND_FACTOR_ENROLLMENT_INFO, type SecondFactorEnrollment } from "@polaris/core";
import { armByEmailAction, noteAuthenticatorArmedAction, sendEnrollmentCodeAction } from "./actions";

/** One way in, as the server decided this deployment can offer it. */
export interface EnrollmentChoice {
    factor: SecondFactorEnrollment;
    target: string | null;
}

/** The `secret` query parameter of an otpauth:// URI, for typing by hand when a
 *  camera is not to hand. */
function secretFromUri(uri: string): string {
    try {
        return new URL(uri).searchParams.get("secret") ?? "";
    } catch {
        return "";
    }
}

const FACTOR_ICON = { totp: KeyRound, email: Mail } as const;

export function EnrollView({
    account,
    name,
    options,
    password,
    onDone
}: {
    account: string;
    name: string;
    options: EnrollmentChoice[];
    /** The account's password, when whoever rendered this already has it because
     *  it was typed a moment ago. Absent on the enrollment page, which is reached
     *  by a session that may be a day old. */
    password?: string;
    /** Where the flow goes once the backup codes have been acknowledged. Defaults
     *  to the dashboard. */
    onDone?: () => void;
}) {
    const router = useRouter();
    // Only one way in means there is nothing to choose, so the screen starts on it
    // rather than asking a question with one answer.
    const [factor, setFactor] = useState<SecondFactorEnrollment | null>(
        options.length === 1 ? (options[0]?.factor ?? null) : null
    );
    const [backupCodes, setBackupCodes] = useState<string[] | null>(null);

    if (backupCodes) {
        return (
            <BackupCodes
                codes={backupCodes}
                account={account}
                onDone={onDone ?? (() => router.replace("/"))}
            />
        );
    }

    return (
        <main className="mx-auto flex min-h-dvh w-full max-w-lg flex-col justify-center gap-6 p-6">
            <header className="flex flex-col gap-3">
                <PolarisMark className="size-8" />
                <h1 className="text-lg font-medium">Add a second step to signing in</h1>
                <p className="text-sm text-muted-foreground">
                    This Polaris asks every account for one. Your password stays as it is; from now on
                    signing in also asks for a code. You are signed in as {name} ({account}).
                </p>
            </header>

            {factor === null ? (
                <div className="flex flex-col gap-2">
                    {options.map((option) => {
                        const info = SECOND_FACTOR_ENROLLMENT_INFO[option.factor];
                        const Icon = FACTOR_ICON[option.factor];
                        return (
                            <button
                                key={option.factor}
                                type="button"
                                onClick={() => setFactor(option.factor)}
                                className="group flex items-start gap-3 rounded-lg border border-border bg-card p-4 text-left transition-colors hover:border-primary hover:bg-primary/5"
                            >
                                <span className="grid size-9 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground group-hover:bg-primary/10 group-hover:text-primary">
                                    <Icon className="size-5" />
                                </span>
                                <span className="flex min-w-0 flex-col">
                                    <span className="text-sm font-medium">{info.label}</span>
                                    <span className="text-xs text-muted-foreground">{info.description}</span>
                                    {option.target ? (
                                        <span className="mt-1 text-xs text-muted-foreground">{option.target}</span>
                                    ) : null}
                                </span>
                            </button>
                        );
                    })}
                </div>
            ) : factor === "email" ? (
                <EmailFactor
                    target={options.find((option) => option.factor === "email")?.target ?? account}
                    {...(password === undefined ? {} : { password })}
                    onArmed={setBackupCodes}
                    onBack={options.length > 1 ? () => setFactor(null) : null}
                />
            ) : (
                <AuthenticatorFactor
                    {...(password === undefined ? {} : { password })}
                    onArmed={setBackupCodes}
                    onBack={options.length > 1 ? () => setFactor(null) : null}
                />
            )}
        </main>
    );
}

/** A code sent to the address the account signs in with. Answering it confirms
 *  the address as well as arming the factor, which is why nothing asks the person
 *  to click a verification link afterwards. */
function EmailFactor({
    target,
    password,
    onArmed,
    onBack
}: {
    target: string;
    /** Known already when this is rendered by registering, so the form does not
     *  ask for it a second time. */
    password?: string;
    onArmed: (codes: string[]) => void;
    onBack: (() => void) | null;
}) {
    const [sent, setSent] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    async function send() {
        setBusy(true);
        setError(null);
        const result = await sendEnrollmentCodeAction();
        setBusy(false);
        if (result.error) {
            setError(result.error);
            return;
        }
        setSent(true);
    }

    async function arm(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        setBusy(true);
        setError(null);
        const result = await armByEmailAction(
            password ?? String(form.get("password") ?? ""),
            String(form.get("code") ?? "")
        );
        setBusy(false);
        if (result.error) {
            setError(result.error);
            return;
        }
        onArmed(result.backupCodes ?? []);
    }

    return (
        <Card>
            <CardBody className="flex flex-col gap-4">
                <div>
                    <h2 className="text-sm font-medium">Email code</h2>
                    <p className="text-xs text-muted-foreground">
                        Codes go to {target}. Keep that mailbox reachable - it is how you sign in from now on.
                    </p>
                </div>

                {!sent ? (
                    <Button onClick={() => void send()} disabled={busy}>
                        {busy ? "Sending..." : "Send me a code"}
                    </Button>
                ) : (
                    <form className="flex flex-col gap-3" onSubmit={(event) => void arm(event)}>
                        <label className="flex flex-col gap-1 text-sm">
                            Code from the email
                            <Input name="code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} required />
                        </label>
                        {password === undefined ? (
                            <label className="flex flex-col gap-1 text-sm">
                                Your password
                                <Input name="password" type="password" autoComplete="current-password" required />
                            </label>
                        ) : null}
                        <div className="flex items-center gap-2">
                            <Button type="submit" disabled={busy}>
                                {busy ? "Turning on..." : "Turn on"}
                            </Button>
                            <Button type="button" variant="ghost" onClick={() => void send()} disabled={busy}>
                                Send another
                            </Button>
                        </div>
                    </form>
                )}

                {error ? <p className="text-xs text-destructive">{error}</p> : null}
                {onBack ? (
                    <button type="button" className="self-start text-xs text-muted-foreground underline" onClick={onBack}>
                        Use something else
                    </button>
                ) : null}
            </CardBody>
        </Card>
    );
}

/** The authenticator, armed through better-auth exactly as Account > Security
 *  arms it: password, then the secret, then a code that proves the app works. */
function AuthenticatorFactor({
    password,
    onArmed,
    onBack
}: {
    /** Known already when this is rendered by registering, in which case the
     *  secret is fetched on sight and nothing asks for a password. */
    password?: string;
    onArmed: (codes: string[]) => void;
    onBack: (() => void) | null;
}) {
    const [totpUri, setTotpUri] = useState("");
    const [codes, setCodes] = useState<string[]>([]);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    async function start(given: string): Promise<void> {
        setBusy(true);
        setError(null);
        const { data, error: enableError } = await authClient.twoFactor.enable({ password: given });
        setBusy(false);
        if (enableError || !data) {
            setError(enableError?.message ?? "Could not start setup. Check your password.");
            return;
        }
        setTotpUri(data.totpURI);
        setCodes(data.backupCodes);
    }

    // Nothing to ask for, so nothing is asked: the secret is fetched as the step
    // opens and the person lands straight on the QR code. Guarded on the secret
    // rather than on a ref, so a second run cannot mint a second one over the
    // first - which would leave the app holding a secret the account no longer has.
    useEffect(() => {
        if (password === undefined || totpUri.length > 0 || busy) return;
        void start(password);
        // Only the password decides whether this runs, and it does not change
        // while the step is open.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [password]);

    async function verify(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        const code = String(new FormData(event.currentTarget).get("code") ?? "");
        setBusy(true);
        setError(null);
        const { error: verifyError } = await authClient.twoFactor.verifyTotp({ code });
        if (verifyError) {
            setBusy(false);
            setError("That code did not match. Check the clock on your device and try again.");
            return;
        }
        // The server hears about the authenticator from here, because better-auth
        // armed it without passing through one.
        await noteAuthenticatorArmedAction();
        setBusy(false);
        onArmed(codes);
    }

    const secret = secretFromUri(totpUri);

    return (
        <Card>
            <CardBody className="flex flex-col gap-4">
                <div>
                    <h2 className="text-sm font-medium">Authenticator app</h2>
                    <p className="text-xs text-muted-foreground">
                        Any authenticator works - the one built into your phone, or a password manager.
                    </p>
                </div>

                {!totpUri ? (
                    password !== undefined ? (
                        <p className="text-xs text-muted-foreground">
                            {busy || error === null ? "Setting up..." : "Setup did not start."}
                        </p>
                    ) : (
                        <form
                            className="flex flex-col gap-3"
                            onSubmit={(event) => {
                                event.preventDefault();
                                void start(String(new FormData(event.currentTarget).get("password") ?? ""));
                            }}
                        >
                            <label className="flex flex-col gap-1 text-sm">
                                Your password
                                <Input name="password" type="password" autoComplete="current-password" required />
                            </label>
                            <Button type="submit" disabled={busy}>
                                {busy ? "Starting..." : "Continue"}
                            </Button>
                        </form>
                    )
                ) : (
                    <form className="flex flex-col gap-3" onSubmit={(event) => void verify(event)}>
                        <div className="self-center rounded-md bg-white p-3">
                            <QRCodeSVG value={totpUri} size={168} />
                        </div>
                        <p className="break-all text-center text-xs text-muted-foreground">
                            Or type this in: <span className="font-mono">{secret}</span>
                        </p>
                        <label className="flex flex-col gap-1 text-sm">
                            Code from the app
                            <Input name="code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} required />
                        </label>
                        <Button type="submit" disabled={busy}>
                            {busy ? "Turning on..." : "Turn on"}
                        </Button>
                    </form>
                )}

                {error ? <p className="text-xs text-destructive">{error}</p> : null}
                {onBack ? (
                    <button type="button" className="self-start text-xs text-muted-foreground underline" onClick={onBack}>
                        Use something else
                    </button>
                ) : null}
            </CardBody>
        </Card>
    );
}

/**
 * The codes, once.
 *
 * Deliberately a wall in the way rather than a note beside the "done" button: an
 * account whose only factor is an emailed code and whose mail provider stops
 * working has these and nothing else, and the moment this screen closes nobody -
 * including an administrator - can read them back.
 */
function BackupCodes({ codes, account, onDone }: { codes: string[]; account: string; onDone: () => void }) {
    const [kept, setKept] = useState(false);
    const text = codes.join("\n");

    return (
        <main className="mx-auto flex min-h-dvh w-full max-w-lg flex-col justify-center gap-6 p-6">
            <header className="flex flex-col gap-3">
                <ShieldCheck className="size-8 text-primary" />
                <h1 className="text-lg font-medium">Two-step verification is on</h1>
                <p className="text-sm text-muted-foreground">
                    These are your way back into {account} if you lose the thing that gives you codes. Each
                    one works once. This is the only time they are shown.
                </p>
            </header>

            <Card>
                <CardBody className="flex flex-col gap-3">
                    <ul className="grid grid-cols-2 gap-1 font-mono text-sm">
                        {codes.map((code) => (
                            <li key={code}>{code}</li>
                        ))}
                    </ul>
                    <div className="flex flex-wrap gap-2">
                        <Button variant="outline" onClick={() => void navigator.clipboard.writeText(text)}>
                            Copy
                        </Button>
                        <Button
                            variant="outline"
                            onClick={() => {
                                const blob = new Blob([text], { type: "text/plain" });
                                const url = URL.createObjectURL(blob);
                                const link = document.createElement("a");
                                link.href = url;
                                link.download = "polaris-backup-codes.txt";
                                link.click();
                                URL.revokeObjectURL(url);
                            }}
                        >
                            Download
                        </Button>
                    </div>
                </CardBody>
            </Card>

            <label className="flex items-start gap-2 text-sm">
                <input
                    type="checkbox"
                    className="mt-1"
                    checked={kept}
                    onChange={(event) => setKept(event.target.checked)}
                />
                I have saved these somewhere I can reach without this account.
            </label>
            <Button disabled={!kept} onClick={onDone}>
                Continue to Polaris
            </Button>
        </main>
    );
}
