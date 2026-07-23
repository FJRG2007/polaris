"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { loginSchema } from "@polaris/core";
import { Button, Card, CardBody, CardHeader, CardTitle, Input, PolarisMark } from "@polaris/ui";
import { signIn } from "@/lib/auth-client";
import { useZodForm } from "@/lib/use-zod-form";
import { resolveIdentifier } from "./actions";

/** Where the last-used identifier is remembered so the field is prefilled. */
const LAST_IDENTIFIER_KEY = "polaris:last-identifier";
const GENERIC_ERROR = "Invalid email/username or password";

/** Post-login destination: a same-origin `redirect` param (used by the edge login
 *  handoff at /edge/authorize) if it is a safe relative path, else the drive. Read
 *  from window.location to avoid a Suspense boundary for useSearchParams. */
function postLoginTarget(): string {
    const redirect = new URLSearchParams(window.location.search).get("redirect");
    return redirect && redirect.startsWith("/") && !redirect.startsWith("//") ? redirect : "/drive";
}

export default function LoginPage() {
    const router = useRouter();
    const form = useZodForm(loginSchema);
    const [values, setValues] = useState({ identifier: "", password: "" });
    const [error, setError] = useState<string | null>(null);
    const [pending, setPending] = useState(false);

    // Prefill the identifier with the one used last on this device.
    useEffect(() => {
        const remembered = window.localStorage.getItem(LAST_IDENTIFIER_KEY);
        if (remembered) setValues((prev) => ({ ...prev, identifier: remembered }));
    }, []);

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
        const { error: signInError } = await signIn.email({ email, password: parsed.password });
        setPending(false);
        if (signInError) {
            setError(GENERIC_ERROR);
            return;
        }
        window.localStorage.setItem(LAST_IDENTIFIER_KEY, parsed.identifier);
        router.push(postLoginTarget());
        router.refresh();
    }

    return (
        <main className="grid min-h-screen place-items-center p-4">
            <Card className="w-full max-w-sm">
                <CardHeader className="items-center">
                    <PolarisMark className="mb-1" />
                    <CardTitle>Sign in to Polaris</CardTitle>
                </CardHeader>
                <CardBody>
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
                    </form>
                    <p className="mt-4 text-center text-xs text-muted-foreground">
                        New accounts are by invitation. Setting up a new instance? Run{" "}
                        <code className="rounded bg-muted px-1">polaris setup</code> on the server for a
                        setup link.
                    </p>
                </CardBody>
            </Card>
        </main>
    );
}
