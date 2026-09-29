"use client";

/**
 * The account the texts go out through, listed with the other things Polaris
 * sends through rather than on anybody's own settings page: it is a connected
 * service an operator configures once, not a preference.
 *
 * Only needed if something is being alerted to a phone number, so the card says
 * so plainly instead of demanding provider credentials from somebody who came
 * here to link a Discord server.
 *
 * The auth token is write-only: saving without it keeps the stored one, so the
 * sending number can be corrected without going back to the provider for the
 * credential.
 */

import { useRouter } from "next/navigation";
import { Plus, Trash2 } from "lucide-react";
import { useState, useTransition } from "react";
import { SMS_PROVIDER_INFO } from "@polaris/core";
import { useTranslations } from "@/components/i18n/i18n-provider";
import type { SmsSenderView } from "@/lib/notifications/sms-service";
import { deleteSmsSenderAction, saveSmsSenderAction } from "./sms-actions";
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

/** Only one provider exists today; the catalogue keeps the form data-driven. */
const PROVIDER = SMS_PROVIDER_INFO.twilio;

export function SmsSenderCard({ senders }: { senders: SmsSenderView[] }) {
    const t = useTranslations("admin");
    const router = useRouter();
    const [editing, setEditing] = useState<SmsSenderView | "new" | null>(null);
    const [, startTransition] = useTransition();

    return (
        <Card>
            <CardHeader className="flex-row items-center justify-between gap-3">
                <div>
                    <CardTitle>{t("inboxChannels.sms.title")}</CardTitle>
                    <p className="text-xs text-muted-foreground">
                        {t("inboxChannels.sms.hint", { summary: PROVIDER.summary })}
                    </p>
                </div>
                {senders.length === 0 ? (
                    <Button size="sm" variant="secondary" onClick={() => setEditing("new")}>
                        <Plus className="size-4" />
                        {t("inbox.connect.connect")}
                    </Button>
                ) : null}
            </CardHeader>
            <CardBody className="p-0">
                {senders.length === 0 ? (
                    <p className="px-4 py-6 text-center text-sm text-muted-foreground">
                        {t("inboxChannels.sms.empty")}
                    </p>
                ) : (
                    <ul className="divide-y divide-border">
                        {senders.map((sender) => (
                            <li key={sender.id} className="flex flex-col gap-1 px-4 py-3">
                                <div className="flex items-center justify-between gap-3">
                                    <div className="min-w-0">
                                        <p className="truncate text-sm font-medium">{sender.name}</p>
                                        <p className="truncate text-xs text-muted-foreground">
                                            {t("inboxChannels.sms.sendsFrom", { provider: PROVIDER.label, from: sender.from })}
                                        </p>
                                    </div>
                                    <div className="flex shrink-0 items-center gap-1.5">
                                        <Badge variant={sender.status === "connected" ? "success" : "danger"}>
                                            {sender.status === "connected"
                                                ? t("inboxChannels.sms.working")
                                                : t("inboxChannels.sms.notWorking")}
                                        </Badge>
                                        <Button size="sm" variant="ghost" onClick={() => setEditing(sender)}>
                                            {t("inboxChannels.sms.edit")}
                                        </Button>
                                        <button
                                            type="button"
                                            aria-label={t("inboxChannels.sms.remove")}
                                            title={t("inboxChannels.sms.remove")}
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
    const t = useTranslations("admin");
    const tc = useTranslations("common");
    const [pending, startTransition] = useTransition();
    const [name, setName] = useState(sender?.name ?? t("inboxChannels.sms.defaultName"));
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
                    <DialogTitle>{sender ? t("inboxChannels.sms.editTitle") : t("inboxChannels.sms.connectTitle")}</DialogTitle>
                    <DialogDescription>
                        <a
                            href={PROVIDER.docsUrl}
                            target="_blank"
                            rel="noreferrer noopener"
                            className="underline"
                        >
                            {t("inboxChannels.sms.docs", { provider: PROVIDER.label })}
                        </a>
                    </DialogDescription>
                </DialogHeader>
                <div className="flex flex-col gap-3">
                    <label className="flex flex-col gap-1 text-sm">
                        <span className="font-medium">{t("inbox.connect.name")}</span>
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
                            placeholder={sender ? t("inboxChannels.sms.keepSecret") : ""}
                            onChange={(event) => setSecret(event.target.value)}
                        />
                        <span className="text-xs text-muted-foreground">{PROVIDER.secretHint}</span>
                    </label>
                    {error ? <p className="text-sm text-danger">{error}</p> : null}
                    <div className="flex justify-end gap-2">
                        <Button variant="ghost" onClick={onClose} disabled={pending}>
                            {tc("actions.cancel")}
                        </Button>
                        <Button onClick={submit} disabled={pending}>
                            {tc("actions.save")}
                        </Button>
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    );
}
