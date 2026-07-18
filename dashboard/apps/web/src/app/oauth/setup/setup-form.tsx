"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { setupSchema } from "@polaris/core";
import { Button, Card, CardBody, CardHeader, CardTitle, Input, PolarisMark } from "@polaris/ui";
import { signIn } from "@/lib/auth-client";
import { useZodForm } from "@/lib/use-zod-form";
import { completeSetupAction } from "./actions";

type Field = "name" | "email" | "password" | "token";

export function SetupForm({
    tokenConfigured,
    initialToken
}: {
    tokenConfigured: boolean;
    initialToken: string;
}) {
    const router = useRouter();
    const form = useZodForm(setupSchema);
    const [values, setValues] = useState({ name: "", email: "", password: "", token: initialToken });
    const [error, setError] = useState<string | null>(null);
    const [pending, setPending] = useState(false);

    function update(field: Field, value: string) {
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
        const result = await completeSetupAction(parsed);
        if (result.error) {
            setPending(false);
            setError(result.error);
            return;
        }
        // Sign the new administrator straight in.
        await signIn.email({ email: parsed.email, password: parsed.password });
        router.push("/drive");
        router.refresh();
    }

    const fields: Array<{ name: Field; label: string; type?: string; autoComplete?: string; placeholder?: string }> = [
        { name: "name", label: "Your name", autoComplete: "name", placeholder: "Ada Lovelace" },
        { name: "email", label: "Email", type: "email", autoComplete: "email", placeholder: "you@example.com" },
        { name: "password", label: "Password", type: "password", autoComplete: "new-password", placeholder: "10+ characters" },
        { name: "token", label: "Setup token", placeholder: "From the installer output" }
    ];

    return (
        <main className="grid min-h-screen place-items-center p-4">
            <Card className="w-full max-w-sm">
                <CardHeader className="items-center">
                    <PolarisMark className="mb-1" />
                    <CardTitle>Set up Polaris</CardTitle>
                </CardHeader>
                <CardBody>
                    {tokenConfigured ? null : (
                        <p className="mb-3 rounded-md border border-warning/40 bg-warning/10 p-2 text-xs text-warning">
                            No setup token is configured. Set POLARIS_SETUP_TOKEN and restart.
                        </p>
                    )}
                    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-3">
                        {fields.map((field) => (
                            <div key={field.name} className="flex flex-col gap-1">
                                <label className="text-sm">{field.label}</label>
                                <Input
                                    type={field.type ?? "text"}
                                    autoComplete={field.autoComplete}
                                    placeholder={field.placeholder}
                                    value={values[field.name]}
                                    onChange={(event) => update(field.name, event.target.value)}
                                    onBlur={() => form.markTouched(field.name)}
                                    aria-invalid={Boolean(form.error(field.name))}
                                />
                                {form.error(field.name) ? (
                                    <p className="text-xs text-danger">{form.error(field.name)}</p>
                                ) : null}
                            </div>
                        ))}
                        {error ? <p className="text-sm text-danger">{error}</p> : null}
                        <Button type="submit" disabled={pending}>
                            {pending ? "Creating..." : "Create administrator"}
                        </Button>
                    </form>
                    <p className="mt-4 text-center text-xs text-muted-foreground">
                        Already set up?{" "}
                        <a href="/oauth/login" className="text-primary hover:underline">
                            Sign in
                        </a>
                    </p>
                </CardBody>
            </Card>
        </main>
    );
}
