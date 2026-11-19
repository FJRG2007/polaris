"use client";

/**
 * The buttons and forms under a message Polar or an app wrote - see
 * `lib/chat/message-components`.
 *
 * A link goes where it says. A button or a form's answers go to the server by
 * the component's position, and the server reads what it does from the stored
 * message. One kept for somebody else is drawn disabled, with who it is for.
 */

import Link from "next/link";
import { useState } from "react";
import * as actions from "./actions";
import { Loader2 } from "lucide-react";
import { useChat } from "./chat-context";
import { runAction } from "@/lib/run-action";
import { useTranslations } from "@/components/i18n/i18n-provider";
import type { FormField, MessageComponent } from "@/lib/chat/message-components";
import {
    Button,
    Dialog,
    DialogContent,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Input,
    Select,
    Textarea
} from "@polaris/ui";

export function MessageComponents({
    messageId,
    components,
    onError
}: {
    messageId: string;
    components: readonly MessageComponent[];
    onError: (message: string) => void;
}) {
    const t = useTranslations("chat");
    const { viewerId } = useChat();
    const [busy, setBusy] = useState<number | null>(null);
    const [form, setForm] = useState<number | null>(null);

    const press = async (index: number, fields?: Record<string, string>): Promise<boolean> => {
        setBusy(index);
        const result = await runAction(
            () => actions.pressComponentAction({ messageId, index, ...(fields ? { fields } : {}) }),
            onError
        );
        setBusy(null);
        if (result?.error) onError(result.error);
        return Boolean(result && !result.error);
    };

    const opened = form === null ? null : components[form];
    return (
        <div className="mt-1.5 flex flex-wrap gap-1.5">
            {components.map((component, index) => {
                if (component.type === "link") {
                    return (
                        <Button key={index} asChild size="sm" variant="secondary" className="min-w-0 max-w-full">
                            <Link href={component.href} prefetch={false}>
                                <span className="truncate" title={component.label}>{component.label}</span>
                            </Link>
                        </Button>
                    );
                }
                const notMine = Boolean(component.for && component.for !== viewerId);
                return (
                    <Button
                        key={index}
                        size="sm"
                        variant={component.style}
                        className="min-w-0 max-w-full"
                        disabled={notMine || busy !== null}
                        title={notMine ? t("appCommands.onlyFor") : undefined}
                        aria-busy={busy === index}
                        onClick={() => (component.type === "form" ? setForm(index) : void press(index))}
                    >
                        {busy === index && <Loader2 className="size-3.5 shrink-0 animate-spin" aria-hidden />}
                        <span className="truncate">{busy === index ? t("appCommands.working") : component.label}</span>
                    </Button>
                );
            })}
            {opened?.type === "form" && form !== null && (
                <ComponentForm
                    key={`${messageId}:${form}`}
                    title={opened.title}
                    submit={opened.submit}
                    fields={opened.fields}
                    busy={busy === form}
                    onClose={() => setForm(null)}
                    onSubmit={async (fields) => {
                        if (await press(form, fields)) setForm(null);
                    }}
                />
            )}
        </div>
    );
}

function ComponentForm({
    title,
    submit,
    fields,
    busy,
    onClose,
    onSubmit
}: {
    title: string;
    submit: string;
    fields: readonly FormField[];
    busy: boolean;
    onClose: () => void;
    onSubmit: (fields: Record<string, string>) => Promise<void>;
}) {
    const t = useTranslations("chat");
    const [values, setValues] = useState<Record<string, string>>(() =>
        Object.fromEntries(fields.map((field) => [field.name, field.value ?? ""]))
    );
    // The same rule the server checks: a required field with nothing in it.
    const incomplete = fields.some((field) => field.required && !(values[field.name] ?? "").trim());
    const set = (name: string, value: string) => setValues((current) => ({ ...current, [name]: value }));

    return (
        <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>{title}</DialogTitle>
                </DialogHeader>
                <form
                    className="flex flex-col gap-3"
                    onSubmit={(event) => {
                        event.preventDefault();
                        if (!incomplete && !busy) void onSubmit(values);
                    }}
                >
                    {fields.map((field, at) => (
                        <label key={field.name} className="flex min-w-0 flex-col gap-1">
                            <span className="text-xs text-muted-foreground">
                                {field.label}
                                {field.required && <span aria-hidden> *</span>}
                            </span>
                            {field.kind === "choice" ? (
                                <Select
                                    value={values[field.name] ?? ""}
                                    onValueChange={(value) => set(field.name, value)}
                                    aria-label={field.label}
                                    options={(field.options ?? []).map((option) => ({
                                        value: option.value,
                                        label: option.label
                                    }))}
                                />
                            ) : field.kind === "long" ? (
                                <Textarea
                                    value={values[field.name] ?? ""}
                                    maxLength={field.max}
                                    rows={4}
                                    placeholder={field.placeholder}
                                    onChange={(event) => set(field.name, event.target.value)}
                                />
                            ) : (
                                <Input
                                    value={values[field.name] ?? ""}
                                    maxLength={field.max}
                                    autoFocus={at === 0}
                                    required={field.required}
                                    placeholder={field.placeholder}
                                    onChange={(event) => set(field.name, event.target.value)}
                                />
                            )}
                        </label>
                    ))}
                    <DialogFooter>
                        <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={onClose}>
                            {t("appCommands.cancel")}
                        </Button>
                        <Button type="submit" size="sm" aria-disabled={incomplete || busy} disabled={busy}>
                            {busy && <Loader2 className="size-3.5 shrink-0 animate-spin" aria-hidden />}
                            {submit}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
