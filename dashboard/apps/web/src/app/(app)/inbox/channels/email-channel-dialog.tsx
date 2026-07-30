"use client";

/**
 * Adding and managing an email sender. One dialog for both, because the fields
 * are the same either way and an operator fixing a typo should not meet a
 * different form from the one they filled in.
 *
 * The fields come from the provider catalogue rather than being written out per
 * provider, so adding a provider is a catalogue entry and a send function - no
 * form to keep in step. The stored key is never sent back to the browser: an
 * empty secret field on an existing channel means "keep the one you have".
 *
 * Saving checks the credentials with the provider. That catches a wrong key, but
 * not a From address the provider will not send as, which is the more common
 * mistake - hence the test message, which is the only thing that proves the
 * whole path.
 */

import { useMemo, useState, useTransition } from "react";
import { Loader2, Send, Trash2 } from "lucide-react";
import {
    MAIL_PROVIDER_INFO,
    MAIL_PROVIDERS,
    type MailProvider,
    type MailProviderField
} from "@polaris/core";
import {
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    Input,
    Select
} from "@polaris/ui";
import { useConfirm } from "@/components/confirm-dialog";
import type { EmailChannelView } from "@/lib/mail-service";
import {
    createEmailChannelAction,
    deleteEmailChannelAction,
    sendTestEmailAction,
    updateEmailChannelAction
} from "./email-actions";

const PROVIDER_OPTIONS = MAIL_PROVIDERS.map((id) => ({ value: id, label: MAIL_PROVIDER_INFO[id].label }));

/** Sensible starting values so a new channel is mostly filled in already. */
const DEFAULTS: Partial<Record<string, string>> = { port: "587", fromName: "Polaris" };

function initialSettings(provider: MailProvider, existing?: Record<string, string>): Record<string, string> {
    return Object.fromEntries(
        MAIL_PROVIDER_INFO[provider].fields.map((field) => [
            field.name,
            existing?.[field.name] ?? DEFAULTS[field.name] ?? ""
        ])
    );
}

export function EmailChannelDialog({
    channel,
    initialProvider,
    onClose,
    onSaved,
    onRemoved
}: {
    /** The channel being edited, or null when adding one. */
    channel: EmailChannelView | null;
    /** Which provider a new sender starts on, when it was picked before the dialog. */
    initialProvider?: MailProvider;
    onClose: () => void;
    onSaved: (channel: EmailChannelView) => void;
    onRemoved: (id: string) => void;
}) {
    const editing = channel !== null;
    const starting = channel?.provider ?? initialProvider ?? "brevo";
    const [confirm, confirmElement] = useConfirm();
    const [provider, setProvider] = useState<MailProvider>(starting);
    const [name, setName] = useState(channel?.name ?? "");
    const [secret, setSecret] = useState("");
    const [settings, setSettings] = useState<Record<string, string>>(() =>
        initialSettings(starting, channel?.settings)
    );
    const [testTo, setTestTo] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [notice, setNotice] = useState<string | null>(null);
    const [saving, startSave] = useTransition();
    const [testing, startTest] = useTransition();
    const [removing, startRemove] = useTransition();

    const info = MAIL_PROVIDER_INFO[provider];
    const busy = saving || testing || removing;

    /** Switching provider keeps the values the two providers share (the From
     *  address, mostly) and drops the ones that do not apply. */
    function changeProvider(next: MailProvider) {
        setProvider(next);
        setSettings((prev) => initialSettings(next, prev));
        setError(null);
        setNotice(null);
    }

    const missing = useMemo(() => {
        if (!name.trim()) return true;
        if (!editing && !secret.trim()) return true;
        return info.fields.some((field) => !field.optional && !settings[field.name]?.trim());
    }, [editing, info.fields, name, secret, settings]);

    function save() {
        setError(null);
        setNotice(null);
        const input = {
            provider,
            name: name.trim(),
            ...(secret.trim() ? { secret: secret.trim() } : {}),
            settings
        };
        startSave(async () => {
            const result = editing
                ? await updateEmailChannelAction(channel.id, input)
                : await createEmailChannelAction(input);
            if (result.error || !result.channel) {
                setError(result.error ?? "Could not save the channel.");
                return;
            }
            setSecret("");
            onSaved(result.channel);
            // A stored channel whose credentials were refused is kept so the
            // operator can correct one field; say so rather than looking saved.
            if (result.channel.error) setError(result.channel.error);
            else setNotice("Saved. Send a test message to confirm the address works.");
        });
    }

    function sendTest() {
        if (!channel) return;
        setError(null);
        setNotice(null);
        startTest(async () => {
            const result = await sendTestEmailAction(channel.id, testTo.trim());
            if (result.error) {
                setError(result.error);
                return;
            }
            setNotice(`Sent to ${testTo.trim()}. Check the inbox, and the spam folder.`);
        });
    }

    async function remove() {
        if (!channel) return;
        const ok = await confirm({
            title: `Remove ${channel.name}?`,
            description:
                "Polaris stops sending through it. Anything set to use it for sign-in mail will need another channel.",
            confirmLabel: "Remove",
            danger: true
        });
        if (!ok) return;
        startRemove(async () => {
            const result = await deleteEmailChannelAction(channel.id);
            if (result.error) {
                setError(result.error);
                return;
            }
            onRemoved(channel.id);
        });
    }

    return (
        <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
            <DialogContent className="max-w-lg">
                <DialogHeader>
                    <DialogTitle>{editing ? `Manage ${channel.name}` : "Add an email sender"}</DialogTitle>
                    <DialogDescription>{info.summary}</DialogDescription>
                </DialogHeader>

                <div className="flex max-h-[65vh] flex-col gap-4 overflow-y-auto">
                    <label className="flex flex-col gap-1 text-sm">
                        <span className="font-medium">Provider</span>
                        <Select
                            value={provider}
                            onValueChange={(value) => changeProvider(value as MailProvider)}
                            options={PROVIDER_OPTIONS}
                        />
                        <span className="text-xs text-muted-foreground">
                            Sending address: {info.senderRequirement}{" "}
                            <a
                                href={info.docsUrl}
                                target="_blank"
                                rel="noreferrer"
                                className="text-primary underline-offset-2 hover:underline"
                            >
                                Provider docs
                            </a>
                        </span>
                    </label>

                    <label className="flex flex-col gap-1 text-sm">
                        <span className="font-medium">Name</span>
                        <Input
                            value={name}
                            onChange={(event) => setName(event.target.value)}
                            placeholder="Account mail"
                        />
                    </label>

                    {info.fields.map((field) => (
                        <SettingField
                            key={field.name}
                            field={field}
                            value={settings[field.name] ?? ""}
                            onChange={(value) => setSettings((prev) => ({ ...prev, [field.name]: value }))}
                        />
                    ))}

                    <label className="flex flex-col gap-1 text-sm">
                        <span className="font-medium">{info.secretLabel}</span>
                        <Input
                            type="password"
                            autoComplete="off"
                            value={secret}
                            onChange={(event) => setSecret(event.target.value)}
                            placeholder={editing ? "Saved - enter a new one to replace it" : ""}
                        />
                        <span className="text-xs text-muted-foreground">{info.secretHint}</span>
                    </label>

                    {editing && (
                        <div className="flex flex-col gap-1 rounded-md border border-border p-3">
                            <span className="text-sm font-medium">Send a test message</span>
                            <div className="flex items-start gap-2">
                                <Input
                                    type="email"
                                    value={testTo}
                                    autoComplete="email"
                                    placeholder="you@example.com"
                                    onChange={(event) => setTestTo(event.target.value)}
                                />
                                <Button
                                    type="button"
                                    variant="secondary"
                                    onClick={sendTest}
                                    disabled={busy || !testTo.trim()}
                                >
                                    {testing ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
                                    Send
                                </Button>
                            </div>
                            <span className="text-xs text-muted-foreground">
                                The only check that proves the From address is one the provider will send as.
                            </span>
                        </div>
                    )}

                    {error ? <p className="text-sm text-danger">{error}</p> : null}
                    {notice ? <p className="text-sm text-success">{notice}</p> : null}
                </div>

                <div className="flex items-center justify-between gap-2">
                    {editing ? (
                        <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            aria-label={`Remove ${channel.name}`}
                            title="Remove"
                            onClick={() => void remove()}
                            disabled={busy}
                        >
                            <Trash2 className="size-4" />
                        </Button>
                    ) : (
                        <span />
                    )}
                    <div className="flex gap-2">
                        <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
                            {editing ? "Close" : "Cancel"}
                        </Button>
                        <Button type="button" onClick={save} disabled={busy || missing}>
                            {saving && <Loader2 className="size-4 animate-spin" />}
                            {editing ? "Save" : "Add"}
                        </Button>
                    </div>
                </div>
                {confirmElement}
            </DialogContent>
        </Dialog>
    );
}

function SettingField({
    field,
    value,
    onChange
}: {
    field: MailProviderField;
    value: string;
    onChange: (value: string) => void;
}) {
    return (
        <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">
                {field.label}
                {field.optional ? <span className="text-muted-foreground"> (optional)</span> : null}
            </span>
            <Input
                type={field.type === "number" ? "number" : field.type === "password" ? "password" : "text"}
                value={value}
                placeholder={field.placeholder}
                onChange={(event) => onChange(event.target.value)}
            />
            {field.hint ? <span className="text-xs text-muted-foreground">{field.hint}</span> : null}
        </label>
    );
}
