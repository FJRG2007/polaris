"use client";

/**
 * The account the texts go out through. Only needed if a phone number is among
 * the destinations above, so the card says so plainly instead of demanding
 * credentials from somebody who only wanted a Discord webhook.
 *
 * The auth token is write-only: saving without it keeps the stored one, so the
 * sending number can be corrected without going back to the provider for the
 * credential.
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus, Trash2 } from "lucide-react";
import {
    Badge,
    Button,
    Card,
    CardBody,
    CardHeader,
    CardTitle,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    Input
} from "@polaris/ui";
import { SMS_PROVIDER_INFO } from "@polaris/core";
import type { SmsSenderView } from "@/lib/notifications/sms-service";
import { deleteSmsSenderAction, saveSmsSenderAction } from "./actions";

/** Only one provider exists today; the catalogue keeps the form data-driven. */
const PROVIDER = SMS_PROVIDER_INFO.twilio;

export function SmsSenderCard({ senders }: { senders: SmsSenderView[] }) {
    const router = useRouter();
    const [editing, setEditing] = useState<SmsSenderView | "new" | null>(null);
    const [, startTransition] = useTransition();

    return (
        <Card>
            <CardHeader className="flex-row items-center justify-between gap-3">
                <div>
                    <CardTitle>SMS sender</CardTitle>
                    <p className="text-xs text-muted-foreground">
                        Needed only to send texts. {PROVIDER.summary}
                    </p>
                </div>
                {senders.length === 0 ? (
                    <Button size="sm" variant="secondary" onClick={() => setEditing("new")}>
                        <Plus className="size-4" />
                        Connect
                    </Button>
                ) : null}
            </CardHeader>
            <CardBody className="p-0">
                {senders.length === 0 ? (
                    <p className="px-4 py-6 text-center text-sm text-muted-foreground">
                        No sender connected. Webhooks and email work without one.
                    </p>
                ) : (
                    <ul className="divide-y divide-border">
                        {senders.map((sender) => (
                            <li key={sender.id} className="flex flex-col gap-1 px-4 py-3">
                                <div className="flex items-center justify-between gap-3">
                                    <div className="min-w-0">
                                        <p className="truncate text-sm font-medium">{sender.name}</p>
                                        <p className="truncate text-xs text-muted-foreground">
                                            {PROVIDER.label} - sends from {sender.from}
                                        </p>
                                    </div>
                                    <div className="flex shrink-0 items-center gap-1.5">
                                        <Badge variant={sender.status === "connected" ? "success" : "danger"}>
                                            {sender.status === "connected" ? "Working" : "Not working"}
                                        </Badge>
                                        <Button size="sm" variant="ghost" onClick={() => setEditing(sender)}>
                                            Edit
                                        </Button>
                                        <button
                                            type="button"
                                            aria-label="Remove sender"
                                            title="Remove sender"
                                            onClick={() =>
                                                startTransition(async () => {
                                                    await deleteSmsSenderAction(sender.id);
                                                    router.refresh();
                                                })
                                            }
                                            className="rounded p-1 text-muted-foreground transition-colors hover:text-danger"
                                        >
                                            <Trash2 className="size-4" />
                                        </button>
                                    </div>
                                </div>
                                {sender.error ? <p className="text-xs text-danger">{sender.error}</p> : null}
                            </li>
                        ))}
                    </ul>
                )}
            </CardBody>

            {editing ? (
                <SmsSenderDialog
                    sender={editing === "new" ? null : editing}
                    onClose={() => setEditing(null)}
                    onSaved={() => {
                        setEditing(null);
                        router.refresh();
                    }}
                />
            ) : null}
        </Card>
    );
}

function SmsSenderDialog({
    sender,
    onClose,
    onSaved
}: {
    sender: SmsSenderView | null;
    onClose: () => void;
    onSaved: () => void;
}) {
    const [pending, startTransition] = useTransition();
    const [name, setName] = useState(sender?.name ?? "Texts");
    const [settings, setSettings] = useState<Record<string, string>>(() => ({
        accountSid: sender?.settings.accountSid ?? "",
        from: sender?.from ?? ""
    }));
    const [secret, setSecret] = useState("");
    const [error, setError] = useState<string | null>(null);

    function submit() {
        setError(null);
        startTransition(async () => {
            const result = await saveSmsSenderAction({
                ...(sender ? { id: sender.id } : {}),
                name: name.trim(),
                provider: PROVIDER.id,
                settings,
                ...(secret.trim() ? { secret: secret.trim() } : {})
            });
            if (result.error) {
                setError(result.error);
                return;
            }
            onSaved();
        });
    }

    return (
        <Dialog open onOpenChange={(open) => !open && onClose()}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>{sender ? "Edit SMS sender" : "Connect an SMS sender"}</DialogTitle>
                    <DialogDescription>
                        <a
                            href={PROVIDER.docsUrl}
                            target="_blank"
                            rel="noreferrer noopener"
                            className="underline"
                        >
                            {PROVIDER.label} documentation
                        </a>
                    </DialogDescription>
                </DialogHeader>
                <div className="flex flex-col gap-3">
                    <label className="flex flex-col gap-1 text-sm">
                        <span className="font-medium">Name</span>
                        <Input value={name} onChange={(event) => setName(event.target.value)} />
                    </label>
                    {PROVIDER.fields.map((field) => (
                        <label key={field.name} className="flex flex-col gap-1 text-sm">
                            <span className="font-medium">{field.label}</span>
                            <Input
                                value={settings[field.name] ?? ""}
                                placeholder={field.placeholder}
                                onChange={(event) =>
                                    setSettings((current) => ({ ...current, [field.name]: event.target.value }))
                                }
                            />
                            {field.hint ? (
                                <span className="text-xs text-muted-foreground">{field.hint}</span>
                            ) : null}
                        </label>
                    ))}
                    <label className="flex flex-col gap-1 text-sm">
                        <span className="font-medium">{PROVIDER.secretLabel}</span>
                        <Input
                            type="password"
                            value={secret}
                            placeholder={sender ? "Leave blank to keep the stored one" : ""}
                            onChange={(event) => setSecret(event.target.value)}
                        />
                        <span className="text-xs text-muted-foreground">{PROVIDER.secretHint}</span>
                    </label>
                    {error ? <p className="text-sm text-danger">{error}</p> : null}
                    <div className="flex justify-end gap-2">
                        <Button variant="ghost" onClick={onClose} disabled={pending}>
                            Cancel
                        </Button>
                        <Button onClick={submit} disabled={pending}>
                            Save
                        </Button>
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    );
}
