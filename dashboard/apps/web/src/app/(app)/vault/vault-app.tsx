"use client";

/**
 * The vault, once it is open.
 *
 * The key is held by the vault session above this screen, never on the server -
 * see `vault-session.tsx` for where a browser is allowed to keep it and for how
 * long. This screen only ever reads it, which is why the lock button here is a
 * call into that session rather than a request.
 *
 * Everything arrives encrypted and is opened here, once, on unlock. Search and
 * filtering then work on the open objects, which is what makes typing in the
 * search box feel like a list rather than a query.
 */

import Link from "next/link";
import * as core from "@polaris/core";
import { TotpCode } from "./totp-code";
import { ItemDialog } from "./item-dialog";
import { ShareDialog } from "./share-dialog";
import { FolderDialog } from "./folder-dialog";
import { useVaultSession } from "./vault-session";
import * as vaultCrypto from "@/lib/vault/crypto";
import { useEffect, useMemo, useState } from "react";
import type { SymmetricKey } from "@/lib/vault/crypto";
import { useConfirm } from "@/components/confirm-dialog";
import { Badge, Button, Card, CardBody, Input, Select } from "@polaris/ui";
import {
    decryptFolders,
    decryptItem,
    emptyItem,
    encryptItem,
    type VaultFolder,
    type VaultItem
} from "./vault-model";
import {
    deleteItemAction,
    restoreItemAction,
    saveFolderAction,
    saveItemAction,
    setItemFavoriteAction,
    vaultContentsAction
} from "./vault-actions";
import {
    Check,
    Copy,
    CreditCard,
    Eye,
    EyeOff,
    FileText,
    FolderCog,
    Contact,
    Share2,
    Building2,
    KeyRound,
    Loader2,
    Lock,
    Plus,
    RotateCcw,
    Search,
    Star,
    Terminal,
    Trash2
} from "lucide-react";

/** The icon each kind of item is drawn with. */
const TYPE_ICON: Record<number, typeof KeyRound> = {
    [core.CIPHER_LOGIN]: KeyRound,
    [core.CIPHER_SECURE_NOTE]: FileText,
    [core.CIPHER_CARD]: CreditCard,
    [core.CIPHER_IDENTITY]: Contact,
    [core.CIPHER_SSH_KEY]: Terminal
};

/** What the list can be narrowed to. */
type Filter = "all" | "favorites" | "trash" | `type:${number}` | `folder:${string}`;

export function VaultApp() {
    const { key, lock, keyFor, orgKeys, organizations } = useVaultSession();
    const [items, setItems] = useState<VaultItem[]>([]);
    const [folders, setFolders] = useState<VaultFolder[]>([]);
    const [loading, setLoading] = useState(false);
    const [query, setQuery] = useState("");
    const [filter, setFilter] = useState<Filter>("all");
    const [selected, setSelected] = useState<string | null>(null);
    const [editing, setEditing] = useState<VaultItem | null>(null);
    const [managingFolders, setManagingFolders] = useState(false);
    const [sharing, setSharing] = useState<VaultItem | null>(null);
    const [revealed, setRevealed] = useState(false);
    const [copied, setCopied] = useState<string | null>(null);
    const [confirm, confirmDialog] = useConfirm();

    /**
     * Pull everything and open it. Runs on unlock and after every write.
     *
     * Each item is opened with the key of whoever owns it - this account's, or
     * an organization's. An item whose key this account does not hold is skipped
     * rather than shown as a row of empty fields: being on a roster is not the
     * same as having been vouched for, and a half-drawn item would suggest it is.
     */
    async function load(withKey: SymmetricKey): Promise<void> {
        setLoading(true);
        const contents = await vaultContentsAction();
        const opened: VaultItem[] = [];
        for (const raw of contents.ciphers) {
            const owner = typeof raw.organizationId === "string" ? raw.organizationId : null;
            const itemKey = owner ? (orgKeys.get(owner) ?? null) : withKey;
            if (!itemKey) continue;
            opened.push(await decryptItem(raw, itemKey));
        }
        setItems(opened.sort((left, right) => left.name.localeCompare(right.name)));
        setFolders(await decryptFolders(contents.folders, withKey));
        setLoading(false);
    }

    useEffect(() => {
        if (key) void load(key);
        // The organization keys arrive a beat after the vault key, so this runs
        // again when they do. Not on every render: that would re-decrypt the
        // whole vault for nothing.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [key, orgKeys]);

    const visible = useMemo(() => {
        const needle = query.trim().toLowerCase();
        return items.filter((item) => {
            if (filter === "trash" ? !item.deleted : item.deleted) return false;
            if (filter === "favorites" && !item.favorite) return false;
            if (filter.startsWith("type:") && item.type !== Number(filter.slice(5))) return false;
            if (filter.startsWith("folder:") && item.folderId !== filter.slice(7)) return false;
            if (!needle) return true;
            return [item.name, item.login.username, item.login.uris.join(" "), item.notes]
                .join(" ")
                .toLowerCase()
                .includes(needle);
        });
    }, [items, query, filter]);

    const current = visible.find((item) => item.id === selected) ?? null;

    /** Whose shared vault an item belongs to, by the id the item carries. */
    function ownerName(vaultOrgId: string): string {
        return (
            organizations.find((org) => org.vaultOrgId === vaultOrgId)?.name ?? "Shared"
        );
    }

    async function copy(label: string, value: string): Promise<void> {
        await navigator.clipboard.writeText(value);
        setCopied(label);
        window.setTimeout(() => setCopied(null), 2000);
    }

    async function onSave(item: VaultItem): Promise<string | null> {
        if (!key) return "Your vault is locked.";
        // A shared item is written back under its organization's key, never the
        // personal one - saving it under the wrong key would leave the other
        // members with an item none of them can open.
        const itemKey = keyFor(item.organizationId);
        if (!itemKey) return "You do not hold the key for that organization.";
        const body = await encryptItem(item, itemKey);
        const result = await saveItemAction(item.id || null, body);
        if (result.error) return result.error;
        await load(key);
        return null;
    }

    /**
     * Make a folder from inside the item form, and hand back its id so the item
     * lands in it. Filing something is when somebody discovers they want a
     * folder, and sending them to another screen to make one loses the item
     * they were half-way through writing.
     */
    async function onCreateFolder(name: string): Promise<string | null> {
        if (!key) return null;
        const result = await saveFolderAction(null, await vaultCrypto.encrypt(name.trim(), key));
        const id = typeof result.folder?.id === "string" ? result.folder.id : null;
        if (id) await load(key);
        return id;
    }

    async function onDelete(item: VaultItem): Promise<void> {
        const permanent = item.deleted;
        const confirmed = await confirm({
            title: permanent
                ? `Delete "${item.name}" for good?`
                : `Move "${item.name}" to the trash?`,
            description: permanent
                ? "This cannot be undone."
                : "You can put it back from the trash.",
            confirmLabel: permanent ? "Delete" : "Move to trash",
            danger: true
        });
        if (!confirmed || !key) return;
        // A refusal here is real - an organization item in a read-only collection
        // is one - and dropping it made the item come back on the next load with
        // nothing said about why.
        const result = await deleteItemAction(item.id, !permanent);
        if (result.error) {
            await confirm({
                title: permanent ? "Could not delete it" : "Could not move it to the trash",
                description: result.error,
                alert: true
            });
            return;
        }
        setSelected(null);
        await load(key);
    }

    async function onRestore(item: VaultItem): Promise<void> {
        if (!key) return;
        const result = await restoreItemAction(item.id);
        if (result.error) {
            await confirm({
                title: "Could not put it back",
                description: result.error,
                alert: true
            });
            return;
        }
        await load(key);
    }

    return (
        <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                    <h1 className="text-lg font-semibold">Vault</h1>
                    <p className="text-sm text-muted-foreground">
                        {items.filter((item) => !item.deleted).length} items, open in this tab only.
                    </p>
                </div>
                <div className="flex items-center gap-2">
                    <Button asChild size="sm" variant="ghost">
                        <Link href="/vault/clients">Connect an app</Link>
                    </Button>
                    <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => {
                            setItems([]);
                            setSelected(null);
                            lock();
                        }}
                    >
                        <Lock className="size-4" />
                        Lock
                    </Button>
                    <Button size="sm" onClick={() => setEditing(emptyItem(core.CIPHER_LOGIN))}>
                        <Plus className="size-4" />
                        New item
                    </Button>
                </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
                <div className="relative min-w-0 flex-1">
                    <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                        placeholder="Search your vault"
                        className="pl-9"
                    />
                </div>
                <Select
                    value={filter}
                    onValueChange={(value) => setFilter(value as Filter)}
                    aria-label="Show"
                    className="max-w-[14rem]"
                    options={[
                        { value: "all", label: "Everything" },
                        { value: "favorites", label: "Favorites" },
                        ...core.CIPHER_TYPES.map((type) => ({
                            value: `type:${type}`,
                            label: core.CIPHER_TYPE_LABEL[type]
                        })),
                        ...folders.map((folder) => ({
                            value: `folder:${folder.id}`,
                            label: folder.name || "Untitled folder"
                        })),
                        { value: "trash", label: "Trash" }
                    ]}
                />
                <Button
                    size="icon"
                    variant="secondary"
                    title="Folders"
                    aria-label="Manage folders"
                    onClick={() => setManagingFolders(true)}
                >
                    <FolderCog className="size-4" />
                </Button>
            </div>

            {loading ? (
                <Card>
                    <CardBody className="flex items-center justify-center gap-2 p-8 text-sm text-muted-foreground">
                        <Loader2 className="size-4 animate-spin" />
                        Opening your vault...
                    </CardBody>
                </Card>
            ) : visible.length === 0 ? (
                <Card>
                    <CardBody className="p-8 text-center text-sm text-muted-foreground">
                        {items.length === 0
                            ? "Nothing in here yet. Add a login, a note, a card or a key."
                            : "Nothing matches that."}
                    </CardBody>
                </Card>
            ) : (
                <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
                    <div className="flex flex-col gap-1">
                        {visible.map((item) => {
                            const Icon = TYPE_ICON[item.type] ?? KeyRound;
                            return (
                                <button
                                    key={item.id}
                                    type="button"
                                    onClick={() => {
                                        setSelected(item.id);
                                        setRevealed(false);
                                    }}
                                    className={`flex items-center gap-3 rounded-md border p-3 text-left transition-colors ${
                                        item.id === selected
                                            ? "border-primary/40 bg-primary/5"
                                            : "border-transparent hover:bg-card-hover"
                                    }`}
                                >
                                    <Icon className="size-4 shrink-0 text-muted-foreground" />
                                    <div className="min-w-0 flex-1">
                                        <p className="truncate text-sm font-medium">
                                            {item.name || "Untitled"}
                                        </p>
                                        <p className="truncate text-xs text-muted-foreground">
                                            {item.login.username ||
                                                core.CIPHER_TYPE_LABEL[
                                                    item.type as core.CipherType
                                                ]}
                                        </p>
                                    </div>
                                    {item.favorite ? (
                                        <Star className="size-3 shrink-0 fill-amber-400 text-amber-400" />
                                    ) : null}
                                </button>
                            );
                        })}
                    </div>

                    <div>
                        {current ? (
                            <Card>
                                <CardBody className="flex flex-col gap-3">
                                    <div className="flex flex-wrap items-start justify-between gap-2">
                                        <div className="min-w-0">
                                            <h2 className="truncate text-sm font-medium">
                                                {current.name || "Untitled"}
                                            </h2>
                                            <p className="text-xs text-muted-foreground">
                                                {
                                                    core.CIPHER_TYPE_LABEL[
                                                        current.type as core.CipherType
                                                    ]
                                                }
                                            </p>
                                        </div>
                                        <div className="flex items-center gap-1">
                                            {current.deleted ? (
                                                <Badge variant="neutral">In the trash</Badge>
                                            ) : null}
                                            {current.organizationId ? (
                                                <Badge variant="neutral">
                                                    <Building2 className="size-3" />
                                                    {ownerName(current.organizationId)}
                                                </Badge>
                                            ) : null}
                                            <Button
                                                size="sm"
                                                variant="ghost"
                                                title={current.favorite ? "Unstar" : "Star"}
                                                aria-label={
                                                    current.favorite
                                                        ? `Unstar ${current.name}`
                                                        : `Star ${current.name}`
                                                }
                                                onClick={async () => {
                                                    await setItemFavoriteAction(
                                                        current.id,
                                                        !current.favorite
                                                    );
                                                    if (key) await load(key);
                                                }}
                                            >
                                                <Star
                                                    className={`size-4 ${current.favorite ? "fill-amber-400 text-amber-400" : ""}`}
                                                />
                                            </Button>
                                            {/* Only a personal item, and only
                                                when there is a shared vault to
                                                put it in: sharing is one-way, so
                                                offering it where it cannot work
                                                is worse than not offering it. */}
                                            {!current.deleted &&
                                            !current.organizationId &&
                                            orgKeys.size > 0 ? (
                                                <Button
                                                    size="sm"
                                                    variant="ghost"
                                                    title="Share with an organization"
                                                    aria-label={`Share ${current.name}`}
                                                    onClick={() => setSharing(current)}
                                                >
                                                    <Share2 className="size-4" />
                                                </Button>
                                            ) : null}
                                            {current.deleted ? (
                                                <Button
                                                    size="sm"
                                                    variant="ghost"
                                                    title="Put it back"
                                                    aria-label={`Restore ${current.name}`}
                                                    onClick={() => onRestore(current)}
                                                >
                                                    <RotateCcw className="size-4" />
                                                </Button>
                                            ) : (
                                                <Button
                                                    size="sm"
                                                    variant="ghost"
                                                    onClick={() => setEditing(current)}
                                                >
                                                    Edit
                                                </Button>
                                            )}
                                            <Button
                                                size="sm"
                                                variant="ghost"
                                                title="Delete"
                                                aria-label={`Delete ${current.name}`}
                                                onClick={() => onDelete(current)}
                                            >
                                                <Trash2 className="size-4" />
                                            </Button>
                                        </div>
                                    </div>

                                    {current.type === core.CIPHER_LOGIN ? (
                                        <>
                                            <Field
                                                label="Username"
                                                value={current.login.username}
                                                copied={copied === "username"}
                                                onCopy={() =>
                                                    copy("username", current.login.username)
                                                }
                                            />
                                            <Field
                                                label="Password"
                                                value={current.login.password}
                                                secret={!revealed}
                                                copied={copied === "password"}
                                                onCopy={() =>
                                                    copy("password", current.login.password)
                                                }
                                                onReveal={() => setRevealed((prev) => !prev)}
                                                revealed={revealed}
                                            />
                                            {current.login.totp ? (
                                                <TotpCode value={current.login.totp} />
                                            ) : null}
                                            {current.login.uris.map((uri) => (
                                                <Field key={uri} label="Website" value={uri} link />
                                            ))}
                                        </>
                                    ) : null}

                                    {current.type === core.CIPHER_CARD ? (
                                        <>
                                            <Field
                                                label="Name"
                                                value={current.card.cardholderName}
                                            />
                                            <Field
                                                label="Number"
                                                value={current.card.number}
                                                secret={!revealed}
                                                revealed={revealed}
                                                copied={copied === "number"}
                                                onCopy={() => copy("number", current.card.number)}
                                                onReveal={() => setRevealed((prev) => !prev)}
                                            />
                                            <Field
                                                label="Expires"
                                                value={`${current.card.expMonth}/${current.card.expYear}`}
                                            />
                                            <Field
                                                label="Security code"
                                                value={current.card.code}
                                                secret={!revealed}
                                                revealed={revealed}
                                                onReveal={() => setRevealed((prev) => !prev)}
                                            />
                                        </>
                                    ) : null}

                                    {current.type === core.CIPHER_IDENTITY
                                        ? Object.entries(current.identity)
                                              .filter(([, value]) => value)
                                              .map(([field, value]) => (
                                                  <Field key={field} label={field} value={value} />
                                              ))
                                        : null}

                                    {current.type === core.CIPHER_SSH_KEY ? (
                                        <>
                                            <Field
                                                label="Public key"
                                                value={current.sshKey.publicKey}
                                                copied={copied === "public"}
                                                onCopy={() =>
                                                    copy("public", current.sshKey.publicKey)
                                                }
                                            />
                                            <Field
                                                label="Private key"
                                                value={current.sshKey.privateKey}
                                                secret={!revealed}
                                                revealed={revealed}
                                                copied={copied === "private"}
                                                onCopy={() =>
                                                    copy("private", current.sshKey.privateKey)
                                                }
                                                onReveal={() => setRevealed((prev) => !prev)}
                                            />
                                        </>
                                    ) : null}

                                    {current.fields.map((field, index) => (
                                        <Field
                                            key={index}
                                            label={field.name}
                                            value={field.value}
                                            secret={field.type === core.FIELD_HIDDEN && !revealed}
                                            revealed={revealed}
                                            copied={copied === `field-${index}`}
                                            onCopy={() => copy(`field-${index}`, field.value)}
                                            onReveal={
                                                field.type === core.FIELD_HIDDEN
                                                    ? () => setRevealed((prev) => !prev)
                                                    : undefined
                                            }
                                        />
                                    ))}

                                    {current.notes ? (
                                        <div className="flex flex-col gap-1">
                                            <span className="text-xs text-muted-foreground">
                                                Notes
                                            </span>
                                            <p className="whitespace-pre-wrap text-sm">
                                                {current.notes}
                                            </p>
                                        </div>
                                    ) : null}
                                </CardBody>
                            </Card>
                        ) : (
                            <Card>
                                <CardBody className="p-8 text-center text-sm text-muted-foreground">
                                    Pick something on the left to see it.
                                </CardBody>
                            </Card>
                        )}
                    </div>
                </div>
            )}

            <ItemDialog
                item={editing}
                folders={folders}
                onClose={() => setEditing(null)}
                onSave={onSave}
                onCreateFolder={onCreateFolder}
            />
            {key ? (
                <FolderDialog
                    open={managingFolders}
                    folders={folders}
                    vaultKey={key}
                    onClose={() => setManagingFolders(false)}
                    onChanged={() => load(key)}
                />
            ) : null}
            <ShareDialog
                item={sharing}
                onClose={() => setSharing(null)}
                onShared={() => (key ? load(key) : Promise.resolve())}
            />
            {confirmDialog}
        </div>
    );
}

/**
 * A website field turned into something safe to put in an `href`, or null.
 *
 * The value decrypted a moment ago on the one screen that holds the vault key in
 * memory, and it did not have to be written here: an item can arrive from an
 * organization or from an imported CSV. A `javascript:` URI in that href would
 * run against exactly that page, so only ordinary web navigation is linked and
 * everything else falls back to being read as text.
 *
 * A bare host is completed rather than refused - `example.com` in a saved login
 * means the site, not a path relative to the dashboard.
 */
function webLink(value: string): string | null {
    try {
        const url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(value) ? value : `https://${value}`);
        return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
    } catch {
        return null;
    }
}

/** One labelled value, with the affordances that value deserves. */
function Field({
    label,
    value,
    secret = false,
    revealed = false,
    link = false,
    copied = false,
    onCopy,
    onReveal
}: {
    label: string;
    value: string;
    secret?: boolean;
    revealed?: boolean;
    link?: boolean;
    copied?: boolean;
    onCopy?: () => void;
    onReveal?: () => void;
}) {
    if (!value) return null;
    const href = link ? webLink(value) : null;
    return (
        <div className="flex items-center gap-2">
            <div className="min-w-0 flex-1">
                <span className="text-xs capitalize text-muted-foreground">{label}</span>
                {href ? (
                    <a
                        href={href}
                        target="_blank"
                        rel="noreferrer noopener"
                        title={value}
                        className="block truncate text-sm text-primary hover:underline"
                    >
                        {value}
                    </a>
                ) : (
                    /* A hidden value has nothing to reveal on hover; a shown one is
                       often a long key or a note, and clipping it with no way back
                       to the whole thing is the defect this guards against. */
                    <p className="truncate font-mono text-sm" title={secret ? undefined : value}>
                        {secret ? "••••••••••••" : value}
                    </p>
                )}
            </div>
            {onReveal ? (
                <Button
                    size="icon"
                    variant="ghost"
                    title={revealed ? "Hide" : "Show"}
                    aria-label={revealed ? `Hide the ${label}` : `Show the ${label}`}
                    onClick={onReveal}
                >
                    {revealed ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                </Button>
            ) : null}
            {onCopy ? (
                <Button
                    size="icon"
                    variant="ghost"
                    title="Copy"
                    aria-label={`Copy the ${label}`}
                    onClick={onCopy}
                >
                    {copied ? (
                        <Check className="size-4 text-success" />
                    ) : (
                        <Copy className="size-4" />
                    )}
                </Button>
            ) : null}
        </div>
    );
}
