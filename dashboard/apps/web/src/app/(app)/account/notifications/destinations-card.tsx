"use client";

/**
 * The places alerts can be sent besides the bell and your mailbox: a chat
 * webhook or a phone number. Adding one only puts it on the list - it starts
 * routed nowhere until an event above is pointed at it, which is what keeps
 * "I added a webhook" from silently redirecting every alert you have.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { RelativeTime } from "@/components/relative-time";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { Plus, Send, Smartphone, Trash2, Webhook } from "lucide-react";
import type { DestinationView } from "@/lib/notifications/destinations";
import {
    ALERT_MIN_LEVELS,
    destinationInputSchema,
    WEBHOOK_FORMAT_LABEL,
    WEBHOOK_FORMATS,
    type AlertMinLevel
} from "@polaris/core";
import {
    createDestinationAction,
    deleteDestinationAction,
    setDestinationEnabledAction,
    setDestinationMinLevelAction,
    testDestinationAction
} from "./actions";
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
    Input,
    Select,
    Switch
} from "@polaris/ui";

export function DestinationsCard({
    destinations,
    smsReady
}: {
    destinations: DestinationView[];
    smsReady: boolean;
}) {
    const router = useRouter();
    const t = useTranslations("accountNotifications");
    const [adding, setAdding] = useState(false);
    const [testResult, setTestResult] = useState<{ id: string; error: string | null } | null>(null);
    const [pending, startTransition] = useTransition();
    // The floor each row shows, changed here first and put back if the save fails.
    const [floors, setFloors] = useState<Record<string, AlertMinLevel>>({});
    const [floorError, setFloorError] = useState<{ id: string; error: string } | null>(null);
    const levelOptions = ALERT_MIN_LEVELS.map((level) => ({
        value: level,
        label: t(`destinations.level.${level}`)
    }));

    function setFloor(id: string, previous: AlertMinLevel, next: AlertMinLevel) {
        if (next === previous) return;
        setFloorError(null);
        setFloors((current) => ({ ...current, [id]: next }));
        startTransition(async () => {
            const result = await setDestinationMinLevelAction({ id, minLevel: next });
            if (result.error) {
                setFloors((current) => ({ ...current, [id]: previous }));
                setFloorError({ id, error: result.error });
                return;
            }
            router.refresh();
        });
    }

    function test(id: string) {
        setTestResult(null);
        startTransition(async () => {
            const result = await testDestinationAction(id);
            setTestResult({ id, error: result.error ?? null });
            router.refresh();
        });
    }

    return (
        <Card>
            <CardHeader className="flex-row items-center justify-between gap-3">
                <div>
                    <CardTitle>{t("destinations.title")}</CardTitle>
                    <p className="text-xs text-muted-foreground">{t("destinations.description")}</p>
                </div>
                <Button size="sm" variant="secondary" onClick={() => setAdding(true)}>
                    <Plus className="size-4" />
                    {t("destinations.add")}
                </Button>
            </CardHeader>
            <CardBody className="p-0">
                {destinations.length === 0 ? (
                    <p className="px-4 py-6 text-center text-sm text-muted-foreground">
                        {t("destinations.empty")}
                    </p>
                ) : (
                    <ul className="divide-y divide-border">
                        {destinations.map((destination) => (
                            <li key={destination.id} className="flex flex-col gap-1 px-4 py-3">
                                <div className="flex items-center justify-between gap-3">
                                    <div className="flex min-w-0 items-center gap-2">
                                        {destination.kind === "sms" ? (
                                            <Smartphone className="size-4 shrink-0 text-muted-foreground" />
                                        ) : (
                                            <Webhook className="size-4 shrink-0 text-muted-foreground" />
                                        )}
                                        <div className="min-w-0">
                                            <p className="truncate text-sm font-medium">
                                                {destination.name}
                                            </p>
                                            <p className="truncate text-xs text-muted-foreground">
                                                {destination.targetHint}
                                                {destination.format
                                                    ? ` - ${destination.format}`
                                                    : ""}
                                            </p>
                                        </div>
                                    </div>
                                    <div className="flex shrink-0 items-center gap-1.5">
                                        <Select
                                            className="h-8 w-36 text-xs"
                                            aria-label={t("destinations.levelLabel")}
                                            value={floors[destination.id] ?? destination.minLevel}
                                            onValueChange={(value) =>
                                                setFloor(
                                                    destination.id,
                                                    floors[destination.id] ?? destination.minLevel,
                                                    value as AlertMinLevel
                                                )
                                            }
                                            options={levelOptions}
                                        />
                                        {destination.status === "error" ? (
                                            <Badge variant="danger">
                                                {t("destinations.failing")}
                                            </Badge>
                                        ) : destination.status === "ok" ? (
                                            <Badge variant="success">
                                                {t("destinations.working")}
                                            </Badge>
                                        ) : null}
                                        <Switch
                                            checked={destination.enabled}
                                            onChange={(next) =>
                                                startTransition(async () => {
                                                    await setDestinationEnabledAction(
                                                        destination.id,
                                                        next
                                                    );
                                                    router.refresh();
                                                })
                                            }
                                            aria-label={
                                                destination.enabled
                                                    ? t("destinations.switchOff")
                                                    : t("destinations.switchOn")
                                            }
                                        />
                                        <button
                                            type="button"
                                            aria-label={t("destinations.test")}
                                            title={t("destinations.test")}
                                            disabled={pending || !destination.enabled}
                                            onClick={() => test(destination.id)}
                                            className="rounded p-1 text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
                                        >
                                            <Send className="size-4" />
                                        </button>
                                        <button
                                            type="button"
                                            aria-label={t("destinations.remove")}
                                            title={t("destinations.remove")}
                                            onClick={() =>
                                                startTransition(async () => {
                                                    await deleteDestinationAction(destination.id);
                                                    router.refresh();
                                                })
                                            }
                                            className="rounded p-1 text-muted-foreground transition-colors hover:text-danger"
                                        >
                                            <Trash2 className="size-4" />
                                        </button>
                                    </div>
                                </div>
                                {destination.kind === "sms" && !smsReady ? (
                                    <p className="text-xs text-warning">
                                        {t.rich("destinations.smsNotReady", {
                                            link: (chunks) => (
                                                <Link
                                                    key="link"
                                                    href="/admin/inbox/channels"
                                                    className="underline"
                                                >
                                                    {chunks}
                                                </Link>
                                            )
                                        })}
                                    </p>
                                ) : null}
                                {floorError?.id === destination.id ? (
                                    <p className="text-xs text-danger">{floorError.error}</p>
                                ) : null}
                                {testResult?.id === destination.id ? (
                                    <p
                                        className={
                                            testResult.error
                                                ? "text-xs text-danger"
                                                : "text-xs text-success"
                                        }
                                    >
                                        {testResult.error ?? t("destinations.testSent")}
                                    </p>
                                ) : destination.lastError ? (
                                    <p className="text-xs text-danger">{destination.lastError}</p>
                                ) : destination.lastUsedAt ? (
                                    <p className="text-xs text-muted-foreground">
                                        {t.rich("destinations.lastUsed", {
                                            time: (
                                                <RelativeTime
                                                    key="time"
                                                    iso={destination.lastUsedAt}
                                                />
                                            )
                                        })}
                                    </p>
                                ) : null}
                            </li>
                        ))}
                    </ul>
                )}
            </CardBody>

            {adding ? (
                <AddDestinationDialog
                    onClose={() => setAdding(false)}
                    onAdded={() => {
                        setAdding(false);
                        router.refresh();
                    }}
                />
            ) : null}
        </Card>
    );
}

function AddDestinationDialog({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
    const t = useTranslations("accountNotifications");
    const tc = useTranslations("common");
    const [pending, startTransition] = useTransition();
    const [kind, setKind] = useState<"webhook" | "sms">("webhook");
    const [label, setLabel] = useState("");
    const [url, setUrl] = useState("");
    const [format, setFormat] = useState<string>("auto");
    const [phone, setPhone] = useState("");
    const [botToken, setBotToken] = useState("");
    const [chatId, setChatId] = useState("");
    const [minLevel, setMinLevel] = useState<AlertMinLevel>("info");
    const [error, setError] = useState<string | null>(null);
    const telegram = kind === "webhook" && format === "telegram";

    /**
     * The form, as the schema wants it.
     *
     * Built here rather than inside `submit` so one thing decides both whether
     * the button works and what is sent. It was only built on the press, so an
     * empty form had a live Add button whose entire behaviour was to turn itself
     * into a validation error - the reader was told to check a form they had not
     * filled in yet, about a field the message did not name.
     */
    // Telegram is asked for as the bot token and the chat it posts to, and sent
    // as the one URL the server already reads, checks and keeps encrypted.
    const target = telegram
        ? `https://api.telegram.org/bot${botToken.trim()}/sendMessage?chat_id=${encodeURIComponent(chatId.trim())}`
        : url.trim();
    const input =
        kind === "webhook"
            ? { kind, label: label.trim(), url: target, format, minLevel }
            : { kind, label: label.trim(), phone: phone.trim(), minLevel };
    const checked = destinationInputSchema.safeParse(input);

    function submit() {
        setError(null);
        const parsed = checked;
        if (!parsed.success) {
            setError(parsed.error.issues[0]?.message ?? t("destinations.checkForm"));
            return;
        }
        startTransition(async () => {
            const result = await createDestinationAction(parsed.data);
            if (result.error) {
                setError(result.error);
                return;
            }
            onAdded();
        });
    }

    return (
        <Dialog open onOpenChange={(open) => !open && onClose()}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>{t("destinations.dialog.title")}</DialogTitle>
                    <DialogDescription>{t("destinations.dialog.description")}</DialogDescription>
                </DialogHeader>
                <div className="flex flex-col gap-3">
                    <label className="flex flex-col gap-1 text-sm">
                        <span className="font-medium">{t("destinations.dialog.kind")}</span>
                        <Select
                            value={kind}
                            onValueChange={(value) => setKind(value as "webhook" | "sms")}
                            options={[
                                { value: "webhook", label: t("destinations.dialog.webhook") },
                                { value: "sms", label: t("destinations.dialog.sms") }
                            ]}
                        />
                    </label>
                    <label className="flex flex-col gap-1 text-sm">
                        <span className="font-medium">{t("destinations.dialog.name")}</span>
                        <Input
                            value={label}
                            onChange={(event) => setLabel(event.target.value)}
                            placeholder={
                                kind === "sms"
                                    ? t("destinations.dialog.phonePlaceholder")
                                    : t("destinations.dialog.webhookPlaceholder")
                            }
                        />
                    </label>
                    {kind === "webhook" ? (
                        <>
                            {telegram ? (
                                <>
                                    <label className="flex flex-col gap-1 text-sm">
                                        <span className="font-medium">
                                            {t("destinations.dialog.botToken")}
                                        </span>
                                        <Input
                                            type="password"
                                            autoComplete="off"
                                            value={botToken}
                                            onChange={(event) => setBotToken(event.target.value)}
                                        />
                                    </label>
                                    <label className="flex flex-col gap-1 text-sm">
                                        <span className="font-medium">
                                            {t("destinations.dialog.chatId")}
                                        </span>
                                        <Input
                                            value={chatId}
                                            onChange={(event) => setChatId(event.target.value)}
                                            placeholder="-1001234567890"
                                        />
                                        <span className="text-xs text-muted-foreground">
                                            {t("destinations.dialog.chatIdHint")}
                                        </span>
                                    </label>
                                </>
                            ) : (
                                <label className="flex flex-col gap-1 text-sm">
                                    <span className="font-medium">
                                        {t("destinations.dialog.url")}
                                    </span>
                                    <Input
                                        value={url}
                                        onChange={(event) => setUrl(event.target.value)}
                                        placeholder="https://discord.com/api/webhooks/..."
                                    />
                                    <span className="text-xs text-muted-foreground">
                                        {t("destinations.dialog.urlHint", {
                                            example:
                                                "https://api.telegram.org/bot<token>/sendMessage?chat_id=<chat id>"
                                        })}
                                    </span>
                                </label>
                            )}
                            <label className="flex flex-col gap-1 text-sm">
                                <span className="font-medium">
                                    {t("destinations.dialog.format")}
                                </span>
                                <Select
                                    value={format}
                                    onValueChange={setFormat}
                                    options={[
                                        { value: "auto", label: t("destinations.dialog.detect") },
                                        ...WEBHOOK_FORMATS.map((entry) => ({
                                            value: entry,
                                            label:
                                                entry === "generic"
                                                    ? t("destinations.dialog.rawJson")
                                                    : WEBHOOK_FORMAT_LABEL[entry]
                                        }))
                                    ]}
                                />
                            </label>
                        </>
                    ) : (
                        <label className="flex flex-col gap-1 text-sm">
                            <span className="font-medium">{t("destinations.dialog.number")}</span>
                            <Input
                                value={phone}
                                onChange={(event) => setPhone(event.target.value)}
                                placeholder="+34600111222"
                            />
                            <span className="text-xs text-muted-foreground">
                                {t("destinations.dialog.numberHint")}
                            </span>
                        </label>
                    )}
                    <label className="flex flex-col gap-1 text-sm">
                        <span className="font-medium">{t("destinations.levelLabel")}</span>
                        <Select
                            value={minLevel}
                            onValueChange={(value) => setMinLevel(value as AlertMinLevel)}
                            options={ALERT_MIN_LEVELS.map((level) => ({
                                value: level,
                                label: t(`destinations.level.${level}`)
                            }))}
                        />
                    </label>
                    {error ? <p className="text-sm text-danger">{error}</p> : null}
                    <div className="flex justify-end gap-2">
                        <Button variant="ghost" onClick={onClose} disabled={pending}>
                            {tc("actions.cancel")}
                        </Button>
                        {/* Held until the form is one the schema accepts, which is
                            the same check the press used to make - so the button
                            says what the press would have said, before it is
                            pressed. */}
                        <Button onClick={submit} disabled={pending || !checked.success}>
                            {t("destinations.add")}
                        </Button>
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    );
}
