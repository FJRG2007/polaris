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
import {
    AmexMark,
    DinersClubMark,
    DiscoverMark,
    JcbMark,
    MastercardMark,
    VisaMark
} from "@/components/brand-icons";
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
    cn,
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
/**
 * The identity, in the groups it is actually made of.
 *
 * Seventeen fields two abreast is a wall, and it puts "Address 2" beside
 * "Passport number" as though they were the same kind of question. These are
 * four questions - who they are, how to reach them, where they live, and the
 * numbers a government gave them - and the address gets the shape an address
 * has rather than a share of the grid.
 */
const IDENTITY_GROUPS: readonly {
    title: string;
    fields: readonly { field: (typeof IDENTITY_FIELDS)[number]; span?: "full" }[];
}[] = [
    {
        title: "Name",
        fields: [
            { field: "title" },
            { field: "firstName" },
            { field: "middleName" },
            { field: "lastName" },
            { field: "company", span: "full" }
        ]
    },
    {
        title: "Getting hold of them",
        fields: [{ field: "email" }, { field: "phone" }, { field: "username" }]
    },
    {
        title: "Address",
        fields: [
            { field: "address1", span: "full" },
            { field: "address2", span: "full" },
            { field: "city" },
            { field: "state" },
            { field: "postalCode" },
            { field: "country" }
        ]
    },
    {
        title: "Numbers they were given",
        fields: [{ field: "ssn" }, { field: "passportNumber" }, { field: "licenseNumber" }]
    }
];

/** Where the derived label reads badly. `Address 1` is what the field is called
 *  and not what anybody would write on an envelope. */
const IDENTITY_LABELS: Partial<Record<(typeof IDENTITY_FIELDS)[number], string>> = {
    address1: "Street",
    address2: "Flat, suite, building",
    state: "County or state",
    postalCode: "Postcode",
    ssn: "National insurance or social security number",
    licenseNumber: "Driving licence number",
    username: "Username on file"
};

/** A hint only where the field's own name does not say what goes in it. */
const IDENTITY_HINTS: Partial<Record<(typeof IDENTITY_FIELDS)[number], string>> = {
    title: "Mr, Ms, Dr",
    address2: "Optional"
};

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
    /**
     * The expiry as one box, because a card prints one.
     *
     * Its own state beside the two stored fields rather than derived from them:
     * somebody typing `0` has typed something that is not yet a month, and a box
     * that rewrote itself from a half-parsed value on every keystroke would take
     * the caret with it.
     */
    const [expiry, setExpiry] = useState("");
    /** Who issued the card. The cipher model has the network and nothing for the
     *  bank, so it lives in a custom field - see `BANK_FIELD`. */
    const [bank, setBank] = useState("");
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
        setScanning(false);
        setNewFolder(null);
        setError(null);
        // The one-box expiry and the bank are drawn from what was stored: two
        // fields the cipher model has, and one custom field it does not.
        setExpiry(
            item.card.expMonth || item.card.expYear
                ? core.writeCardExpiry({ month: item.card.expMonth, year: item.card.expYear })
                : ""
        );
        setBank(core.fieldValue(item.fields, core.BANK_FIELD));
    }, [item]);

    /**
     * What to say about the expiry, or nothing.
     *
     * A card that has already expired is worth saying loudly; one that goes in a
     * month or two is worth mentioning before the day it stops working rather
     * than after, which is when somebody finds out otherwise.
     */
    const expiryNote = (() => {
        if (!draft.card.expMonth || !draft.card.expYear) {
            return expiry.trim() && !core.readCardExpiry(expiry)
                ? { tone: "danger" as const, text: "That is not a month and a year." }
                : null;
        }
        const stored = { month: draft.card.expMonth, year: draft.card.expYear };
        const now = new Date();
        if (core.cardExpired(stored, now)) {
            return { tone: "danger" as const, text: "This card has expired." };
        }
        if (core.cardExpiringSoon(stored, now)) {
            return { tone: "warning" as const, text: "This card expires soon." };
        }
        return null;
    })();

    /** The network's own mark, when there is one for it. UnionPay and Maestro
     *  have no official mark in the set Polaris ships, so they are named rather
     *  than drawn - see `brand-icons`. */
    const cardMark = (() => {
        const size = "size-6 text-muted-foreground";
        switch (core.cardBrand(draft.card.number)) {
            case "Visa":
                return <VisaMark className={size} />;
            case "Mastercard":
                return <MastercardMark className={size} />;
            case "Amex":
                return <AmexMark className={size} />;
            case "Discover":
                return <DiscoverMark className={size} />;
            case "JCB":
                return <JcbMark className={size} />;
            case "Diners Club":
                return <DinersClubMark className={size} />;
            default:
                return null;
        }
    })();

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
        // The conventions that live in custom fields are folded in here rather
        // than kept in the draft as it is edited: they are one value each, and
        // the field list is what actually gets stored.
        const saving: VaultItem = {
            ...draft,
            fields:
                draft.type === core.CIPHER_CARD
                    ? core.withField(draft.fields, core.BANK_FIELD, bank, core.FIELD_TEXT)
                    : draft.fields
        };
        const failure = await onSave(saving, intoVault ? [collectionId] : []);
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
                            <div className="flex flex-col gap-1 text-sm">
                                <span>Number</span>
                                <div className="relative">
                                    <Input
                                        value={draft.card.number}
                                        onChange={(event) =>
                                            patch({
                                                card: {
                                                    ...draft.card,
                                                    number: event.target.value,
                                                    // The brand is read from the
                                                    // digits rather than asked
                                                    // for: it is on the card, and
                                                    // a field somebody has to
                                                    // fill in themselves is a
                                                    // field that ends up wrong.
                                                    brand: core.cardBrand(event.target.value) ?? ""
                                                }
                                            })
                                        }
                                        className="pr-12 font-mono"
                                        autoComplete="off"
                                        placeholder="4111 1111 1111 1111"
                                    />
                                    {cardMark ? (
                                        <span className="pointer-events-none absolute inset-y-0 right-2 flex items-center">
                                            {cardMark}
                                        </span>
                                    ) : null}
                                </div>
                                {core.cardNumberProblem(draft.card.number) ? (
                                    // Said once the number is long enough to be
                                    // judged, never at the fourth digit: a card
                                    // number is wrong for most of the time it is
                                    // being typed.
                                    <span className="text-xs text-danger">
                                        {core.cardNumberProblem(draft.card.number)}
                                    </span>
                                ) : draft.card.brand ? (
                                    <span className="text-xs text-muted-foreground">
                                        {draft.card.brand}
                                    </span>
                                ) : null}
                            </div>
                            <div className="grid grid-cols-2 gap-3">
                                <div className="flex flex-col gap-1 text-sm">
                                    {/* One box, because a card prints one. People
                                        type 0830, 08/30 or 08 / 2030 and all of
                                        them mean the same August. */}
                                    <span>Expires</span>
                                    <Input
                                        value={expiry}
                                        onChange={(event) => {
                                            setExpiry(event.target.value);
                                            const read = core.readCardExpiry(event.target.value);
                                            patch({
                                                card: {
                                                    ...draft.card,
                                                    expMonth: read?.month ?? "",
                                                    expYear: read?.year ?? ""
                                                }
                                            });
                                        }}
                                        placeholder="MM/YY"
                                        inputMode="numeric"
                                        autoComplete="off"
                                    />
                                    {expiryNote ? (
                                        <span
                                            className={
                                                expiryNote.tone === "danger"
                                                    ? "text-xs text-danger"
                                                    : "text-xs text-warning"
                                            }
                                        >
                                            {expiryNote.text}
                                        </span>
                                    ) : null}
                                </div>
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
                            <label className="flex flex-col gap-1 text-sm">
                                {/* Optional, and worth having: two cards from the
                                    same network look identical in a list, and
                                    the bank is what tells them apart. */}
                                Bank (optional)
                                <Input
                                    value={bank}
                                    onChange={(event) => setBank(event.target.value)}
                                    placeholder="Who issued it"
                                    autoComplete="off"
                                />
                            </label>
                        </>
                    ) : null}

                    {draft.type === core.CIPHER_IDENTITY ? (
                        // Grouped and laid out rather than seventeen boxes two
                        // abreast. An identity is three different things - who
                        // somebody is, how to reach them, where they live, and
                        // the numbers governments gave them - and a flat grid
                        // put "Address 2" beside "Passport number" as if they
                        // were the same kind of answer. The address itself gets
                        // the shape an address has: the street lines full width,
                        // the town, county and postcode on one row.
                        <div className="flex flex-col gap-4">
                            {IDENTITY_GROUPS.map((group) => (
                                <fieldset key={group.title} className="flex flex-col gap-2">
                                    <legend className="text-xs font-medium text-muted-foreground">
                                        {group.title}
                                    </legend>
                                    <div className="grid grid-cols-2 gap-3">
                                        {group.fields.map(({ field, span }) => (
                                            <label
                                                key={field}
                                                className={cn(
                                                    "flex flex-col gap-1 text-sm",
                                                    span === "full" && "col-span-2"
                                                )}
                                            >
                                                {IDENTITY_LABELS[field] ?? humanize(field)}
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
                                                    placeholder={IDENTITY_HINTS[field]}
                                                    autoComplete="off"
                                                />
                                            </label>
                                        ))}
                                    </div>
                                </fieldset>
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
