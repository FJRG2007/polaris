"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { acceptInviteSchema } from "@polaris/core";
import { Button, Card, CardBody, CardHeader, CardTitle, Input, PolarisMark } from "@polaris/ui";
import { signIn } from "@/lib/auth-client";
import { useZodForm } from "@/lib/use-zod-form";
import { acceptInviteAction } from "./actions";

export function AcceptInviteForm({ token, email }: { token: string; email: string }) {
    const router = useRouter();
    const form = useZodForm(acceptInviteSchema);
    const [values, setValues] = useState({ name: "", password: "" });
    const [error, setError] = useState<string | null>(null);
    const [pending, setPending] = useState(false);

    function update(field: "name" | "password", value: string) {
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
        const result = await acceptInviteAction({ token, name: parsed.name, password: parsed.password });
        if (result.error) {
            setPending(false);
            setError(result.error);
            return;
        }
        await signIn.email({ email, password: parsed.password });
        router.push("/drive");
        router.refresh();
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
                                value={values.name}
                                onChange={(event) => update("name", event.target.value)}
                                onBlur={() => form.markTouched("name")}
                                aria-invalid={Boolean(form.error("name"))}
                            />
                            {form.error("name") ? <p className="text-xs text-danger">{form.error("name")}</p> : null}
                        </div>
                        <div className="flex flex-col gap-1">
                            <label className="text-sm">Password</label>
                            <Input
                                type="password"
                                autoComplete="new-password"
                                placeholder="10+ characters"
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
                            {pending ? "Joining..." : "Join Polaris"}
                        </Button>
                    </form>
                </CardBody>
            </Card>
        </main>
    );
}
