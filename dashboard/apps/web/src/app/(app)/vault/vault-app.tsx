"use client";

/**
 * The vault, once it is open.
 *
 * The key lives in this component's state and nowhere else - not in
 * localStorage, not in a cookie, not on the server. Reloading the page locks it
 * again, which is the correct trade for something that decrypts every password
 * somebody owns, and it is why the lock button below is a state change rather
 * than a request.
 *
 * Everything arrives encrypted and is opened here, once, on unlock. Search and
 * filtering then work on the open objects, which is what makes typing in the
 * search box feel like a list rather than a query.
 */

import Link from "next/link";
import * as core from "@polaris/core";
import { TotpCode } from "./totp-code";
import { ItemDialog } from "./item-dialog";
import { VaultSetup } from "./vault-setup";
import { VaultUnlock } from "./vault-unlock";
import { useEffect, useMemo, useState } from "react";
import type { SymmetricKey } from "@/lib/vault/crypto";
import { useConfirm } from "@/components/confirm-dialog";
import { Badge, Button, Card, CardBody, Input, Select } from "@polaris/ui";
import { decryptFolders, decryptItem, emptyItem, encryptItem, type VaultFolder, type VaultItem } from "./vault-model";
import {
    deleteItemAction,
    restoreItemAction,
    saveItemAction,
    setItemFavoriteAction,
    vaultContentsAction,
    type VaultState
} from "./vault-actions";
import {
    Check,
    Copy,
    CreditCard,
    Eye,
    EyeOff,
    FileText,
    Contact,
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

export function VaultApp({ state, name }: { state: VaultState; name: string }) {
    const [key, setKey] = useState<SymmetricKey | null>(null);
    const [items, setItems] = useState<VaultItem[]>([]);
    const [folders, setFolders] = useState<VaultFolder[]>([]);
    const [loading, setLoading] = useState(false);
    const [query, setQuery] = useState("");
    const [filter, setFilter] = useState<Filter>("all");
    const [selected, setSelected] = useState<string | null>(null);
    const [editing, setEditing] = useState<VaultItem | null>(null);
    const [revealed, setRevealed] = useState(false);
    const [copied, setCopied] = useState<string | null>(null);
    const [confirm, confirmDialog] = useConfirm();

    /** Pull everything and open it. Runs on unlock and after every write. */
    async function load(withKey: SymmetricKey): Promise<void> {
        setLoading(true);
        const contents = await vaultContentsAction();
        const opened: VaultItem[] = [];
        for (const raw of contents.ciphers) opened.push(await decryptItem(raw, withKey));
        setItems(opened.sort((left, right) => left.name.localeCompare(right.name)));
        setFolders(await decryptFolders(contents.folders, withKey));
        setLoading(false);
    }

    useEffect(() => {
        if (key) void load(key);
        // Only when the key changes: a reload on every render would re-derive and
        // re-decrypt the whole vault for nothing.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [key]);

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

    async function copy(label: string, value: string): Promise<void> {
        await navigator.clipboard.writeText(value);
        setCopied(label);
        window.setTimeout(() => setCopied(null), 2000);
    }

    async function onSave(item: VaultItem): Promise<string | null> {
        if (!key) return "Your vault is locked.";
        const body = await encryptItem(item, key);
        const result = await saveItemAction(item.id || null, body);
        if (result.error) return result.error;
        await load(key);
        return null;
    }

    async function onDelete(item: VaultItem): Promise<void> {
        const permanent = item.deleted;
        const confirmed = await confirm({
            title: permanent ? `Delete "${item.name}" for good?` : `Move "${item.name}" to the trash?`,
            description: permanent
                ? "This cannot be undone."
                : "You can put it back from the trash.",
            confirmLabel: permanent ? "Delete" : "Move to trash",
            danger: true
        });
        if (!confirmed || !key) return;
        await deleteItemAction(item.id, !permanent);
        setSelected(null);
        await load(key);
    }

    if (!state.exists) {
        return <VaultSetup email={state.email} name={name} onCreated={setKey} />;
    }
    if (!key) {
        return (
            <VaultUnlock
                email={state.email}
                kdf={state.kdf}
                protectedKey={state.protectedKey ?? ""}
                onUnlocked={setKey}
            />
        );
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
                            setKey(null);
                            setItems([]);
                            setSelected(null);
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
                                                {core.CIPHER_TYPE_LABEL[current.type as core.CipherType]}
                                            </p>
                                        </div>
                                        <div className="flex items-center gap-1">
                                            {current.deleted ? (
                                                <Badge variant="neutral">In the trash</Badge>
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
                                            {current.deleted ? (
                                                <Button
                                                    size="sm"
                                                    variant="ghost"
                                                    title="Put it back"
                                                    aria-label={`Restore ${current.name}`}
                                                    onClick={async () => {
                                                        await restoreItemAction(current.id);
                                                        if (key) await load(key);
                                                    }}
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
                                                onCopy={() => copy("username", current.login.username)}
                                            />
                                            <Field
                                                label="Password"
                                                value={current.login.password}
                                                secret={!revealed}
                                                copied={copied === "password"}
                                                onCopy={() => copy("password", current.login.password)}
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
                                            <Field label="Name" value={current.card.cardholderName} />
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
                                                onCopy={() => copy("public", current.sshKey.publicKey)}
                                            />
                                            <Field
                                                label="Private key"
                                                value={current.sshKey.privateKey}
                                                secret={!revealed}
                                                revealed={revealed}
                                                copied={copied === "private"}
                                                onCopy={() => copy("private", current.sshKey.privateKey)}
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
                                            <span className="text-xs text-muted-foreground">Notes</span>
                                            <p className="whitespace-pre-wrap text-sm">{current.notes}</p>
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
            />
            {confirmDialog}
        </div>
    );
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
    return (
        <div className="flex items-center gap-2">
            <div className="min-w-0 flex-1">
                <span className="text-xs capitalize text-muted-foreground">{label}</span>
                {link ? (
                    <a
                        href={value}
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
                    <p
                        className="truncate font-mono text-sm"
                        title={secret ? undefined : value}
                    >
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
                    {copied ? <Check className="size-4 text-success" /> : <Copy className="size-4" />}
                </Button>
            ) : null}
        </div>
    );
}
