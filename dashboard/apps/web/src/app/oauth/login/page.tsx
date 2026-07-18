"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { loginSchema } from "@polaris/core";
import { Button, Card, CardBody, CardHeader, CardTitle, Input, PolarisMark } from "@polaris/ui";
import { signIn } from "@/lib/auth-client";
import { useZodForm } from "@/lib/use-zod-form";

/** Where the last-used email is remembered so the field is prefilled next time. */
const LAST_EMAIL_KEY = "polaris:last-email";

export default function LoginPage() {
    const router = useRouter();
    const form = useZodForm(loginSchema);
    const [values, setValues] = useState({ email: "", password: "" });
    const [error, setError] = useState<string | null>(null);
    const [pending, setPending] = useState(false);

    // Prefill the email with the one used last on this device.
    useEffect(() => {
        const remembered = window.localStorage.getItem(LAST_EMAIL_KEY);
        if (remembered) setValues((prev) => ({ ...prev, email: remembered }));
    }, []);

    function update(field: "email" | "password", value: string) {
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
        const { error: signInError } = await signIn.email(parsed);
        setPending(false);
        if (signInError) {
            setError(signInError.message ?? "Sign-in failed");
            return;
        }
        window.localStorage.setItem(LAST_EMAIL_KEY, parsed.email);
        router.push("/drive");
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
                                type="email"
                                placeholder="you@example.com"
                                autoComplete="email"
                                value={values.email}
                                onChange={(event) => update("email", event.target.value)}
                                onBlur={() => form.markTouched("email")}
                                aria-invalid={Boolean(form.error("email"))}
                            />
                            {form.error("email") ? (
                                <p className="text-xs text-danger">{form.error("email")}</p>
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
