"use client";

/**
 * One row per provider, saying where a run would get its credential.
 *
 * Every provider is listed, not only the ones with a key, because the useful
 * question is "can I run on this" and a screen that hid the empty ones would
 * answer it by omission. Each row says which of the three states it is in -
 * yours, the deployment's, or nothing - so the fallback is visible rather than
 * something to work out from what is missing.
 *
 * A stored key is never shown again. There is nothing to reveal: the field is
 * write-only, and the only thing that proves a key works is a run.
 */

import { runAction } from "@/lib/run-action";
import { useState, useTransition } from "react";
import { Check, ExternalLink, Trash2 } from "lucide-react";
import { Badge, Button, Card, CardBody, Input } from "@polaris/ui";
import { deleteModelKeyAction, saveModelKeyAction } from "./actions";
import type { KeySource, UserModelKeyView } from "@/lib/agents/user-model-keys";

export interface ProviderRow {
    slug: string;
    name: string;
    apiKeyLabel: string;
    apiKeyHelp: string | null;
    createUrl: string | null;
    /** The gateway is not a provider: it needs an endpoint and a model as well
     *  as a token, and the token is frequently not needed at all. */
    isGateway: boolean;
}

export function ModelKeysView({
    providers,
    keys,
    sources,
    instanceShared
}: {
    providers: ProviderRow[];
    keys: UserModelKeyView[];
    sources: Array<[string, KeySource]>;
    instanceShared: boolean;
}) {
    const [mine, setMine] = useState(new Set(keys.map((key) => key.provider)));
    const [source, setSource] = useState(new Map<string, KeySource>(sources));
    const [error, setError] = useState<string | null>(null);

    const stored = (slug: string, present: boolean) => {
        setMine((was) => {
            const next = new Set(was);
            if (present) next.add(slug);
            else next.delete(slug);
            return next;
        });
        setSource((was) => {
            const next = new Map(was);
            if (present) next.set(slug, "own");
            // Removing a personal key does not mean nothing is left: the
            // deployment's may be underneath it. Reloading is the only honest
            // answer, so the row simply stops claiming to know.
            else next.delete(slug);
            return next;
        });
    };

    return (
        <div className="space-y-4">
            {error ? <p className="text-sm text-red-400">{error}</p> : null}

            <p className="text-muted-foreground text-sm">
                {instanceShared
                    ? "Providers you have not added a key for fall back to the deployment's, where it has one."
                    : "This deployment does not share its own provider keys, so a run can only use a key you add here."}
            </p>

            {providers.map((provider) => (
                <ProviderCard
                    key={provider.slug}
                    provider={provider}
                    hasOwn={mine.has(provider.slug)}
                    source={source.get(provider.slug) ?? null}
                    onStored={stored}
                    onError={setError}
                />
            ))}
        </div>
    );
}

function ProviderCard({
    provider,
    hasOwn,
    source,
    onStored,
    onError
}: {
    provider: ProviderRow;
    hasOwn: boolean;
    source: KeySource | null;
    onStored: (slug: string, present: boolean) => void;
    onError: (message: string | null) => void;
}) {
    const [open, setOpen] = useState(false);
    const [secret, setSecret] = useState("");
    const [baseUrl, setBaseUrl] = useState("");
    const [model, setModel] = useState("");
    const [context, setContext] = useState("");
    const [maxOutput, setMaxOutput] = useState("");
    const [pending, startTransition] = useTransition();

    const save = () => {
        onError(null);
        startTransition(() => {
            void (async () => {
                const result = await runAction(
                    () =>
                        saveModelKeyAction({
                            provider: provider.slug,
                            // A gateway that wants no token still needs a row, and
                            // the runtime sends a placeholder rather than nothing.
                            secret: provider.isGateway && !secret.trim() ? "unused-gateway" : secret,
                            ...(provider.isGateway
                                ? {
                                      config: {
                                          baseUrl: baseUrl.trim(),
                                          model: model.trim(),
                                          context: Number(context) || 0,
                                          maxOutput: Number(maxOutput) || 0
                                      }
                                  }
                                : {})
                        }),
                    onError
                );
                if (result && !result.error) {
                    setSecret("");
                    setOpen(false);
                    onStored(provider.slug, true);
                }
            })();
        });
    };

    const remove = () => {
        onError(null);
        startTransition(() => {
            void (async () => {
                const result = await runAction(() => deleteModelKeyAction({ provider: provider.slug }), onError);
                if (result && !result.error) onStored(provider.slug, false);
            })();
        });
    };

    return (
        <Card>
            <CardBody className="space-y-3">
                <div className="flex items-center gap-3">
                    <p className="min-w-0 flex-1 truncate text-sm font-medium" title={provider.name}>{provider.name}</p>
                    {hasOwn ? (
                        <Badge variant="success">
                            <Check className="size-3 shrink-0" />
                            Your key
                        </Badge>
                    ) : source === "instance" ? (
                        <Badge variant="neutral">This deployment&apos;s key</Badge>
                    ) : (
                        <Badge variant="neutral">Not set up</Badge>
                    )}
                    {hasOwn ? (
                        <Button
                            variant="ghost"
                            size="icon"
                            disabled={pending}
                            onClick={remove}
                            aria-label={`Remove your ${provider.name} key`}
                            title="Remove your key"
                        >
                            <Trash2 className="size-4 shrink-0" />
                        </Button>
                    ) : null}
                    <Button variant="secondary" size="sm" onClick={() => setOpen((was) => !was)}>
                        {hasOwn ? "Replace" : "Add key"}
                    </Button>
                </div>

                {open ? (
                    <div className="space-y-2">
                        {provider.isGateway ? (
                            <>
                                <LabelledInput label="Endpoint" value={baseUrl} onChange={setBaseUrl} placeholder="https://gateway.example/v1" />
                                <LabelledInput label="Model" value={model} onChange={setModel} placeholder="the id your endpoint serves" />
                                <div className="grid gap-2 sm:grid-cols-2">
                                    <LabelledInput
                                        label="Context window"
                                        value={context}
                                        onChange={setContext}
                                        placeholder="200000"
                                    />
                                    <LabelledInput
                                        label="Max output"
                                        value={maxOutput}
                                        onChange={setMaxOutput}
                                        placeholder="32000"
                                    />
                                </div>
                                <p className="text-muted-foreground text-xs">
                                    An endpoint publishes no catalogue, so both numbers are needed: without them a run
                                    answers in 32,000-token slices and never compacts.
                                </p>
                            </>
                        ) : null}

                        <LabelledInput
                            label={provider.apiKeyLabel}
                            value={secret}
                            onChange={setSecret}
                            type="password"
                            placeholder={provider.isGateway ? "leave blank if it needs none" : ""}
                        />
                        {provider.apiKeyHelp ? (
                            <p className="text-muted-foreground text-xs">{provider.apiKeyHelp}</p>
                        ) : null}

                        <div className="flex items-center gap-2">
                            <Button size="sm" onClick={save} disabled={pending}>
                                Save
                            </Button>
                            <Button size="sm" variant="ghost" onClick={() => setOpen(false)} disabled={pending}>
                                Cancel
                            </Button>
                            {provider.createUrl ? (
                                <a
                                    href={provider.createUrl}
                                    target="_blank"
                                    rel="noreferrer noopener"
                                    className="text-muted-foreground hover:text-foreground ml-auto inline-flex items-center gap-1 text-xs"
                                >
                                    Create one
                                    <ExternalLink className="size-3 shrink-0" />
                                </a>
                            ) : null}
                        </div>
                    </div>
                ) : null}
            </CardBody>
        </Card>
    );
}

function LabelledInput({
    label,
    value,
    onChange,
    type,
    placeholder
}: {
    label: string;
    value: string;
    onChange: (next: string) => void;
    type?: string;
    placeholder?: string;
}) {
    return (
        <label className="block space-y-1">
            <span className="text-sm font-medium">{label}</span>
            <Input
                value={value}
                type={type}
                placeholder={placeholder}
                onChange={(event) => onChange(event.target.value)}
            />
        </label>
    );
}
