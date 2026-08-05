"use client";

/**
 * The provider keys this account brought, in the order it wants them tried.
 *
 * A table rather than a card per provider, because the list is now a list: an
 * account can hold several keys for one provider, and the row above another one
 * means something. The order IS the setting, so it is expressed by dragging
 * rather than by a column of numbers somebody has to keep consistent - and by
 * arrow buttons beside it, since an order only a mouse can express is one a
 * screen reader cannot express at all.
 *
 * A stored key is never shown again. There is nothing to reveal: the field is
 * write-only, and the only thing that proves a key still works is a run.
 */

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { runAction } from "@/lib/run-action";
import { IntegrationLogo } from "@/components/logos";
import { useConfirm } from "@/components/confirm-dialog";
import { RelativeTime } from "@/components/relative-time";
import type { UserModelKeyView } from "@/lib/agents/user-model-keys";
import { ProviderSelect, type ProviderOption } from "./provider-select";
import { MODEL_KEY_NAME_HINT, modelKeyNameSchema } from "@polaris/core";
import { ChevronDown, ChevronUp, GripVertical, Pencil, Plus, Trash2 } from "lucide-react";
import {
    addModelKeyAction,
    deleteModelKeyAction,
    reorderModelKeysAction,
    updateModelKeyAction
} from "./actions";
import {
    Badge,
    Button,
    Card,
    CardBody,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    Input
} from "@polaris/ui";

/** One provider, as the dialog and the table need it. */
export interface ProviderRow extends ProviderOption {
    apiKeyLabel: string;
    apiKeyHelp: string | null;
    createUrl: string | null;
    /** The gateway is not a provider: it needs an endpoint and a model as well as
     *  a token, and the token is frequently not needed at all. */
    isGateway: boolean;
    /** Whether Polaris can ask this provider whether a key is good before storing
     *  it, so the dialog can say which of the two it is doing. */
    checkable: boolean;
}

/** What the gateway needs beyond a key. Numbers stay as typed until the form is
 *  submitted: a partially typed "20" must not become 20 tokens. */
interface GatewayForm {
    baseUrl: string;
    model: string;
    context: string;
    maxOutput: string;
}

const EMPTY_GATEWAY: GatewayForm = { baseUrl: "", model: "", context: "", maxOutput: "" };

export function AiKeysView({
    providers,
    keys,
    instanceProviders,
    instanceShared
}: {
    providers: ProviderRow[];
    keys: UserModelKeyView[];
    /** Provider names the deployment would cover for a provider this account has
     *  no key of its own for. Empty when it shares none. */
    instanceProviders: string[];
    instanceShared: boolean;
}) {
    const router = useRouter();
    const [confirm, confirmElement] = useConfirm();
    const [rows, setRows] = useState(keys);
    const [editing, setEditing] = useState<UserModelKeyView | null>(null);
    const [adding, setAdding] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [notice, setNotice] = useState<string | null>(null);

    // The table is held in state so a drag can move a row before the server has
    // agreed, which means it has to be put back in step when the server sends a
    // new list - after an add, an edit or a delete. Without this the row somebody
    // just created never appears, because state ignores the new props.
    const [served, setServed] = useState(keys);
    if (served !== keys) {
        setServed(keys);
        setRows(keys);
    }

    const byslug = useMemo(() => new Map(providers.map((provider) => [provider.slug, provider])), [providers]);

    const persistOrder = (next: UserModelKeyView[]) => {
        const previous = rows;
        setRows(next);
        setError(null);
        void (async () => {
            const result = await runAction(
                () => reorderModelKeysAction({ ids: next.map((row) => row.id) }),
                setError
            );
            // Rolled back rather than left showing an order the server does not
            // hold: a list that lies about which key is first is worse than one
            // that snaps back.
            if (!result || result.error) {
                setRows(previous);
                if (result?.error) setError(result.error);
            }
        })();
    };

    const move = (from: number, to: number) => {
        if (to < 0 || to >= rows.length || from === to) return;
        const next = [...rows];
        const [row] = next.splice(from, 1);
        if (!row) return;
        next.splice(to, 0, row);
        persistOrder(next);
    };

    const remove = async (key: UserModelKeyView) => {
        const provider = byslug.get(key.provider);
        const ok = await confirm({
            title: `Delete "${key.name}"?`,
            description: `Runs stop using this ${provider?.name ?? key.provider} key. Anything below it in the list moves up.`,
            confirmLabel: "Delete",
            danger: true
        });
        if (!ok) return;
        const previous = rows;
        setRows(rows.filter((row) => row.id !== key.id));
        setError(null);
        const result = await runAction(() => deleteModelKeyAction({ id: key.id }), setError);
        if (!result || result.error) {
            setRows(previous);
            if (result?.error) setError(result.error);
            return;
        }
        router.refresh();
    };

    return (
        <div className="flex flex-col gap-4">
            {error ? <p className="text-danger text-sm">{error}</p> : null}
            {/* Bordered rather than plain text: it is the outcome of the save that
                just happened, and a muted line under the heading reads as part of
                the page's own copy. */}
            {notice ? (
                <p className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-sm text-amber-200/90">
                    {notice}
                </p>
            ) : null}

            <Card>
                <CardBody className="flex flex-col gap-3">
                    <div className="flex items-center justify-between gap-2">
                        <div className="min-w-0">
                            <h2 className="text-sm font-medium">Your provider keys</h2>
                            <p className="text-muted-foreground text-xs">
                                Tried from the top. The first key whose provider serves the model is the one a
                                run uses.
                            </p>
                        </div>
                        <Button size="sm" onClick={() => setAdding(true)}>
                            <Plus className="size-4 shrink-0" />
                            Add key
                        </Button>
                    </div>

                    <div className="overflow-x-auto rounded-lg border border-border">
                        <table className="w-full text-sm">
                            {/* Each column waits for the width that holds it, and nothing
                                arrives at md: that is where the navigation rail appears, so
                                the content area is narrower there than a breakpoint
                                earlier. */}
                            <thead className="bg-surface/60 text-left text-xs text-muted-foreground">
                                <tr>
                                    <th className="w-10 px-2 py-2 font-medium" aria-label="Order" />
                                    <th className="px-3 py-2 font-medium">Provider</th>
                                    {/* w-full max-w-0: the name is the column that gives, so
                                        a long one truncates instead of spilling the table
                                        sideways. */}
                                    <th className="w-full max-w-0 px-3 py-2 font-medium">Name</th>
                                    <th className="hidden whitespace-nowrap px-3 py-2 font-medium lg:table-cell">
                                        Last used
                                    </th>
                                    <th className="px-3 py-2" />
                                </tr>
                            </thead>
                            <tbody>
                                {rows.length === 0 ? (
                                    <tr>
                                        <td colSpan={5} className="text-muted-foreground px-3 py-8 text-center">
                                            {instanceShared && instanceProviders.length > 0
                                                ? "No keys of your own. Runs use the deployment's."
                                                : "No keys yet. A run needs one to reach a provider."}
                                        </td>
                                    </tr>
                                ) : (
                                    rows.map((row, index) => (
                                        <KeyRow
                                            key={row.id}
                                            row={row}
                                            provider={byslug.get(row.provider) ?? null}
                                            index={index}
                                            total={rows.length}
                                            onMove={move}
                                            onEdit={() => setEditing(row)}
                                            onRemove={() => void remove(row)}
                                        />
                                    ))
                                )}
                            </tbody>
                        </table>
                    </div>
                </CardBody>
            </Card>

            <Card>
                <CardBody className="flex flex-col gap-1">
                    <h2 className="text-sm font-medium">What a run falls back to</h2>
                    {instanceShared && instanceProviders.length > 0 ? (
                        <>
                            <p className="text-muted-foreground text-xs">
                                For a provider you have no key of your own for, runs use the deployment&apos;s.
                            </p>
                            <div className="mt-1 flex flex-wrap gap-1">
                                {instanceProviders.map((name) => (
                                    <Badge key={name} variant="neutral">
                                        {name}
                                    </Badge>
                                ))}
                            </div>
                        </>
                    ) : (
                        <p className="text-muted-foreground text-xs">
                            {instanceShared
                                ? "This deployment holds no provider keys, so a run can only use one you add here."
                                : "This deployment does not share its own provider keys, so a run can only use one you add here."}
                        </p>
                    )}
                </CardBody>
            </Card>

            {/* Mounted only while open, so every dialog starts empty. A form that
                survives being closed is one that offers the last key's name back,
                and holds a pasted secret in memory for the rest of the session. */}
            {adding ? (
                <KeyDialog
                    providers={providers}
                    existing={null}
                    onClose={() => setAdding(false)}
                    onSaved={(warning) => {
                        setAdding(false);
                        setNotice(warning ?? null);
                        router.refresh();
                    }}
                />
            ) : null}
            {editing ? (
                <KeyDialog
                    key={editing.id}
                    providers={providers}
                    existing={editing}
                    onClose={() => setEditing(null)}
                    onSaved={(warning) => {
                        setEditing(null);
                        setNotice(warning ?? null);
                        router.refresh();
                    }}
                />
            ) : null}
            {confirmElement}
        </div>
    );
}

function KeyRow({
    row,
    provider,
    index,
    total,
    onMove,
    onEdit,
    onRemove
}: {
    row: UserModelKeyView;
    provider: ProviderRow | null;
    index: number;
    total: number;
    onMove: (from: number, to: number) => void;
    onEdit: () => void;
    onRemove: () => void;
}) {
    const [over, setOver] = useState(false);
    const label = provider?.name ?? row.provider;

    return (
        <tr
            draggable
            onDragStart={(event) => event.dataTransfer.setData("text/plain", String(index))}
            onDragOver={(event) => {
                // Without this the drop never fires: the default handling of a
                // dragover is to refuse the drop.
                event.preventDefault();
                setOver(true);
            }}
            onDragLeave={() => setOver(false)}
            onDrop={(event) => {
                event.preventDefault();
                setOver(false);
                const from = Number(event.dataTransfer.getData("text/plain"));
                if (Number.isInteger(from)) onMove(from, index);
            }}
            className={`border-t border-border ${over ? "bg-muted/40" : ""}`}
        >
            <td className="px-2 py-2">
                <div className="flex items-center gap-1">
                    <GripVertical className="text-muted-foreground size-4 shrink-0 cursor-grab" aria-hidden />
                    <span className="text-muted-foreground w-4 shrink-0 text-xs tabular-nums">{index + 1}</span>
                </div>
            </td>
            <td className="px-3 py-2">
                <div className="flex items-center gap-2">
                    <IntegrationLogo slug={row.provider} className="size-4 shrink-0" />
                    <span className="whitespace-nowrap">{label}</span>
                </div>
            </td>
            <td className="w-full max-w-0 px-3 py-2">
                <span className="block truncate font-medium" title={row.name}>
                    {row.name}
                </span>
            </td>
            <td className="text-muted-foreground hidden whitespace-nowrap px-3 py-2 lg:table-cell">
                {row.lastUsedAt ? <RelativeTime iso={row.lastUsedAt} /> : "Never"}
            </td>
            <td className="px-3 py-2">
                <div className="flex items-center justify-end gap-1">
                    <Button
                        variant="ghost"
                        size="icon"
                        disabled={index === 0}
                        onClick={() => onMove(index, index - 1)}
                        aria-label={`Try ${row.name} earlier`}
                        title="Move up"
                    >
                        <ChevronUp className="size-4 shrink-0" />
                    </Button>
                    <Button
                        variant="ghost"
                        size="icon"
                        disabled={index === total - 1}
                        onClick={() => onMove(index, index + 1)}
                        aria-label={`Try ${row.name} later`}
                        title="Move down"
                    >
                        <ChevronDown className="size-4 shrink-0" />
                    </Button>
                    <Button
                        variant="ghost"
                        size="icon"
                        onClick={onEdit}
                        aria-label={`Edit ${row.name}`}
                        title="Edit"
                    >
                        <Pencil className="size-4 shrink-0" />
                    </Button>
                    <Button
                        variant="ghost"
                        size="icon"
                        onClick={onRemove}
                        aria-label={`Delete ${row.name}`}
                        title="Delete"
                    >
                        <Trash2 className="size-4 shrink-0" />
                    </Button>
                </div>
            </td>
        </tr>
    );
}

/**
 * Adding one, or editing one that exists.
 *
 * The same form both ways, because they ask for the same things - the only
 * difference is that an existing key's provider is fixed (a key belongs to the
 * provider that issued it) and its secret may be left alone.
 */
function KeyDialog({
    providers,
    existing,
    onClose,
    onSaved
}: {
    providers: ProviderRow[];
    /** The key being edited, or null when this is a new one. */
    existing: UserModelKeyView | null;
    onClose: () => void;
    onSaved: (warning?: string) => void;
}) {
    const [provider, setProvider] = useState(existing?.provider ?? providers[0]?.slug ?? "");
    const [name, setName] = useState(existing?.name ?? "");
    const [secret, setSecret] = useState("");
    const [gateway, setGateway] = useState<GatewayForm>(() => readGateway(existing));
    const [touched, setTouched] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const entry = providers.find((row) => row.slug === provider) ?? null;
    const nameCheck = modelKeyNameSchema.safeParse(name);
    const nameError = touched && name.length > 0 && !nameCheck.success ? MODEL_KEY_NAME_HINT : null;
    // A gateway with no token is a real setup - plenty accept unauthenticated
    // calls from inside the network - so only a provider needs the field filled.
    const secretReady = secret.trim().length >= 8 || (entry?.isGateway ?? false) || existing !== null;
    const gatewayReady =
        !entry?.isGateway || (gateway.baseUrl.trim().length > 0 && gateway.model.trim().length > 0);
    const ready = provider !== "" && nameCheck.success && secretReady && gatewayReady;

    const submit = async () => {
        setBusy(true);
        setError(null);
        const config = entry?.isGateway
            ? {
                  baseUrl: gateway.baseUrl.trim(),
                  model: gateway.model.trim(),
                  context: Number(gateway.context) || 0,
                  maxOutput: Number(gateway.maxOutput) || 0
              }
            : undefined;
        const typed = secret.trim();
        const result = await runAction(
            () =>
                existing
                    ? updateModelKeyAction({
                          id: existing.id,
                          name: name.trim(),
                          // Left blank means "leave the stored one alone". The
                          // field is write-only, so blank cannot mean erase.
                          secret: typed.length > 0 ? typed : undefined,
                          config
                      })
                    : addModelKeyAction({
                          provider,
                          name: name.trim(),
                          // A gateway that wants no token still needs a row, and
                          // the runtime sends a placeholder rather than nothing.
                          secret: entry?.isGateway && typed.length === 0 ? "unused-gateway" : typed,
                          config
                      }),
            setError
        );
        setBusy(false);
        if (!result) return;
        if (result.error) {
            setError(result.error);
            return;
        }
        onSaved(result.warning);
    };

    return (
        <Dialog open onOpenChange={(next) => !next && onClose()}>
            <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto">
                <DialogHeader>
                    <DialogTitle>{existing ? "Edit provider key" : "Add provider key"}</DialogTitle>
                    <DialogDescription>
                        {existing
                            ? "Rename it, or paste a new key to replace the stored one."
                            : "The provider account your runs bill to. Polaris adds nothing to that bill."}
                    </DialogDescription>
                </DialogHeader>

                <div className="flex flex-col gap-4">
                    <label className="flex flex-col gap-1 text-sm">
                        Provider
                        {existing ? (
                            <span className="border-input bg-surface flex h-9 items-center gap-2 rounded-md border px-3 text-sm">
                                <IntegrationLogo slug={existing.provider} className="size-4 shrink-0" />
                                <span className="min-w-0 truncate" title={entry?.name ?? existing.provider}>
                                    {entry?.name ?? existing.provider}
                                </span>
                            </span>
                        ) : (
                            <ProviderSelect
                                options={providers}
                                value={provider}
                                onChange={setProvider}
                                disabled={busy}
                            />
                        )}
                    </label>

                    <label className="flex flex-col gap-1 text-sm">
                        Name
                        <Input
                            value={name}
                            placeholder="e.g. prod-main"
                            autoComplete="off"
                            aria-invalid={nameError !== null}
                            onChange={(event) => {
                                setName(event.target.value);
                                setTouched(true);
                            }}
                            onBlur={() => setTouched(true)}
                        />
                        <span className={`text-xs ${nameError ? "text-danger" : "text-muted-foreground"}`}>
                            {MODEL_KEY_NAME_HINT}
                        </span>
                    </label>

                    {entry?.isGateway ? (
                        <>
                            <label className="flex flex-col gap-1 text-sm">
                                Endpoint
                                <Input
                                    value={gateway.baseUrl}
                                    placeholder="https://gateway.example/v1"
                                    onChange={(event) =>
                                        setGateway({ ...gateway, baseUrl: event.target.value })
                                    }
                                />
                            </label>
                            <label className="flex flex-col gap-1 text-sm">
                                Model
                                <Input
                                    value={gateway.model}
                                    placeholder="the id your endpoint serves"
                                    onChange={(event) => setGateway({ ...gateway, model: event.target.value })}
                                />
                            </label>
                            <div className="grid gap-2 sm:grid-cols-2">
                                <label className="flex flex-col gap-1 text-sm">
                                    Context window
                                    <Input
                                        value={gateway.context}
                                        inputMode="numeric"
                                        placeholder="200000"
                                        onChange={(event) =>
                                            setGateway({ ...gateway, context: event.target.value })
                                        }
                                    />
                                </label>
                                <label className="flex flex-col gap-1 text-sm">
                                    Max output
                                    <Input
                                        value={gateway.maxOutput}
                                        inputMode="numeric"
                                        placeholder="32000"
                                        onChange={(event) =>
                                            setGateway({ ...gateway, maxOutput: event.target.value })
                                        }
                                    />
                                </label>
                            </div>
                            <p className="text-muted-foreground -mt-2 text-xs">
                                An endpoint publishes no catalogue, so both numbers are needed: without them a
                                run answers in 32,000-token slices and never compacts.
                            </p>
                        </>
                    ) : null}

                    <label className="flex flex-col gap-1 text-sm">
                        {entry?.apiKeyLabel ?? "API key"}
                        <Input
                            type="password"
                            value={secret}
                            autoComplete="off"
                            placeholder={
                                existing
                                    ? "Leave blank to keep the stored key"
                                    : entry?.isGateway
                                      ? "Leave blank if your endpoint needs none"
                                      : "Paste your provider API key"
                            }
                            onChange={(event) => setSecret(event.target.value)}
                        />
                        <span className="text-muted-foreground text-xs">
                            Stored encrypted.{" "}
                            {entry?.checkable
                                ? `Validated against ${entry.name} before saving (no credits used).`
                                : "Proven by the first run."}
                        </span>
                        {entry?.apiKeyHelp ? (
                            <span className="text-muted-foreground text-xs">{entry.apiKeyHelp}</span>
                        ) : null}
                    </label>

                    {existing ? null : (
                        <p className="text-muted-foreground text-xs">
                            Added at the bottom of the list. Drag rows in the table to reorder.
                        </p>
                    )}

                    {error ? <p className="text-danger text-sm">{error}</p> : null}

                    <div className="flex items-center justify-end gap-2">
                        {entry?.createUrl && !existing ? (
                            <a
                                href={entry.createUrl}
                                target="_blank"
                                rel="noreferrer noopener"
                                className="text-muted-foreground hover:text-foreground mr-auto text-xs"
                            >
                                Create one at {entry.name}
                            </a>
                        ) : null}
                        <Button variant="ghost" onClick={onClose} disabled={busy}>
                            Cancel
                        </Button>
                        <Button onClick={() => void submit()} disabled={busy || !ready}>
                            {busy ? "Checking..." : existing ? "Save" : "Add key"}
                        </Button>
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    );
}

/** The gateway settings a stored key carries, as the form's strings. */
function readGateway(key: UserModelKeyView | null): GatewayForm {
    if (!key) return EMPTY_GATEWAY;
    const config = key.config;
    const text = (value: unknown) => (typeof value === "string" ? value : "");
    const number = (value: unknown) => (typeof value === "number" && value > 0 ? String(value) : "");
    return {
        baseUrl: text(config.baseUrl),
        model: text(config.model),
        context: number(config.context),
        maxOutput: number(config.maxOutput)
    };
}
