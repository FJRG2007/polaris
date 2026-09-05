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
import { useVaultSession } from "./vault-session";
import { useVaultCollections } from "./use-vault-collections";
import { PasswordGenerator, generate } from "@/components/password-generator";
import { QrScanDialog } from "./qr-scan";
import { parseTotp } from "@/lib/vault/totp-browser";
import { FolderPlus, Loader2, Lock, LockOpen, Plus, QrCode, RefreshCw, Trash2, X } from "lucide-react";
import { emptyItem, IDENTITY_FIELDS, type VaultFolder, type VaultItem } from "./vault-model";
import {
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Input,
    Select,
    Textarea,
    useDeferredFocus
} from "@polaris/ui";

/** One address in the list replaced, with the list grown to reach it - the row
 *  drawn for an item that has none yet is index 0 of a list that is still
 *  empty. */
function replaceUri(
    uris: VaultItem["login"]["uris"],
    index: number,
    entry: VaultItem["login"]["uris"][number]
): VaultItem["login"]["uris"] {
    const next = [...uris];
    next[index] = entry;
    return next;
}

const TYPE_OPTIONS = core.CIPHER_TYPES.map((type) => ({
    value: String(type),
    label: core.CIPHER_TYPE_LABEL[type]
}));

/** Turn a field key like `postalCode` into "Postal code". */
function humanize(field: string): string {
    const spaced = field
        .replace(/([A-Z])/g, " $1")
        .toLowerCase()
        .trim();
    return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** The folder picker's own entry for making one, rather than picking one. */
const NEW_FOLDER = "__new-folder__";

export function ItemDialog({
    item,
    folders,
    onClose,
    onSave,
    onCreateFolder
}: {
    /** Null when the dialog is shut; an empty item to write a new one. */
    item: VaultItem | null;
    folders: VaultFolder[];
    onClose: () => void;
    /** The collections are where a NEW item lands when it is written straight
     *  into another vault; an item that already exists keeps the ones it is in. */
    onSave: (item: VaultItem, collectionIds: string[]) => Promise<string | null>;
    /** Makes a folder and answers with its id, or null if it could not. */
    onCreateFolder: (name: string) => Promise<string | null>;
}) {
    const { vaults, vaultKeys } = useVaultSession();
    const [draft, setDraft] = useState<VaultItem>(emptyItem(core.CIPHER_LOGIN));
    const [generator, setGenerator] = useState(false);
    /** Whether the QR reader is open. Its own state rather than a route, because
     *  it belongs to the field beside it. */
    const [scanning, setScanning] = useState(false);
    const [newFolder, setNewFolder] = useState<string | null>(null);
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [collectionId, setCollectionId] = useState("");
    // Only a new item chooses: moving one that exists re-encrypts it, which is
    // the move dialog's job and not something a Save button should do quietly.
    const choosable = draft.id
        ? []
        : vaults.filter((vault) => vault.vaultId !== null && vaultKeys.has(vault.vaultId));
    const { collections } = useVaultCollections(draft.id ? null : draft.organizationId);
    // Not `autoFocus`: the Select's focus scope is still trapping when this
    // field mounts and hands focus straight back to the trigger.
    const folderNameField = useDeferredFocus<HTMLInputElement>(newFolder !== null);

    useEffect(() => {
        if (!item) return;
        setDraft(item);
        setGenerator(false);
        setNewFolder(null);
        setError(null);
    }, [item]);

    // Land on the first collection of whichever vault is picked, and never keep
    // an id belonging to the vault chosen before it.
    useEffect(() => {
        setCollectionId(collections[0]?.id ?? "");
    }, [collections]);

    /** Make the folder that was just typed and file this item in it. */
    async function createFolder(): Promise<void> {
        const name = (newFolder ?? "").trim();
        if (!name) return;
        setPending(true);
        const id = await onCreateFolder(name);
        setPending(false);
        if (!id) {
            setError("That folder could not be created.");
            return;
        }
        patch({ folderId: id });
        setNewFolder(null);
    }

    function patch(changes: Partial<VaultItem>): void {
        setDraft((prev) => ({ ...prev, ...changes }));
    }

    async function onSubmit(): Promise<void> {
        const intoVault = !draft.id && draft.organizationId !== null;
        if (intoVault && !collectionId) {
            setError("Pick a collection to put it in.");
            return;
        }
        setPending(true);
        setError(null);
        const failure = await onSave(draft, intoVault ? [collectionId] : []);
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
                                onValueChange={(value) => {
                                    if (value === NEW_FOLDER) {
                                        setNewFolder("");
                                        return;
                                    }
                                    setNewFolder(null);
                                    patch({ folderId: value || null });
                                }}
                                options={[
                                    { value: "", label: "No folder" },
                                    ...folders.map((folder) => ({
                                        value: folder.id,
                                        label: folder.name || "Untitled"
                                    })),
                                    { value: NEW_FOLDER, label: "New folder..." }
                                ]}
                                aria-label="Folder"
                            />
                        </label>
                    </div>

                    {/* Which vault it goes in, and where inside it. Only for a new
                        item: moving one that exists re-encrypts it under another
                        key, which is what the move dialog is for. */}
                    {choosable.length > 0 ? (
                        <div className="grid grid-cols-2 gap-3">
                            <label className="flex flex-col gap-1 text-sm">
                                Vault
                                <Select
                                    value={draft.organizationId ?? ""}
                                    onValueChange={(value) =>
                                        patch({ organizationId: value || null })
                                    }
                                    aria-label="Vault"
                                    options={[
                                        { value: "", label: "My own vault" },
                                        ...choosable.map((vault) => ({
                                            value: vault.vaultId ?? "",
                                            label: vault.name
                                        }))
                                    ]}
                                />
                            </label>
                            {draft.organizationId ? (
                                <label className="flex flex-col gap-1 text-sm">
                                    Collection
                                    <Select
                                        value={collectionId}
                                        onValueChange={setCollectionId}
                                        aria-label="Collection"
                                        placeholder="No collections here yet"
                                        options={collections.map((collection) => ({
                                            value: collection.id,
                                            label: collection.name
                                        }))}
                                    />
                                </label>
                            ) : null}
                        </div>
                    ) : null}

                    {/* Revealed by the picker above rather than opening a second
                        dialog over this one: the item being written is still
                        half-typed behind it. */}
                    {newFolder !== null ? (
                        <div className="flex items-center gap-2">
                            <Input
                                ref={folderNameField}
                                value={newFolder}
                                onChange={(event) => setNewFolder(event.target.value)}
                                onKeyDown={(event) => {
                                    if (event.key === "Enter") {
                                        event.preventDefault();
                                        void createFolder();
                                    }
                                    if (event.key === "Escape") setNewFolder(null);
                                }}
                                placeholder="Name the folder"
                                aria-label="New folder name"
                            />
                            <Button
                                type="button"
                                size="sm"
                                disabled={pending || newFolder.trim().length === 0}
                                onClick={() => void createFolder()}
                            >
                                <FolderPlus className="size-4" />
                                Create
                            </Button>
                            <Button
                                type="button"
                                size="icon"
                                variant="ghost"
                                title="Cancel"
                                aria-label="Do not create a folder"
                                onClick={() => setNewFolder(null)}
                            >
                                <X className="size-4" />
                            </Button>
                        </div>
                    ) : null}

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
                                        patch({
                                            login: { ...draft.login, username: event.target.value }
                                        })
                                    }
                                    autoComplete="off"
                                />
                            </label>
                            <label className="flex flex-col gap-1 text-sm">
                                Password
                                <div className="flex items-center gap-2">
                                    {/* The Input carries its own show/hide eye. */}
                                    <div className="flex-1">
                                        <Input
                                            type="password"
                                            value={draft.login.password}
                                            onChange={(event) =>
                                                patch({
                                                    login: {
                                                        ...draft.login,
                                                        password: event.target.value
                                                    }
                                                })
                                            }
                                            autoComplete="off"
                                            className="font-mono"
                                        />
                                    </div>
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
                                            setGenerator(false);
                                        }}
                                    />
                                </div>
                            ) : null}
                            <div className="flex flex-col gap-1 text-sm">
                                <span>Authenticator key (optional)</span>
                                <div className="flex items-center gap-2">
                                    <Input
                                        className="flex-1 font-mono text-xs"
                                        value={draft.login.totp}
                                        onChange={(event) =>
                                            patch({
                                                login: { ...draft.login, totp: event.target.value }
                                            })
                                        }
                                        placeholder="The secret, or the whole otpauth:// link"
                                        autoComplete="off"
                                    />
                                    {/* The square a site shows is an otpauth://
                                        link, and the secret under it is
                                        thirty-two characters of base32 with no
                                        word breaks - which is why people
                                        screenshot it and then have nowhere to
                                        put the screenshot. */}
                                    <Button
                                        type="button"
                                        variant="outline"
                                        size="sm"
                                        onClick={() => setScanning(true)}
                                    >
                                        <QrCode className="size-4 shrink-0" />
                                        Scan
                                    </Button>
                                </div>
                                {draft.login.totp.trim() && !parseTotp(draft.login.totp) ? (
                                    // Said while it is being typed rather than
                                    // when the code fails to appear later: a key
                                    // that cannot be read is a two-factor login
                                    // somebody thinks they have saved.
                                    <span className="text-xs text-danger">
                                        That is not a key this can read. It should be an
                                        otpauth:// link, or the base32 secret on its own.
                                    </span>
                                ) : null}
                            </div>
                            {/* Several, because one login is rarely one URL: the
                                site, its accounts subdomain, and the app whose
                                callback is something else again. A vault that
                                held one is a vault where the same credential
                                gets saved three times. */}
                            <div className="flex flex-col gap-1 text-sm">
                                <span>Websites</span>
                                <div className="flex flex-col gap-2">
                                    {(draft.login.uris.length > 0
                                        ? draft.login.uris
                                        : [{ uri: "", match: null }]
                                    ).map((entry, index) => (
                                        <div key={index} className="flex flex-col gap-1">
                                            <div className="flex items-center gap-2">
                                                <Input
                                                    className="flex-1"
                                                    value={entry.uri}
                                                    onChange={(event) =>
                                                        patch({
                                                            login: {
                                                                ...draft.login,
                                                                uris: replaceUri(draft.login.uris, index, {
                                                                    ...entry,
                                                                    uri: event.target.value
                                                                })
                                                            }
                                                        })
                                                    }
                                                    placeholder="https://example.com or *.example.com"
                                                    autoComplete="off"
                                                />
                                                <Button
                                                    type="button"
                                                    size="icon-sm"
                                                    variant="ghost"
                                                    aria-label="Remove this website"
                                                    title="Remove this website"
                                                    disabled={draft.login.uris.length === 0}
                                                    onClick={() =>
                                                        patch({
                                                            login: {
                                                                ...draft.login,
                                                                uris: draft.login.uris.filter(
                                                                    (_, at) => at !== index
                                                                )
                                                            }
                                                        })
                                                    }
                                                >
                                                    <Trash2 className="size-4 shrink-0" />
                                                </Button>
                                            </div>
                                            {/* Said as it is typed rather than on
                                                save: an address that cannot
                                                match anything is a saved login
                                                that is silently never offered,
                                                and finding that out weeks later
                                                is finding it out at the worst
                                                moment. */}
                                            {core.uriProblem(entry.uri, entry.match) ? (
                                                <span className="text-xs text-danger">
                                                    {core.uriProblem(entry.uri, entry.match)}
                                                </span>
                                            ) : null}
                                            {/* The rule is only worth a line once
                                                there is an address for it to be
                                                about. */}
                                            {entry.uri.trim() ? (
                                                <Select
                                                    className="h-7 text-xs"
                                                    aria-label="When this login is offered here"
                                                    value={String(entry.match ?? core.DEFAULT_URI_MATCH)}
                                                    onValueChange={(next) =>
                                                        patch({
                                                            login: {
                                                                ...draft.login,
                                                                uris: replaceUri(draft.login.uris, index, {
                                                                    ...entry,
                                                                    match: core.readUriMatch(Number(next))
                                                                })
                                                            }
                                                        })
                                                    }
                                                    options={core.URI_MATCHES.map((match) => ({
                                                        value: String(match),
                                                        label: core.URI_MATCH_LABELS[match]
                                                    }))}
                                                />
                                            ) : null}
                                        </div>
                                    ))}
                                </div>
                                <Button
                                    type="button"
                                    size="sm"
                                    variant="ghost"
                                    className="self-start"
                                    onClick={() =>
                                        patch({
                                            login: {
                                                ...draft.login,
                                                uris: [...draft.login.uris, { uri: "", match: null }]
                                            }
                                        })
                                    }
                                >
                                    <Plus className="size-4 shrink-0" />
                                    Another website
                                </Button>
                            </div>
                        </>
                    ) : null}

                    {draft.type === core.CIPHER_CARD ? (
                        <>
                            <label className="flex flex-col gap-1 text-sm">
                                Name on the card
                                <Input
                                    value={draft.card.cardholderName}
                                    onChange={(event) =>
                                        patch({
                                            card: {
                                                ...draft.card,
                                                cardholderName: event.target.value
                                            }
                                        })
                                    }
                                />
                            </label>
                            <label className="flex flex-col gap-1 text-sm">
                                Number
                                <Input
                                    value={draft.card.number}
                                    onChange={(event) =>
                                        patch({
                                            card: { ...draft.card, number: event.target.value }
                                        })
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
                                            patch({
                                                card: {
                                                    ...draft.card,
                                                    expMonth: event.target.value
                                                }
                                            })
                                        }
                                        placeholder="MM"
                                    />
                                </label>
                                <label className="flex flex-col gap-1 text-sm">
                                    Year
                                    <Input
                                        value={draft.card.expYear}
                                        onChange={(event) =>
                                            patch({
                                                card: { ...draft.card, expYear: event.target.value }
                                            })
                                        }
                                        placeholder="YYYY"
                                    />
                                </label>
                                <label className="flex flex-col gap-1 text-sm">
                                    Security code
                                    <Input
                                        type="password"
                                        value={draft.card.code}
                                        onChange={(event) =>
                                            patch({
                                                card: { ...draft.card, code: event.target.value }
                                            })
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
                                        patch({
                                            sshKey: {
                                                ...draft.sshKey,
                                                privateKey: event.target.value
                                            }
                                        })
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
                                        patch({
                                            sshKey: {
                                                ...draft.sshKey,
                                                publicKey: event.target.value
                                            }
                                        })
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
                                                at === index
                                                    ? { ...entry, name: event.target.value }
                                                    : entry
                                            )
                                        })
                                    }
                                />
                                {/* A hidden field masks itself and carries the eye
                                    that shows it; the button beside it is the
                                    stored kind, not a second reveal. */}
                                <div className="flex-1">
                                    <Input
                                        value={field.value}
                                        placeholder="Value"
                                        type={
                                            field.type === core.FIELD_HIDDEN ? "password" : "text"
                                        }
                                        onChange={(event) =>
                                            patch({
                                                fields: draft.fields.map((entry, at) =>
                                                    at === index
                                                        ? { ...entry, value: event.target.value }
                                                        : entry
                                                )
                                            })
                                        }
                                    />
                                </div>
                                <Button
                                    type="button"
                                    size="icon"
                                    variant="ghost"
                                    title={
                                        field.type === core.FIELD_HIDDEN
                                            ? "Keep as plain text"
                                            : "Keep hidden"
                                    }
                                    aria-label="Toggle whether this field is stored hidden"
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
                                        <Lock className="size-4" />
                                    ) : (
                                        <LockOpen className="size-4" />
                                    )}
                                </Button>
                                <Button
                                    type="button"
                                    size="icon"
                                    variant="ghost"
                                    title="Remove this field"
                                    aria-label="Remove this field"
                                    onClick={() =>
                                        patch({
                                            fields: draft.fields.filter((_, at) => at !== index)
                                        })
                                    }
                                >
                                    <X className="size-4" />
                                </Button>
                            </div>
                        ))}
                    </div>
                </div>

                {error ? <p className="text-sm text-danger">{error}</p> : null}
                <DialogFooter>
                    <Button type="button" variant="secondary" onClick={onClose}>
                        Cancel
                    </Button>
                    <Button type="button" onClick={onSubmit} disabled={pending}>
                        {pending ? <Loader2 className="size-4 animate-spin" /> : null}
                        Save
                    </Button>
                </DialogFooter>
            </DialogContent>

            {/* On top of this one rather than inside it: a camera preview in a
                form that already scrolls is a camera nobody can aim. */}
            <QrScanDialog
                open={scanning}
                onOpenChange={setScanning}
                onFound={(value) => {
                    // Whatever the square said, as it said it. An otpauth link
                    // carries the issuer, the digits and the period as well as
                    // the secret, and throwing those away to keep the secret
                    // alone would break a site that uses eight digits.
                    patch({ login: { ...draft.login, totp: value.trim() } });
                }}
            />
        </Dialog>
    );
}
