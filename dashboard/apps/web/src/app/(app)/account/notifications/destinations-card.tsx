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
import { Plus, Send, Smartphone, Trash2, Webhook } from "lucide-react";
import { destinationInputSchema, WEBHOOK_FORMATS } from "@polaris/core";
import type { DestinationView } from "@/lib/notifications/destinations";
import {
    createDestinationAction,
    deleteDestinationAction,
    setDestinationEnabledAction,
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
    const [adding, setAdding] = useState(false);
    const [testResult, setTestResult] = useState<{ id: string; error: string | null } | null>(null);
    const [pending, startTransition] = useTransition();

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
                    <CardTitle>Destinations</CardTitle>
                    <p className="text-xs text-muted-foreground">
                        Webhooks and phone numbers you can route the events above to.
                    </p>
                </div>
                <Button size="sm" variant="secondary" onClick={() => setAdding(true)}>
                    <Plus className="size-4" />
                    Add
                </Button>
            </CardHeader>
            <CardBody className="p-0">
                {destinations.length === 0 ? (
                    <p className="px-4 py-6 text-center text-sm text-muted-foreground">
                        No destinations yet. Add a Discord or Slack webhook, or a number for texts.
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
                                            <p className="truncate text-sm font-medium">{destination.name}</p>
                                            <p className="truncate text-xs text-muted-foreground">
                                                {destination.targetHint}
                                                {destination.format ? ` - ${destination.format}` : ""}
                                            </p>
                                        </div>
                                    </div>
                                    <div className="flex shrink-0 items-center gap-1.5">
                                        {destination.status === "error" ? (
                                            <Badge variant="danger">Failing</Badge>
                                        ) : destination.status === "ok" ? (
                                            <Badge variant="success">Working</Badge>
                                        ) : null}
                                        <Switch
                                            checked={destination.enabled}
                                            onChange={(next) =>
                                                startTransition(async () => {
                                                    await setDestinationEnabledAction(destination.id, next);
                                                    router.refresh();
                                                })
                                            }
                                            aria-label={destination.enabled ? "Switch off" : "Switch on"}
                                        />
                                        <button
                                            type="button"
                                            aria-label="Send a test"
                                            title="Send a test"
                                            disabled={pending || !destination.enabled}
                                            onClick={() => test(destination.id)}
                                            className="rounded p-1 text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
                                        >
                                            <Send className="size-4" />
                                        </button>
                                        <button
                                            type="button"
                                            aria-label="Remove"
                                            title="Remove"
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
                                        Texts will not send until an SMS sender is connected under{" "}
                                        <Link href="/inbox/channels" className="underline">
                                            Channels
                                        </Link>
                                        .
                                    </p>
                                ) : null}
                                {testResult?.id === destination.id ? (
                                    <p className={testResult.error ? "text-xs text-danger" : "text-xs text-success"}>
                                        {testResult.error ?? "Test alert sent."}
                                    </p>
                                ) : destination.lastError ? (
                                    <p className="text-xs text-danger">{destination.lastError}</p>
                                ) : destination.lastUsedAt ? (
                                    <p className="text-xs text-muted-foreground">
                                        Last used <RelativeTime iso={destination.lastUsedAt} />
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
    const [pending, startTransition] = useTransition();
    const [kind, setKind] = useState<"webhook" | "sms">("webhook");
    const [label, setLabel] = useState("");
    const [url, setUrl] = useState("");
    const [format, setFormat] = useState<string>("auto");
    const [phone, setPhone] = useState("");
    const [error, setError] = useState<string | null>(null);

    function submit() {
        setError(null);
        const input =
            kind === "webhook"
                ? { kind, label: label.trim(), url: url.trim(), format }
                : { kind, label: label.trim(), phone: phone.trim() };
        const parsed = destinationInputSchema.safeParse(input);
        if (!parsed.success) {
            setError(parsed.error.issues[0]?.message ?? "Check the form");
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
                    <DialogTitle>Add a destination</DialogTitle>
                    <DialogDescription>
                        Somewhere alerts can go. Point events at it once it is added.
                    </DialogDescription>
                </DialogHeader>
                <div className="flex flex-col gap-3">
                    <label className="flex flex-col gap-1 text-sm">
                        <span className="font-medium">Kind</span>
                        <Select
                            value={kind}
                            onValueChange={(value) => setKind(value as "webhook" | "sms")}
                            options={[
                                { value: "webhook", label: "Webhook (Discord, Slack, your own)" },
                                { value: "sms", label: "Text message" }
                            ]}
                        />
                    </label>
                    <label className="flex flex-col gap-1 text-sm">
                        <span className="font-medium">Name</span>
                        <Input
                            value={label}
                            onChange={(event) => setLabel(event.target.value)}
                            placeholder={kind === "sms" ? "My phone" : "Ops channel"}
                        />
                    </label>
                    {kind === "webhook" ? (
                        <>
                            <label className="flex flex-col gap-1 text-sm">
                                <span className="font-medium">Webhook URL</span>
                                <Input
                                    value={url}
                                    onChange={(event) => setUrl(event.target.value)}
                                    placeholder="https://discord.com/api/webhooks/..."
                                />
                                <span className="text-xs text-muted-foreground">
                                    Anyone with this URL can post to the channel, so it is stored encrypted and
                                    never shown again.
                                </span>
                            </label>
                            <label className="flex flex-col gap-1 text-sm">
                                <span className="font-medium">Format</span>
                                <Select
                                    value={format}
                                    onValueChange={setFormat}
                                    options={[
                                        { value: "auto", label: "Detect from the URL" },
                                        ...WEBHOOK_FORMATS.map((entry) => ({
                                            value: entry,
                                            label: entry === "generic" ? "Raw JSON" : entry
                                        }))
                                    ]}
                                />
                            </label>
                        </>
                    ) : (
                        <label className="flex flex-col gap-1 text-sm">
                            <span className="font-medium">Number</span>
                            <Input
                                value={phone}
                                onChange={(event) => setPhone(event.target.value)}
                                placeholder="+34600111222"
                            />
                            <span className="text-xs text-muted-foreground">
                                International form, including the country code.
                            </span>
                        </label>
                    )}
                    {error ? <p className="text-sm text-danger">{error}</p> : null}
                    <div className="flex justify-end gap-2">
                        <Button variant="ghost" onClick={onClose} disabled={pending}>
                            Cancel
                        </Button>
                        <Button onClick={submit} disabled={pending}>
                            Add
                        </Button>
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    );
}
