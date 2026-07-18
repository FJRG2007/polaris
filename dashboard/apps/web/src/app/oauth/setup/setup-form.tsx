"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { setupSchema } from "@polaris/core";
import { Button, Card, CardBody, CardHeader, CardTitle, Input, PolarisMark } from "@polaris/ui";
import { signIn } from "@/lib/auth-client";
import { useZodForm } from "@/lib/use-zod-form";
import { completeSetupAction } from "./actions";

type Field = "name" | "username" | "email" | "password";

export function SetupForm({
    tokenConfigured,
    initialToken
}: {
    tokenConfigured: boolean;
    initialToken: string;
}) {
    const router = useRouter();
    const form = useZodForm(setupSchema);
    const [values, setValues] = useState({
        name: "",
        username: "",
        email: "",
        password: "",
        token: initialToken
    });
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
        // Sign the new administrator straight in - no second login step.
        await signIn.email({ email: parsed.email, password: parsed.password });
        router.push("/drive");
        router.refresh();
    }

    // The setup token arrives through the link the CLI prints - never typed. If it
    // is missing, guide the operator to generate one rather than showing a field.
    if (!initialToken) {
        return (
            <main className="grid min-h-screen place-items-center p-4">
                <Card className="w-full max-w-sm">
                    <CardHeader className="items-center">
                        <PolarisMark className="mb-1" />
                        <CardTitle>Set up Polaris</CardTitle>
                    </CardHeader>
                    <CardBody>
                        <p className="text-sm text-muted-foreground">
                            To create the administrator, run this on the server and open the link it
                            prints:
                        </p>
                        <pre className="mt-2 rounded-md border border-border bg-muted/40 p-2 text-sm">
                            polaris setup
                        </pre>
                        {tokenConfigured ? null : (
                            <p className="mt-3 text-xs text-warning">
                                No setup token is configured yet. Re-run the installer to generate one.
                            </p>
                        )}
                    </CardBody>
                </Card>
            </main>
        );
    }

    const fields: Array<{ name: Field; label: string; type?: string; autoComplete?: string; placeholder?: string }> = [
        { name: "name", label: "Your name", autoComplete: "name", placeholder: "Ada Lovelace" },
        { name: "username", label: "Username", autoComplete: "username", placeholder: "ada" },
        { name: "email", label: "Email", type: "email", autoComplete: "email", placeholder: "you@example.com" },
        { name: "password", label: "Password", type: "password", autoComplete: "new-password", placeholder: "10+ characters" }
    ];

    return (
        <main className="grid min-h-screen place-items-center p-4">
            <Card className="w-full max-w-sm">
                <CardHeader className="items-center">
                    <PolarisMark className="mb-1" />
                    <CardTitle>Set up Polaris</CardTitle>
                </CardHeader>
                <CardBody>
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
                </CardBody>
            </Card>
        </main>
    );
}
