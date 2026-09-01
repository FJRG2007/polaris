"use client";

/**
 * A project's webhook endpoints: where its deploys get reported.
 *
 * Shared rather than duplicated, because there are two honest places to reach
 * this - the project's own settings, and Watch, which is where the question
 * "where do alerts go" is answered for the whole instance. Both render this.
 *
 * The URL is the credential for most of these endpoints, so it is written once
 * and never read back: what the list shows is the mask stored beside it. An
 * endpoint that stops working says so from its last send rather than waiting to
 * be discovered during the deploy somebody needed to hear about.
 */

import Link from "next/link";
import { useEffect, useState, useTransition } from "react";
import { useDisplayFormat } from "@/components/display-format";
import type { ProjectWebhookView } from "@/lib/deploy-project-service";
import { Button, Checkbox, Input, Select, Switch, ConfirmDeleteDialog } from "@polaris/ui";
import { PROJECT_WEBHOOK_EVENTS, WEBHOOK_FORMATS, type WebhookFormat } from "@polaris/core";
import { CheckCircle2, CircleAlert, Loader2, Plus, Send, Trash2, Webhook } from "lucide-react";
import {
    createProjectWebhookAction,
    deleteProjectWebhookAction,
    listProjectWebhooksAction,
    setProjectWebhookEnabledAction,
    testProjectWebhookAction
} from "@/app/(app)/apps/deploy/project-actions";

const FORMAT_LABELS: Record<WebhookFormat, string> = {
    generic: "Generic JSON",
    discord: "Discord",
    slack: "Slack"
};

export function ProjectWebhooks({
    projectId,
    /** Shown above the list when the panel is not already inside a titled card. */
    heading
}: {
    projectId: string;
    heading?: string;
}) {
    const display = useDisplayFormat();
    const [hooks, setHooks] = useState<ProjectWebhookView[] | null>(null);
    const [canManage, setCanManage] = useState(false);
    const [adding, setAdding] = useState(false);
    const [deleting, setDeleting] = useState<ProjectWebhookView | null>(null);
    const [testResult, setTestResult] = useState<Record<string, string>>({});
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();

    function load() {
        void listProjectWebhooksAction(projectId).then((result) => {
            if (result.error) {
                setError(result.error);
                setHooks([]);
                return;
            }
            setHooks(result.webhooks ?? []);
            setCanManage(result.canManage ?? false);
        });
    }

    useEffect(load, [projectId]);

    function toggle(hook: ProjectWebhookView, enabled: boolean) {
        startTransition(async () => {
            const result = await setProjectWebhookEnabledAction({ projectId, id: hook.id, enabled });
            if (result.error) setError(result.error);
            load();
        });
    }

    function test(hook: ProjectWebhookView) {
        setTestResult((current) => ({ ...current, [hook.id]: "Sending..." }));
        startTransition(async () => {
            const result = await testProjectWebhookAction({ projectId, id: hook.id });
            setTestResult((current) => ({
                ...current,
                [hook.id]: result.error ?? "Delivered. Check the endpoint."
            }));
            load();
        });
    }

    function remove() {
        if (!deleting) return;
        startTransition(async () => {
            const result = await deleteProjectWebhookAction({ projectId, id: deleting.id });
            if (result.error) {
                setError(result.error);
                return;
            }
            setDeleting(null);
            load();
        });
    }

    return (
        <div className="flex flex-col gap-3">
            {heading && <h2 className="text-sm font-medium">{heading}</h2>}

            {error && <p className="text-sm text-danger">{error}</p>}

            <div className="overflow-hidden rounded-md border border-border/60">
                {hooks === null ? (
                    <div className="flex justify-center py-6 text-muted-foreground">
                        <Loader2 className="size-5 animate-spin" />
                    </div>
                ) : hooks.length === 0 ? (
                    <div className="flex flex-col items-center gap-1 px-3 py-8 text-center">
                        <Webhook className="size-5 text-muted-foreground" />
                        <p className="text-sm text-muted-foreground">
                            No endpoints. Deploys are still reported in the bell and by the account&apos;s own
                            notification rules.
                        </p>
                    </div>
                ) : (
                    hooks.map((hook) => (
                        <div
                            key={hook.id}
                            className="flex flex-wrap items-center justify-between gap-3 border-b border-border/40 px-3 py-2.5 last:border-0"
                        >
                            <div className="min-w-0 flex-1">
                                <p className="flex items-center gap-2 truncate text-sm font-medium">
                                    {hook.name}
                                    <span className="rounded border border-border/60 px-1.5 py-0.5 text-[0.625rem] text-muted-foreground">
                                        {FORMAT_LABELS[hook.format]}
                                    </span>
                                    {hook.status === "ok" && <CheckCircle2 className="size-3.5 shrink-0 text-success" />}
                                    {hook.status === "error" && <CircleAlert className="size-3.5 shrink-0 text-danger" />}
                                </p>
                                <p className="truncate font-mono text-xs text-muted-foreground">{hook.targetHint}</p>
                                <p className="truncate text-xs text-muted-foreground">
                                    {hook.events.length === 0
                                        ? "Every deploy event"
                                        : hook.events
                                              .map(
                                                  (id) =>
                                                      PROJECT_WEBHOOK_EVENTS.find((event) => event.id === id)?.label ??
                                                      id
                                              )
                                              .join(", ")}
                                    {hook.lastUsedAt ? ` - last sent ${display.dateTime(hook.lastUsedAt)}` : ""}
                                </p>
                                {hook.status === "error" && hook.lastError && (
                                    <p className="truncate text-xs text-danger">{hook.lastError}</p>
                                )}
                                {testResult[hook.id] && (
                                    <p className="truncate text-xs text-muted-foreground">{testResult[hook.id]}</p>
                                )}
                            </div>
                            {canManage && (
                                <div className="flex shrink-0 items-center gap-2">
                                    <Switch
                                        checked={hook.enabled}
                                        onChange={(next) => toggle(hook, next)}
                                        aria-label={`Enable ${hook.name}`}
                                    />
                                    <Button
                                        variant="ghost"
                                        size="icon"
                                        onClick={() => test(hook)}
                                        disabled={pending}
                                        aria-label={`Send a test to ${hook.name}`}
                                        title="Send a test event"
                                    >
                                        <Send className="size-4" />
                                    </Button>
                                    <Button
                                        variant="ghost"
                                        size="icon"
                                        onClick={() => setDeleting(hook)}
                                        aria-label={`Remove ${hook.name}`}
                                        title="Remove"
                                    >
                                        <Trash2 className="size-4" />
                                    </Button>
                                </div>
                            )}
                        </div>
                    ))
                )}
            </div>

            {canManage && (
                <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-xs text-muted-foreground">
                        Personal alerts (email, phone, your own webhooks) are set in{" "}
                        <Link href="/account/notifications" className="text-primary hover:underline">
                            notification preferences
                        </Link>
                        .
                    </p>
                    <Button variant="secondary" size="sm" onClick={() => setAdding(true)}>
                        <Plus className="size-4" /> Add endpoint
                    </Button>
                </div>
            )}

            {adding && (
                <AddWebhookForm
                    projectId={projectId}
                    onCancel={() => setAdding(false)}
                    onCreated={() => {
                        setAdding(false);
                        load();
                    }}
                />
            )}

            <ConfirmDeleteDialog
                open={deleting !== null}
                onOpenChange={(open) => !open && setDeleting(null)}
                name={deleting?.name ?? ""}
                kind="webhook"
                description="Deploys stop being reported to this endpoint. Nothing else changes."
                pending={pending}
                onConfirm={remove}
            />
        </div>
    );
}

function AddWebhookForm({
    projectId,
    onCancel,
    onCreated
}: {
    projectId: string;
    onCancel: () => void;
    onCreated: () => void;
}) {
    const [name, setName] = useState("");
    const [url, setUrl] = useState("");
    const [format, setFormat] = useState<WebhookFormat | "auto">("auto");
    const [events, setEvents] = useState<string[]>([]);
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();

    function submit() {
        setError(null);
        startTransition(async () => {
            const result = await createProjectWebhookAction({
                projectId,
                name: name.trim(),
                url: url.trim(),
                // "auto" means let the server read the shape off the URL, which gets
                // Discord and Slack right without the reader having to know.
                format: format === "auto" ? undefined : format,
                events: events as never[]
            });
            if (result.error) {
                setError(result.error);
                return;
            }
            onCreated();
        });
    }

    function toggleEvent(id: string, on: boolean) {
        setEvents((current) => (on ? [...current, id] : current.filter((entry) => entry !== id)));
    }

    return (
        <div className="flex flex-col gap-3 rounded-md border border-border/60 p-3">
            <div className="grid gap-2 sm:grid-cols-2">
                <label className="flex flex-col gap-1.5">
                    <span className="text-xs font-medium text-muted-foreground">Name</span>
                    <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="Team channel" />
                </label>
                <label className="flex flex-col gap-1.5">
                    <span className="text-xs font-medium text-muted-foreground">Format</span>
                    <Select
                        value={format}
                        onValueChange={(value) => setFormat(value as WebhookFormat | "auto")}
                        options={[
                            { value: "auto", label: "Detect from the URL" },
                            ...WEBHOOK_FORMATS.map((value) => ({ value, label: FORMAT_LABELS[value] }))
                        ]}
                        aria-label="Format"
                    />
                </label>
            </div>
            <label className="flex flex-col gap-1.5">
                <span className="text-xs font-medium text-muted-foreground">Endpoint URL</span>
                <Input
                    value={url}
                    onChange={(event) => setUrl(event.target.value)}
                    placeholder="https://discord.com/api/webhooks/..."
                    className="font-mono text-xs"
                />
                <span className="text-xs text-muted-foreground">
                    Stored encrypted and never shown again. Only a masked form appears in the list.
                </span>
            </label>
            <fieldset className="flex flex-col gap-1.5">
                <legend className="text-xs font-medium text-muted-foreground">Events</legend>
                <div className="flex flex-wrap gap-3">
                    {PROJECT_WEBHOOK_EVENTS.map((event) => (
                        <label key={event.id} className="flex items-center gap-2 text-sm">
                            <Checkbox
                                checked={events.includes(event.id)}
                                onChange={(input) => toggleEvent(event.id, input.target.checked)}
                            />
                            {event.label}
                        </label>
                    ))}
                </div>
                <span className="text-xs text-muted-foreground">Choosing none means every deploy event.</span>
            </fieldset>

            {error && <p className="text-sm text-danger">{error}</p>}

            <div className="flex justify-end gap-2">
                <Button variant="ghost" onClick={onCancel}>
                    Cancel
                </Button>
                <Button onClick={submit} disabled={pending || !name.trim() || !url.trim()}>
                    {pending && <Loader2 className="size-4 animate-spin" />} Add endpoint
                </Button>
            </div>
        </div>
    );
}
