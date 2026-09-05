"use client";

/**
 * Joining on an invite, and whatever this instance asks of the new account next.
 *
 * When a second factor is required, arming it happens here rather than on the
 * enrollment screen: that screen asks for the password before it will start,
 * which is right for a session that has been open since yesterday and absurd four
 * seconds after somebody chose that password to join with. The value already in
 * the form is handed over instead, and nothing is stored to carry it - the page
 * never navigates.
 */

import { signIn } from "@/lib/auth-client";
import { useRouter } from "next/navigation";
import { acceptInviteAction } from "./actions";
import { useZodForm } from "@/lib/use-zod-form";
import { useState, type FormEvent } from "react";
import { EnrollView } from "@/app/oauth/enroll/enroll-view";
import { PasswordState } from "@/components/password-state";
import { usePasswordSafety } from "@/lib/use-password-safety";
import { acceptInviteSchema, normalizePersonName } from "@polaris/core";
import { pendingEnrollmentAction, type PendingEnrollment } from "@/app/oauth/enroll/actions";
import { Button, Card, CardBody, CardHeader, CardTitle, Input, PolarisMark } from "@polaris/ui";

export function AcceptInviteForm({
    token,
    code,
    email,
    needsPassword
}: {
    /** The invite arrived either as a link or as a code. */
    token?: string;
    code?: string;
    email: string;
    /** It also asks for a one-time password, handed over separately. */
    needsPassword: boolean;
}) {
    const router = useRouter();
    const form = useZodForm(acceptInviteSchema);
    const [values, setValues] = useState({ name: "", username: "", password: "" });
    const [oneTimePassword, setOneTimePassword] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [pending, setPending] = useState(false);
    /** The second factor this instance still wants, once the account exists. */
    const [enrollment, setEnrollment] = useState<PendingEnrollment | null>(null);
    // Refused before the submit rather than after it: the address is the invite's,
    // and the name and username are being chosen in the fields above. The hook runs
    // passwordMatchesIdentity over these and asks the breach corpus; claimInviteSchema
    // refuses both again on the server, which is the copy that decides.
    const identity = [values.name, values.username, email];
    const passwordError = usePasswordSafety(values.password, identity);

    function update(field: "name" | "username" | "password", value: string) {
        const next = { ...values, [field]: value };
        setValues(next);
        form.revalidate(next);
    }

    async function onSubmit(event: FormEvent) {
        event.preventDefault();
        const parsed = form.submit(values);
        if (!parsed || passwordError) {
            if (passwordError) setError(passwordError);
            return;
        }
        setPending(true);
        setError(null);
        const result = await acceptInviteAction({
            token: token ?? "",
            code: code ?? "",
            oneTimePassword,
            name: parsed.name,
            username: parsed.username,
            password: parsed.password
        });
        if (result.error || !result.email) {
            setPending(false);
            setError(result.error ?? "Could not accept the invite");
            return;
        }
        await signIn.email({ email: result.email, password: parsed.password });
        // Asked now rather than letting the session guard bounce them into the
        // enrollment screen, which is a navigation this password does not survive.
        const owed = await pendingEnrollmentAction().catch(() => null);
        if (owed) {
            setPending(false);
            setEnrollment(owed);
            return;
        }
        router.push("/");
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
                    router.push("/");
                    router.refresh();
                }}
            />
        );
    }

    return (
        <main className="grid min-h-screen place-items-center p-4">
            <Card className="w-full max-w-sm">
                <CardHeader className="items-center">
                    <PolarisMark className="mb-1" />
                    <CardTitle>Accept your invite</CardTitle>
                </CardHeader>
                <CardBody>
                    <p className="mb-3 text-sm text-muted-foreground">
                        Joining as <span className="font-medium text-foreground">{email}</span>.
                    </p>
                    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-3">
                        <div className="flex flex-col gap-1">
                            <label className="text-sm">Your name</label>
                            <Input
                                autoComplete="name"
                                autoCapitalize="words"
                                autoCorrect="off"
                                spellCheck={false}
                                value={values.name}
                                onChange={(event) => update("name", event.target.value)}
                                // On blur rather than on every keystroke: normalizing
                                // as somebody types moves the caret and breaks
                                // composing a name on an IME. The server normalizes
                                // it again, and that is the copy that is stored.
                                onBlur={() => {
                                    update("name", normalizePersonName(values.name));
                                    form.markTouched("name");
                                }}
                                aria-invalid={Boolean(form.error("name"))}
                            />
                            {form.error("name") ? <p className="text-xs text-danger">{form.error("name")}</p> : null}
                        </div>
                        <div className="flex flex-col gap-1">
                            <label className="text-sm">Username</label>
                            <Input
                                autoComplete="username"
                                placeholder="ada"
                                value={values.username}
                                onChange={(event) => update("username", event.target.value)}
                                onBlur={() => form.markTouched("username")}
                                aria-invalid={Boolean(form.error("username"))}
                            />
                            {form.error("username") ? (
                                <p className="text-xs text-danger">{form.error("username")}</p>
                            ) : null}
                        </div>
                        <div className="flex flex-col gap-1">
                            <label className="text-sm">Password</label>
                            {/* Checked against the breach corpus as it is typed and
                                against the account's own identity, by
                                usePasswordSafety above; both are refused again on
                                the server, which is the enforcement point. */}
                            <Input
                                type="password"
                                autoComplete="new-password"
                                placeholder="10+ characters"
                                value={values.password}
                                onChange={(event) => update("password", event.target.value)}
                                onBlur={() => form.markTouched("password")}
                                aria-invalid={Boolean(form.error("password") ?? passwordError)}
                            />
                            {form.error("password") ?? passwordError ? (
                                <p className="text-xs text-danger">{form.error("password") ?? passwordError}</p>
                            ) : null}
                            {/* And what is true about it either way. The refusal
                                above only appears once the password is long
                                enough to be judged, so without this the breach
                                check is invisible until it fails. */}
                            <PasswordState password={values.password} />
                        </div>
                        {needsPassword ? (
                            <div className="flex flex-col gap-1">
                                <label className="text-sm">One-time password</label>
                                <Input
                                    type="password"
                                    autoComplete="off"
                                    value={oneTimePassword}
                                    onChange={(event) => setOneTimePassword(event.target.value)}
                                />
                                <p className="text-xs text-muted-foreground">
                                    Whoever invited you sent this separately from the invite itself.
                                </p>
                            </div>
                        ) : null}
                        {error ? <p className="text-sm text-danger">{error}</p> : null}
                        {/* Not live before there is anything to send. A submit
                            that offers itself over an empty form teaches people
                            to press it and read the failure, which is the
                            slowest way to fill one in - and here the failure
                            costs a round trip that creates nothing. */}
                        <Button
                            type="submit"
                            disabled={
                                pending ||
                                !form.complete(values) ||
                                Boolean(passwordError) ||
                                (needsPassword && oneTimePassword === "")
                            }
                        >
                            {pending ? "Joining..." : "Join Polaris"}
                        </Button>
                    </form>
                </CardBody>
            </Card>
        </main>
    );
}
