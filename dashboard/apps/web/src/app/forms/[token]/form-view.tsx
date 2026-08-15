"use client";

/**
 * The public form itself.
 *
 * It is somebody's first and possibly only contact with this Polaris, so it says
 * nothing about the workspace behind it - no space, no list, no member names -
 * and validates as the reader types rather than rejecting the whole thing after
 * they press send.
 */

import { useState } from "react";
import { CircleCheck } from "lucide-react";
import { runAction } from "@/lib/run-action";
import { submitFormAction } from "./actions";
import type { FormField } from "@polaris/core";
import { Card, Input, Button, Select, CardBody, Textarea } from "@polaris/ui";

export function PublicForm({
    token,
    name,
    intro,
    fields,
    requireLogin,
    signedIn
}: {
    token: string;
    name: string;
    intro: string;
    fields: readonly FormField[];
    requireLogin: boolean;
    signedIn: boolean;
}) {
    const [answers, setAnswers] = useState<Record<string, string>>({});
    const [touched, setTouched] = useState<Record<string, boolean>>({});
    const [sending, setSending] = useState(false);
    const [sent, setSent] = useState<string | null>(null);
    const [error, setError] = useState("");

    const missing = (field: FormField) => field.required && !(answers[field.id] ?? "").trim();

    const submit = async () => {
        setTouched(Object.fromEntries(fields.map((field) => [field.id, true])));
        if (fields.some(missing)) {
            setError("Fill in the required questions first.");
            return;
        }
        setSending(true);
        setError("");
        const result = await runAction(() => submitFormAction(token, answers), setError);
        setSending(false);
        if (result?.error) setError(result.error);
        else if (result?.confirmation) setSent(result.confirmation);
    };

    if (sent) {
        return (
            <Card className="mx-auto w-full max-w-lg">
                <CardBody className="flex flex-col items-center gap-3 p-8 text-center">
                    <CircleCheck className="size-8 text-emerald-500" />
                    <p className="text-sm">{sent}</p>
                </CardBody>
            </Card>
        );
    }

    if (requireLogin && !signedIn) {
        return (
            <Card className="mx-auto w-full max-w-lg">
                <CardBody className="flex flex-col gap-3 p-8 text-center">
                    <h1 className="text-[17px] font-semibold tracking-tight">{name}</h1>
                    <p className="text-sm text-muted-foreground">This form is only open to people with an account.</p>
                    <a href="/oauth/login" className="text-sm text-primary hover:underline">
                        Sign in to continue
                    </a>
                </CardBody>
            </Card>
        );
    }

    return (
        <Card className="mx-auto w-full max-w-lg">
            <CardBody className="flex flex-col gap-4 p-6">
                <div>
                    <h1 className="text-[17px] font-semibold tracking-tight">{name}</h1>
                    {intro && <p className="mt-1 text-sm text-muted-foreground">{intro}</p>}
                </div>

                {fields.map((field) => {
                    const value = answers[field.id] ?? "";
                    const invalid = touched[field.id] && missing(field);
                    const set = (next: string) => setAnswers((current) => ({ ...current, [field.id]: next }));

                    return (
                        <label key={field.id} className="flex flex-col gap-1 text-sm">
                            <span>
                                {field.label}
                                {field.required && <span className="ml-1 text-danger">*</span>}
                            </span>
                            {field.help && <span className="text-xs text-muted-foreground">{field.help}</span>}

                            {field.type === "longText" ? (
                                <Textarea
                                    value={value}
                                    rows={4}
                                    aria-invalid={invalid}
                                    onChange={(event) => set(event.target.value)}
                                    onBlur={() => setTouched((current) => ({ ...current, [field.id]: true }))}
                                    className="w-full resize-y rounded-md border border-border bg-background px-3 py-2 text-sm hover:border-border-strong focus:border-border-strong"
                                />
                            ) : field.type === "dropdown" ? (
                                <Select
                                    value={value}
                                    onValueChange={set}
                                    options={field.options.map((option) => ({ value: option, label: option }))}
                                    placeholder="Choose one"
                                    aria-label={field.label}
                                />
                            ) : field.type === "checkbox" ? (
                                <input
                                    type="checkbox"
                                    checked={value === "true"}
                                    onChange={(event) => set(event.target.checked ? "true" : "")}
                                    className="size-4 self-start"
                                />
                            ) : (
                                <Input
                                    type={
                                        field.type === "email"
                                            ? "email"
                                            : field.type === "number"
                                              ? "number"
                                              : field.type === "date"
                                                ? "date"
                                                : "text"
                                    }
                                    value={value}
                                    aria-invalid={invalid}
                                    onChange={(event) => set(event.target.value)}
                                    onBlur={() => setTouched((current) => ({ ...current, [field.id]: true }))}
                                />
                            )}

                            {invalid && <span className="text-xs text-danger">This one is required.</span>}
                        </label>
                    );
                })}

                {error && (
                    <p role="alert" className="rounded-md bg-danger/10 px-3 py-2 text-sm text-danger">
                        {error}
                    </p>
                )}

                <Button disabled={sending} onClick={() => void submit()}>
                    {sending ? "Sending" : "Send"}
                </Button>
            </CardBody>
        </Card>
    );
}
