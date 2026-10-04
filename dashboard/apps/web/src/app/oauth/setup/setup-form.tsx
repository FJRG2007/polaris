"use client";

/**
 * Creating the administrator, and whatever this instance asks of them next.
 *
 * When a second factor is required, arming it happens here rather than on the
 * enrollment screen. The screen asks for the password before it will start, which
 * is right for a session that has been open since yesterday and absurd four
 * seconds after somebody chose that password to register with - so this hands the
 * value already in the form over and the step opens on the QR code. Nothing is
 * stored to carry it: the page never navigates, so it is the same state it was
 * always in.
 */

import { signIn } from "@/lib/auth-client";
import { useRouter } from "next/navigation";
import { useZodForm } from "@/lib/use-zod-form";
import { completeSetupAction } from "./actions";
import { useState, type FormEvent } from "react";
import { EnrollView } from "@/app/oauth/enroll/enroll-view";
import { usePasswordSafety } from "@/lib/use-password-safety";
import { normalizePersonName, setupSchema } from "@polaris/core";
import { pendingEnrollmentAction, type PendingEnrollment } from "@/app/oauth/enroll/actions";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { validationMessage } from "@/components/i18n/validation-message";
import { Button, Card, CardBody, CardHeader, CardTitle, Input, PolarisMark } from "@polaris/ui";

type Field = "name" | "username" | "email" | "password";

export function SetupForm({
    tokenConfigured,
    initialToken
}: {
    tokenConfigured: boolean;
    initialToken: string;
}) {
    const router = useRouter();
    const t = useTranslations("auth");
    const tv = useTranslations("validation");
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
    /** The second factor this instance still wants, once the account exists. */
    const [enrollment, setEnrollment] = useState<PendingEnrollment | null>(null);
    // Refused before the submit rather than after it. The hook runs
    // passwordMatchesIdentity over the fields beside it and asks the breach corpus;
    // setupSchema and the action refuse both again on the server, which is the copy
    // that decides.
    const identity = [values.name, values.username, values.email];
    const passwordError = validationMessage(tv, usePasswordSafety(values.password, identity) ?? undefined) ?? null;

    function update(field: Field, value: string) {
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
        const result = await completeSetupAction(parsed);
        if (result.error) {
            setPending(false);
            setError(result.error);
            return;
        }
        // Sign the new administrator straight in - no second login step.
        await signIn.email({ email: parsed.email, password: parsed.password });
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

    // The setup token arrives through the link the CLI prints - never typed. If it
    // is missing, guide the operator to generate one rather than showing a field.
    if (!initialToken) {
        return (
            <main className="grid min-h-dvh place-items-center p-4">
                <Card className="w-full max-w-sm">
                    <CardHeader className="items-center">
                        <PolarisMark className="mb-1" />
                        <CardTitle>{t("setup.title")}</CardTitle>
                    </CardHeader>
                    <CardBody>
                        <p className="text-sm text-muted-foreground">{t("setup.linkHint")}</p>
                        <pre className="mt-2 rounded-md border border-border bg-muted/40 p-2 text-sm">
                            {/* i18n-ignore - a command, typed as it is */}
                            polaris setup
                        </pre>
                        {tokenConfigured ? null : (
                            <p className="mt-3 text-xs text-warning">
                                {t("setup.noToken")}
                            </p>
                        )}
                    </CardBody>
                </Card>
            </main>
        );
    }

    const fields: Array<{ name: Field; label: string; type?: string; autoComplete?: string; placeholder?: string }> = [
        { name: "name", label: t("setup.fields.name"), autoComplete: "name", placeholder: t("setup.fields.namePlaceholder") },
        {
            name: "username",
            label: t("setup.fields.username"),
            autoComplete: "username",
            placeholder: t("setup.fields.usernamePlaceholder")
        },
        {
            name: "email",
            label: t("setup.fields.email"),
            type: "email",
            autoComplete: "email",
            placeholder: t("setup.fields.emailPlaceholder")
        },
        {
            name: "password",
            label: t("setup.fields.password"),
            type: "password",
            autoComplete: "new-password",
            placeholder: t("setup.fields.passwordPlaceholder")
        }
    ];

    return (
        <main className="grid min-h-dvh place-items-center p-4">
            <Card className="w-full max-w-sm">
                <CardHeader className="items-center">
                    <PolarisMark className="mb-1" />
                    <CardTitle>{t("setup.title")}</CardTitle>
                </CardHeader>
                <CardBody>
                    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-3">
                        {fields.map((field) => {
                            // The password carries two refusals the schema cannot
                            // make on its own; the name is written the same way
                            // whatever keyboard it arrives from.
                            const fieldError =
                                validationMessage(tv, form.error(field.name)) ??
                                (field.name === "password" ? passwordError : null);
                            const isName = field.name === "name";
                            return (
                                <div key={field.name} className="flex flex-col gap-1">
                                    <label className="text-sm">{field.label}</label>
                                    <Input
                                        type={field.type ?? "text"}
                                        autoComplete={field.autoComplete}
                                        placeholder={field.placeholder}
                                        {...(isName
                                            ? { autoCapitalize: "words", autoCorrect: "off", spellCheck: false }
                                            : {})}
                                        value={values[field.name]}
                                        onChange={(event) => update(field.name, event.target.value)}
                                        // On blur rather than on every keystroke:
                                        // normalizing as somebody types moves the
                                        // caret and breaks composing a name on an
                                        // IME. The server normalizes it again.
                                        onBlur={() => {
                                            if (isName) update(field.name, normalizePersonName(values.name));
                                            form.markTouched(field.name);
                                        }}
                                        aria-invalid={Boolean(fieldError)}
                                    />
                                    {fieldError ? <p className="text-xs text-danger">{fieldError}</p> : null}
                                </div>
                            );
                        })}
                        {error ? <p className="text-sm text-danger">{error}</p> : null}
                        <Button type="submit" disabled={pending}>
                            {pending ? t("setup.creating") : t("setup.create")}
                        </Button>
                    </form>
                </CardBody>
            </Card>
        </main>
    );
}
