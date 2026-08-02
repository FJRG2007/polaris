"use client";

/**
 * Shared variables: values every service in one environment gets, without having
 * to be set on each of them.
 *
 * Secrets are write-only from here. A secret can be replaced or removed but never
 * read back into the page - the value exists on the server and in the container,
 * and a settings screen is not a good enough reason to add a third place.
 *
 * Saving one redeploys the services that use it, the same way editing a service's
 * own variables does: a variable that has been saved but is not in effect is the
 * kind of difference nobody notices until it matters.
 */

import { SettingsCard } from "../project-settings";
import type { EnvVarView } from "@/lib/env-var-service";
import { useEffect, useState, useTransition } from "react";
import { Button, Checkbox, Input, Select } from "@polaris/ui";
import type { ProjectSettingsView } from "@/lib/deploy-project-service";
import { Eye, EyeOff, Loader2, Plus, Trash2, Upload } from "lucide-react";
import { NEW_ENVIRONMENT, NewEnvironmentDialog, newEnvironmentOption } from "../new-environment-dialog";
import {
    deleteEnvVarAction,
    importEnvVarsAction,
    listEnvVarsAction,
    revealEnvVarAction,
    saveEnvVarAction
} from "../actions";

export function SharedVariablesSection({
    settings,
    canManage
}: {
    settings: ProjectSettingsView;
    canManage: boolean;
}) {
    const first = settings.environments.find((environment) => environment.isDefault) ?? settings.environments[0];
    const [environmentId, setEnvironmentId] = useState(first?.id ?? "");
    const [vars, setVars] = useState<EnvVarView[] | null>(null);
    const [revealed, setRevealed] = useState<Record<string, string>>({});
    const [key, setKey] = useState("");
    const [value, setValue] = useState("");
    const [secret, setSecret] = useState(false);
    const [importing, setImporting] = useState(false);
    const [creating, setCreating] = useState(false);
    const [bulk, setBulk] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();

    function load() {
        if (!environmentId) return;
        setVars(null);
        setRevealed({});
        void listEnvVarsAction("environment", environmentId).then(setVars).catch(() => setVars([]));
    }

    useEffect(load, [environmentId]);

    function add() {
        if (!key.trim()) return;
        setError(null);
        startTransition(async () => {
            const result = await saveEnvVarAction({
                scope: "environment",
                scopeId: environmentId,
                key: key.trim(),
                value,
                isSecret: secret
            });
            if (result.error) {
                setError(result.error);
                return;
            }
            setKey("");
            setValue("");
            setSecret(false);
            load();
        });
    }

    function importBlob() {
        if (!bulk.trim()) return;
        setError(null);
        startTransition(async () => {
            const result = await importEnvVarsAction({
                scope: "environment",
                scopeId: environmentId,
                text: bulk,
                isSecret: secret
            });
            if (result.error) {
                setError(result.error);
                return;
            }
            setBulk("");
            setImporting(false);
            load();
        });
    }

    function remove(id: string) {
        startTransition(async () => {
            await deleteEnvVarAction(id);
            load();
        });
    }

    function reveal(entry: EnvVarView) {
        if (revealed[entry.id] !== undefined) {
            setRevealed((current) => {
                const next = { ...current };
                delete next[entry.id];
                return next;
            });
            return;
        }
        void revealEnvVarAction(entry.id).then((result) => {
            if (result.value != null) setRevealed((current) => ({ ...current, [entry.id]: result.value as string }));
        });
    }

    /** Picking the create option opens the dialog instead of switching to it. */
    function selectEnvironment(id: string) {
        if (id === NEW_ENVIRONMENT) setCreating(true);
        else setEnvironmentId(id);
    }

    if (!first) {
        return (
            <>
                <SettingsCard title="Shared variables" description="Values every service in an environment receives.">
                    <p className="text-sm text-muted-foreground">This project has no environments yet.</p>
                    {canManage && (
                        <div>
                            <Button variant="ghost" onClick={() => setCreating(true)}>
                                <Plus className="size-4" /> New environment
                            </Button>
                        </div>
                    )}
                </SettingsCard>
                <NewEnvironmentDialog
                    projectId={settings.id}
                    open={creating}
                    onOpenChange={setCreating}
                    onCreated={setEnvironmentId}
                />
            </>
        );
    }

    return (
        <div className="flex flex-col gap-4">
            <SettingsCard
                title="Shared variables"
                description="Set once per environment and delivered to every service in it. A service's own variable of the same name wins."
            >
                <Select
                    value={environmentId}
                    onValueChange={selectEnvironment}
                    options={[
                        ...settings.environments.map((environment) => ({
                            value: environment.id,
                            label: environment.name
                        })),
                        ...newEnvironmentOption(canManage)
                    ]}
                    className="max-w-xs"
                    aria-label="Environment"
                />

                {error && <p className="text-sm text-danger">{error}</p>}

                <div className="overflow-hidden rounded-md border border-border/60">
                    {vars === null ? (
                        <div className="flex justify-center py-6 text-muted-foreground">
                            <Loader2 className="size-5 animate-spin" />
                        </div>
                    ) : vars.length === 0 ? (
                        <p className="px-3 py-4 text-sm text-muted-foreground">
                            No shared variables in this environment.
                        </p>
                    ) : (
                        vars.map((entry) => (
                            <div
                                key={entry.id}
                                className="flex items-center justify-between gap-3 border-b border-border/40 px-3 py-2 last:border-0"
                            >
                                <div className="min-w-0 flex-1">
                                    <p className="truncate font-mono text-xs font-medium">{entry.key}</p>
                                    <p className="truncate font-mono text-xs text-muted-foreground">
                                        {entry.isSecret
                                            ? (revealed[entry.id] ?? "••••••••")
                                            : (entry.value ?? "")}
                                    </p>
                                </div>
                                <div className="flex shrink-0 items-center gap-1">
                                    {entry.isSecret && (
                                        <Button
                                            variant="ghost"
                                            size="icon"
                                            onClick={() => reveal(entry)}
                                            aria-label={revealed[entry.id] ? `Hide ${entry.key}` : `Reveal ${entry.key}`}
                                            title={revealed[entry.id] ? "Hide" : "Reveal"}
                                        >
                                            {revealed[entry.id] ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                                        </Button>
                                    )}
                                    {canManage && (
                                        <Button
                                            variant="ghost"
                                            size="icon"
                                            onClick={() => remove(entry.id)}
                                            disabled={pending}
                                            aria-label={`Remove ${entry.key}`}
                                            title="Remove"
                                        >
                                            <Trash2 className="size-4" />
                                        </Button>
                                    )}
                                </div>
                            </div>
                        ))
                    )}
                </div>
            </SettingsCard>

            {canManage && (
                <SettingsCard
                    title="Add a variable"
                    description="Saving redeploys the services in this environment so the change actually takes effect."
                >
                    {importing ? (
                        <div className="flex flex-col gap-3">
                            <textarea
                                value={bulk}
                                onChange={(event) => setBulk(event.target.value)}
                                rows={6}
                                spellCheck={false}
                                placeholder={"DATABASE_URL=postgres://...\nAPI_TOKEN=..."}
                                className="w-full rounded-md border border-border bg-transparent px-3 py-2 font-mono text-xs outline-none focus:border-primary"
                            />
                            <label className="flex items-center gap-2 text-sm">
                                <Checkbox checked={secret} onChange={(event) => setSecret(event.target.checked)} />
                                Store these as secrets
                            </label>
                            <div className="flex justify-end gap-2">
                                <Button variant="ghost" onClick={() => setImporting(false)}>
                                    Cancel
                                </Button>
                                <Button onClick={importBlob} disabled={pending || !bulk.trim()}>
                                    {pending && <Loader2 className="size-4 animate-spin" />} Import
                                </Button>
                            </div>
                        </div>
                    ) : (
                        <div className="flex flex-col gap-3">
                            <div className="grid gap-2 sm:grid-cols-2">
                                <Input
                                    value={key}
                                    onChange={(event) => setKey(event.target.value)}
                                    placeholder="KEY"
                                    className="font-mono text-xs"
                                />
                                <Input
                                    value={value}
                                    type={secret ? "password" : "text"}
                                    onChange={(event) => setValue(event.target.value)}
                                    placeholder="value"
                                    className="font-mono text-xs"
                                    onKeyDown={(event) => event.key === "Enter" && add()}
                                />
                            </div>
                            <div className="flex flex-wrap items-center justify-between gap-2">
                                <label className="flex items-center gap-2 text-sm">
                                    <Checkbox checked={secret} onChange={(event) => setSecret(event.target.checked)} />
                                    Secret
                                </label>
                                <div className="flex gap-2">
                                    <Button variant="ghost" onClick={() => setImporting(true)}>
                                        <Upload className="size-4" /> Import .env
                                    </Button>
                                    <Button onClick={add} disabled={pending || !key.trim()}>
                                        {pending ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
                                        Add
                                    </Button>
                                </div>
                            </div>
                        </div>
                    )}
                </SettingsCard>
            )}

            <NewEnvironmentDialog
                projectId={settings.id}
                open={creating}
                onOpenChange={setCreating}
                onCreated={setEnvironmentId}
            />
        </div>
    );
}
