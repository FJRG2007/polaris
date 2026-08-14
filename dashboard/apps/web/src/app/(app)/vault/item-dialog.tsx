"use client";

/**
 * Writing one vault item.
 *
 * One dialog for all five kinds, because they differ only in the middle: a name,
 * a folder, a note and custom fields are the same everywhere, and swapping the
 * type mid-edit should not throw away what has been typed around it.
 *
 * Everything is encrypted on the way out, in `vault-model`. Nothing in this file
 * touches a key - it works on the open object and hands it over.
 */

import * as core from "@polaris/core";
import { useEffect, useState } from "react";
import { PasswordGenerator, generate } from "@/components/password-generator";
import { Eye, EyeOff, Loader2, Plus, RefreshCw, X } from "lucide-react";
import { emptyItem, IDENTITY_FIELDS, type VaultFolder, type VaultItem } from "./vault-model";
import {
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    Input,
    Select,
    Textarea
} from "@polaris/ui";

const TYPE_OPTIONS = core.CIPHER_TYPES.map((type) => ({
    value: String(type),
    label: core.CIPHER_TYPE_LABEL[type]
}));

/** Turn a field key like `postalCode` into "Postal code". */
function humanize(field: string): string {
    const spaced = field.replace(/([A-Z])/g, " $1").toLowerCase().trim();
    return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export function ItemDialog({
    item,
    folders,
    onClose,
    onSave
}: {
    /** Null when the dialog is shut; an empty item to write a new one. */
    item: VaultItem | null;
    folders: VaultFolder[];
    onClose: () => void;
    onSave: (item: VaultItem) => Promise<string | null>;
}) {
    const [draft, setDraft] = useState<VaultItem>(emptyItem(core.CIPHER_LOGIN));
    const [revealed, setRevealed] = useState(false);
    const [generator, setGenerator] = useState(false);
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (!item) return;
        setDraft(item);
        setRevealed(false);
        setGenerator(false);
        setError(null);
    }, [item]);

    function patch(changes: Partial<VaultItem>): void {
        setDraft((prev) => ({ ...prev, ...changes }));
    }

    async function onSubmit(): Promise<void> {
        setPending(true);
        setError(null);
        const failure = await onSave(draft);
        setPending(false);
        if (failure) {
            setError(failure);
            return;
        }
        onClose();
    }

    return (
        <Dialog open={item !== null} onOpenChange={(open) => !open && onClose()}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>{draft.id ? "Edit item" : "New item"}</DialogTitle>
                    <DialogDescription>
                        Everything here is encrypted in this browser before it is saved.
                    </DialogDescription>
                </DialogHeader>

                <div className="flex max-h-[65vh] flex-col gap-3 overflow-y-auto pr-1">
                    <div className="grid grid-cols-2 gap-3">
                        <label className="flex flex-col gap-1 text-sm">
                            Kind
                            <Select
                                value={String(draft.type)}
                                onValueChange={(value) => patch({ type: Number(value) })}
                                options={TYPE_OPTIONS}
                                aria-label="Kind"
                                disabled={Boolean(draft.id)}
                            />
                        </label>
                        <label className="flex flex-col gap-1 text-sm">
                            Folder
                            <Select
                                value={draft.folderId ?? ""}
                                onValueChange={(value) => patch({ folderId: value || null })}
                                options={[
                                    { value: "", label: "No folder" },
                                    ...folders.map((folder) => ({
                                        value: folder.id,
                                        label: folder.name || "Untitled"
                                    }))
                                ]}
                                aria-label="Folder"
                            />
                        </label>
                    </div>

                    <label className="flex flex-col gap-1 text-sm">
                        Name
                        <Input
                            value={draft.name}
                            onChange={(event) => patch({ name: event.target.value })}
                            placeholder="What this is"
                            autoFocus
                        />
                    </label>

                    {draft.type === core.CIPHER_LOGIN ? (
                        <>
                            <label className="flex flex-col gap-1 text-sm">
                                Username
                                <Input
                                    value={draft.login.username}
                                    onChange={(event) =>
                                        patch({ login: { ...draft.login, username: event.target.value } })
                                    }
                                    autoComplete="off"
                                />
                            </label>
                            <label className="flex flex-col gap-1 text-sm">
                                Password
                                <div className="flex items-center gap-2">
                                    <Input
                                        type={revealed ? "text" : "password"}
                                        value={draft.login.password}
                                        onChange={(event) =>
                                            patch({
                                                login: { ...draft.login, password: event.target.value }
                                            })
                                        }
                                        autoComplete="off"
                                        className="font-mono"
                                    />
                                    <Button
                                        type="button"
                                        size="icon"
                                        variant="secondary"
                                        title={revealed ? "Hide" : "Show"}
                                        aria-label={revealed ? "Hide the password" : "Show the password"}
                                        onClick={() => setRevealed((prev) => !prev)}
                                    >
                                        {revealed ? (
                                            <EyeOff className="size-4" />
                                        ) : (
                                            <Eye className="size-4" />
                                        )}
                                    </Button>
                                    <Button
                                        type="button"
                                        size="icon"
                                        variant="secondary"
                                        title="Generate one"
                                        aria-label="Generate a password"
                                        onClick={() => {
                                            patch({
                                                login: {
                                                    ...draft.login,
                                                    password: generate({
                                                        kind: "password",
                                                        length: 20,
                                                        upper: true,
                                                        digits: true,
                                                        symbols: true,
                                                        separator: "-"
                                                    })
                                                }
                                            });
                                            setRevealed(true);
                                        }}
                                    >
                                        <RefreshCw className="size-4" />
                                    </Button>
                                </div>
                                <button
                                    type="button"
                                    className="self-start text-xs text-muted-foreground underline-offset-2 hover:underline"
                                    onClick={() => setGenerator((prev) => !prev)}
                                >
                                    {generator ? "Hide the generator" : "Open the generator"}
                                </button>
                            </label>
                            {generator ? (
                                <div className="rounded-md border border-border p-3">
                                    <PasswordGenerator
                                        onUse={(value) => {
                                            patch({ login: { ...draft.login, password: value } });
                                            setRevealed(true);
                                            setGenerator(false);
                                        }}
                                    />
                                </div>
                            ) : null}
                            <label className="flex flex-col gap-1 text-sm">
                                Authenticator key (optional)
                                <Input
                                    value={draft.login.totp}
                                    onChange={(event) =>
                                        patch({ login: { ...draft.login, totp: event.target.value } })
                                    }
                                    placeholder="The secret, or the whole otpauth:// link"
                                    autoComplete="off"
                                    className="font-mono text-xs"
                                />
                            </label>
                            <label className="flex flex-col gap-1 text-sm">
                                Website
                                <Input
                                    value={draft.login.uris[0] ?? ""}
                                    onChange={(event) =>
                                        patch({ login: { ...draft.login, uris: [event.target.value] } })
                                    }
                                    placeholder="https://example.com"
                                    autoComplete="off"
                                />
                            </label>
                        </>
                    ) : null}

                    {draft.type === core.CIPHER_CARD ? (
                        <>
                            <label className="flex flex-col gap-1 text-sm">
                                Name on the card
                                <Input
                                    value={draft.card.cardholderName}
                                    onChange={(event) =>
                                        patch({ card: { ...draft.card, cardholderName: event.target.value } })
                                    }
                                />
                            </label>
                            <label className="flex flex-col gap-1 text-sm">
                                Number
                                <Input
                                    value={draft.card.number}
                                    onChange={(event) =>
                                        patch({ card: { ...draft.card, number: event.target.value } })
                                    }
                                    className="font-mono"
                                    autoComplete="off"
                                />
                            </label>
                            <div className="grid grid-cols-3 gap-3">
                                <label className="flex flex-col gap-1 text-sm">
                                    Month
                                    <Input
                                        value={draft.card.expMonth}
                                        onChange={(event) =>
                                            patch({ card: { ...draft.card, expMonth: event.target.value } })
                                        }
                                        placeholder="MM"
                                    />
                                </label>
                                <label className="flex flex-col gap-1 text-sm">
                                    Year
                                    <Input
                                        value={draft.card.expYear}
                                        onChange={(event) =>
                                            patch({ card: { ...draft.card, expYear: event.target.value } })
                                        }
                                        placeholder="YYYY"
                                    />
                                </label>
                                <label className="flex flex-col gap-1 text-sm">
                                    Security code
                                    <Input
                                        type={revealed ? "text" : "password"}
                                        value={draft.card.code}
                                        onChange={(event) =>
                                            patch({ card: { ...draft.card, code: event.target.value } })
                                        }
                                        autoComplete="off"
                                    />
                                </label>
                            </div>
                        </>
                    ) : null}

                    {draft.type === core.CIPHER_IDENTITY ? (
                        <div className="grid grid-cols-2 gap-3">
                            {IDENTITY_FIELDS.map((field) => (
                                <label key={field} className="flex flex-col gap-1 text-sm">
                                    {humanize(field)}
                                    <Input
                                        value={draft.identity[field] ?? ""}
                                        onChange={(event) =>
                                            patch({
                                                identity: {
                                                    ...draft.identity,
                                                    [field]: event.target.value
                                                }
                                            })
                                        }
                                        autoComplete="off"
                                    />
                                </label>
                            ))}
                        </div>
                    ) : null}

                    {draft.type === core.CIPHER_SSH_KEY ? (
                        <>
                            <label className="flex flex-col gap-1 text-sm">
                                Private key
                                <Textarea
                                    rows={6}
                                    value={draft.sshKey.privateKey}
                                    onChange={(event) =>
                                        patch({ sshKey: { ...draft.sshKey, privateKey: event.target.value } })
                                    }
                                    spellCheck={false}
                                    className="font-mono text-xs"
                                />
                            </label>
                            <label className="flex flex-col gap-1 text-sm">
                                Public key
                                <Textarea
                                    rows={3}
                                    value={draft.sshKey.publicKey}
                                    onChange={(event) =>
                                        patch({ sshKey: { ...draft.sshKey, publicKey: event.target.value } })
                                    }
                                    spellCheck={false}
                                    className="font-mono text-xs"
                                />
                            </label>
                        </>
                    ) : null}

                    <label className="flex flex-col gap-1 text-sm">
                        Notes
                        <Textarea
                            rows={draft.type === core.CIPHER_SECURE_NOTE ? 10 : 3}
                            value={draft.notes}
                            onChange={(event) => patch({ notes: event.target.value })}
                        />
                    </label>

                    <div className="flex flex-col gap-2">
                        <div className="flex items-center justify-between">
                            <span className="text-sm">Custom fields</span>
                            <Button
                                type="button"
                                size="sm"
                                variant="ghost"
                                onClick={() =>
                                    patch({
                                        fields: [
                                            ...draft.fields,
                                            { name: "", value: "", type: core.FIELD_TEXT }
                                        ]
                                    })
                                }
                            >
                                <Plus className="size-4" />
                                Add
                            </Button>
                        </div>
                        {draft.fields.map((field, index) => (
                            <div key={index} className="flex items-center gap-2">
                                <Input
                                    value={field.name}
                                    placeholder="Name"
                                    onChange={(event) =>
                                        patch({
                                            fields: draft.fields.map((entry, at) =>
                                                at === index ? { ...entry, name: event.target.value } : entry
                                            )
                                        })
                                    }
                                />
                                <Input
                                    value={field.value}
                                    placeholder="Value"
                                    type={field.type === core.FIELD_HIDDEN && !revealed ? "password" : "text"}
                                    onChange={(event) =>
                                        patch({
                                            fields: draft.fields.map((entry, at) =>
                                                at === index ? { ...entry, value: event.target.value } : entry
                                            )
                                        })
                                    }
                                />
                                <Button
                                    type="button"
                                    size="icon"
                                    variant="ghost"
                                    title={field.type === core.FIELD_HIDDEN ? "Show as text" : "Hide"}
                                    aria-label="Toggle whether this field is hidden"
                                    onClick={() =>
                                        patch({
                                            fields: draft.fields.map((entry, at) =>
                                                at === index
                                                    ? {
                                                          ...entry,
                                                          type:
                                                              entry.type === core.FIELD_HIDDEN
                                                                  ? core.FIELD_TEXT
                                                                  : core.FIELD_HIDDEN
                                                      }
                                                    : entry
                                            )
                                        })
                                    }
                                >
                                    {field.type === core.FIELD_HIDDEN ? (
                                        <EyeOff className="size-4" />
                                    ) : (
                                        <Eye className="size-4" />
                                    )}
                                </Button>
                                <Button
                                    type="button"
                                    size="icon"
                                    variant="ghost"
                                    title="Remove this field"
                                    aria-label="Remove this field"
                                    onClick={() =>
                                        patch({ fields: draft.fields.filter((_, at) => at !== index) })
                                    }
                                >
                                    <X className="size-4" />
                                </Button>
                            </div>
                        ))}
                    </div>
                </div>

                {error ? <p className="text-sm text-danger">{error}</p> : null}
                <div className="flex justify-end gap-2">
                    <Button type="button" variant="secondary" onClick={onClose}>
                        Cancel
                    </Button>
                    <Button type="button" onClick={onSubmit} disabled={pending}>
                        {pending ? <Loader2 className="size-4 animate-spin" /> : null}
                        Save
                    </Button>
                </div>
            </DialogContent>
        </Dialog>
    );
}
