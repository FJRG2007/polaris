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
import { ItemIcon } from "./item-icon";
import { RecoveryCodes } from "./recovery-codes";
import { PasswordState } from "@/components/password-state";
import { totpCode } from "@/lib/vault/totp-browser";
import { ItemDialog } from "./item-dialog";
import { MoveDialog } from "./move-dialog";
import { FolderDialog } from "./folder-dialog";
import { useVaultSession } from "./vault-session";
import { addressLines, IDENTITY_GROUPS, identityLabel } from "./identity-fields";
import * as vaultCrypto from "@/lib/vault/crypto";
import {
    AmexMark,
    DinersClubMark,
    DiscoverMark,
    JcbMark,
    MastercardMark,
    VisaMark
} from "@/components/brand-icons";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { SymmetricKey } from "@/lib/vault/crypto";
import { useConfirm } from "@/components/confirm-dialog";
import {
    Badge,
    Button,
    Card,
    CardBody,
    ContextMenu,
    ContextMenuContent,
    ContextMenuItem,
    ContextMenuLabel,
    ContextMenuSeparator,
    ContextMenuTrigger,
    Input,
    MenuShortcut,
    Select
} from "@polaris/ui";
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
    ExternalLink,
    Eye,
    EyeOff,
    FileText,
    FolderCog,
    FolderInput,
    Contact,
    Pencil,
    MoveRight,
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

/**
 * An address as a browser will actually open it, or null when there is nothing
 * to open.
 *
 * Two corrections, both to things people really type into a vault. A bare host
 * is completed, because `example.com` means the site rather than a page on this
 * one. And the wildcard label comes off: `https://*.goldenowl.ai` is how
 * somebody writes "this site and everything under it", and following it verbatim
 * leads to a hostname that does not resolve.
 */
function openableUri(value: string): string | null {
    const bare = core.withoutWildcard(value.trim());
    if (!bare) return null;
    return /^[a-z][a-z0-9+.-]*:\/\//i.test(bare) ? bare : `https://${bare}`;
}

/**
 * The payment network's own mark, from the number.
 *
 * Read rather than stored, so it is right for a card whose number was corrected
 * and cannot disagree with the digits above it. Nothing is drawn for UnionPay or
 * Maestro: Polaris ships no official mark for either, and something drawn to
 * look approximately like a logo is worse than the name on its own.
 */
function CardMark({ number }: { number: string }) {
    const size = "size-5 text-muted-foreground";
    switch (core.cardBrand(number)) {
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
            return <CreditCard className={size} />;
    }
}

/** Where this browser's choice about favicons is kept. A habit of the person
 *  looking rather than a property of the vault, and one whose cost is a request
 *  to somebody else's site. */
const FAVICON_KEY = "polaris.vault.favicons";

/** What the list can be narrowed to. */
type Filter =
    | "all"
    | "favorites"
    | "trash"
    | "vault:mine"
    | `type:${number}`
    | `folder:${string}`
    | `vault:${string}`;

export function VaultApp() {
    const { key, lock, keyFor, vaultKeys, vaults } = useVaultSession();
    const [items, setItems] = useState<VaultItem[]>([]);
    const [folders, setFolders] = useState<VaultFolder[]>([]);
    const [loading, setLoading] = useState(false);
    const [query, setQuery] = useState("");
    const [filter, setFilter] = useState<Filter>("all");
    const [selected, setSelected] = useState<string | null>(null);
    const [editing, setEditing] = useState<VaultItem | null>(null);
    const [managingFolders, setManagingFolders] = useState(false);
    const [moving, setMoving] = useState<VaultItem | null>(null);
    const [revealed, setRevealed] = useState(false);
    const [copied, setCopied] = useState<string | null>(null);
    /**
     * Whether to fetch a site's own favicon for the list.
     *
     * Off unless it is turned on, and kept in this browser rather than in the
     * vault: it is not a property of the vault, it is a disclosure this person
     * is choosing to make from this machine. The request goes from here to that
     * site, and a site that receives it learns somebody with a Polaris vault has
     * an account there - which is why it never goes through the server, and
     * never through an icon service.
     */
    const [favicons, setFavicons] = useState(false);
    useEffect(() => {
        try {
            setFavicons(window.localStorage.getItem(FAVICON_KEY) === "on");
        } catch {
            // Storage off, or a private window. Letters are a fine answer.
        }
    }, []);
    const [confirm, confirmDialog] = useConfirm();

    /**
     * Pull everything and open it. Runs on unlock and after every write.
     *
     * Each item is opened with the key of the vault it is in - this account's own,
     * or another one's. An item whose key this account does not hold is skipped
     * rather than shown as a row of empty fields: being on a roster is not the
     * same as having been vouched for, and a half-drawn item would suggest it is.
     */
    async function load(withKey: SymmetricKey): Promise<void> {
        setLoading(true);
        const contents = await vaultContentsAction();
        const opened: VaultItem[] = [];
        for (const raw of contents.ciphers) {
            const owner = typeof raw.organizationId === "string" ? raw.organizationId : null;
            const itemKey = owner ? (vaultKeys.get(owner) ?? null) : withKey;
            if (!itemKey) continue;
            opened.push(await decryptItem(raw, itemKey));
        }
        setItems(opened.sort((left, right) => left.name.localeCompare(right.name)));
        setFolders(await decryptFolders(contents.folders, withKey));
        setLoading(false);
    }

    useEffect(() => {
        if (key) void load(key);
        // The other vaults' keys arrive a beat after this account's own, so this
        // runs again when they do. Not on every render: that would re-decrypt the
        // whole vault for nothing.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [key, vaultKeys]);

    const visible = useMemo(() => {
        const needle = query.trim().toLowerCase();
        return items.filter((item) => {
            if (filter === "trash" ? !item.deleted : item.deleted) return false;
            if (filter === "favorites" && !item.favorite) return false;
            if (filter.startsWith("type:") && item.type !== Number(filter.slice(5))) return false;
            if (filter.startsWith("folder:") && item.folderId !== filter.slice(7)) return false;
            if (filter === "vault:mine" && item.organizationId !== null) return false;
            if (
                filter.startsWith("vault:") &&
                filter !== "vault:mine" &&
                item.organizationId !== filter.slice(6)
            ) {
                return false;
            }
            if (!needle) return true;
            return [item.name, item.login.username, item.login.uris.join(" "), item.notes]
                .join(" ")
                .toLowerCase()
                .includes(needle);
        });
    }, [items, query, filter]);

    const current = visible.find((item) => item.id === selected) ?? null;

    /** The recovery codes on the open item, which are stored as a hidden custom
     *  field so every other Bitwarden client can read them. */
    const recoveryCodes = current
        ? core.fieldValue(current.fields, core.RECOVERY_CODES_FIELD)
        : "";

    /**
     * The custom fields nothing else on this screen has already drawn.
     *
     * The recovery codes, the issuing bank and the chosen icon live as custom
     * fields for compatibility, and listing them again at the bottom printed the
     * codes twice - the second time as a row of dots nobody could do anything
     * with. The index is carried along because it is what the copy state is
     * keyed by.
     */
    const extraFields = useMemo(() => {
        const managed = new Set<string>([
            core.RECOVERY_CODES_FIELD,
            core.BANK_FIELD,
            core.ICON_FIELD
        ]);
        return (current?.fields ?? [])
            .map((field, index) => ({ field, index }))
            .filter(({ field }) => !managed.has(field.name));
    }, [current]);

    /** Which vault an item belongs to, by the id the item carries. */
    function ownerName(vaultId: string): string {
        return vaults.find((vault) => vault.vaultId === vaultId)?.name ?? "Another vault";
    }

    /** The vaults this account can actually read, for the filter and the badge. */
    const readable = vaults.filter(
        (vault) => vault.vaultId !== null && vaultKeys.has(vault.vaultId)
    );

    async function copy(label: string, value: string): Promise<void> {
        await navigator.clipboard.writeText(value);
        setCopied(label);
        window.setTimeout(() => setCopied(null), 2000);
    }

    /** The six digits for an item, worked out now rather than shown: the menu is
     *  for taking a code away with you, and one that had to be read off the
     *  screen would be a code typed by hand. */
    async function copyTotp(item: VaultItem): Promise<void> {
        const code = await totpCode(item.login.totp);
        if (code) await copy("totp", code);
    }

    async function onSave(item: VaultItem, collectionIds: string[]): Promise<string | null> {
        if (!key) return "Your vault is locked.";
        // An item in another vault is written back under THAT vault's key, never
        // this account's - saving it under the wrong key would leave the other
        // members with an item none of them can open.
        const itemKey = keyFor(item.organizationId);
        if (!itemKey) return "You do not hold the key for that vault.";
        const body = await encryptItem(item, itemKey);
        const result = await saveItemAction(item.id || null, body, collectionIds);
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

    /**
     * The keys the context menu says these actions have.
     *
     * Bound on the row rather than on the window, so they act on the item under
     * the hand and never on whatever happens to be selected while somebody is
     * typing in the search box. A menu that prints a key nothing listens for is
     * the same defect as no hint at all, pointing the other way.
     */
    function onRowKey(event: React.KeyboardEvent, item: VaultItem): void {
        const mod = event.metaKey || event.ctrlKey;
        if (mod && event.shiftKey && event.key.toLowerCase() === "c") {
            event.preventDefault();
            void copy("username", item.login.username);
        } else if (mod && event.key.toLowerCase() === "c") {
            event.preventDefault();
            void copy("password", item.login.password);
        } else if (event.key === "F2" || event.key === "Enter") {
            // Enter on a focused button would otherwise fire the click that only
            // selects it, which is the thing the row is already showing.
            event.preventDefault();
            setEditing(item);
        } else if (event.key === "Delete") {
            event.preventDefault();
            void onDelete(item);
        }
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
                    <h1 className="text-[1.0625rem] font-semibold tracking-tight">Vault</h1>
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

            {/* The shape every password manager settled on, and for a reason:
                the list is a column somebody scans while the item they picked
                stays put beside it. Searching and filtering belong over the list
                they narrow rather than over the whole screen, since neither has
                anything to do with the item on the right. */}
            <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,19rem)_minmax(0,1fr)]">
                <Card className="lg:sticky lg:top-4">
                    <CardBody className="flex flex-col gap-2 p-2">
                        <div className="relative">
                            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                            <Input
                                value={query}
                                onChange={(event) => setQuery(event.target.value)}
                                placeholder="Search your vault"
                                className="pl-9"
                            />
                        </div>
                        <div className="flex items-center gap-2">
                            <Select
                                value={filter}
                                onValueChange={(value) => setFilter(value as Filter)}
                                aria-label="Show"
                                className="min-w-0 flex-1"
                                options={[
                                    { value: "all", label: "Everything" },
                                    { value: "favorites", label: "Favorites" },
                                    // Only worth offering once there is more than
                                    // one vault to tell apart.
                                    ...(readable.length > 0
                                        ? [
                                              { value: "vault:mine", label: "My own vault" },
                                              ...readable.map((vault) => ({
                                                  value: `vault:${vault.vaultId}`,
                                                  label: vault.name
                                              }))
                                          ]
                                        : []),
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
                            <div className="flex items-center justify-center gap-2 p-8 text-sm text-muted-foreground">
                                <Loader2 className="size-4 animate-spin" />
                                Opening your vault...
                            </div>
                        ) : visible.length === 0 ? (
                            <p className="p-8 text-center text-sm text-muted-foreground">
                                {items.length === 0
                                    ? "Nothing in here yet. Add a login, a note, a card or a key."
                                    : "Nothing matches that."}
                            </p>
                        ) : (
                            <ul className="-mr-1 flex max-h-[calc(100vh-16rem)] flex-col gap-0.5 overflow-y-auto pr-1">
                                {visible.map((item) => {
                                    const Icon = TYPE_ICON[item.type] ?? KeyRound;
                                    return (
                                        // Right-click does what right-click does
                                        // everywhere else in Polaris. Copying the
                                        // password is the thing people came here
                                        // for, and reaching it used to mean
                                        // opening the item and finding the button
                                        // - three actions for the one action.
                                        <li key={item.id}>
                                            <ContextMenu>
                                                <ContextMenuTrigger asChild>
                                                    <button
                                                        type="button"
                                                        onClick={() => {
                                                            setSelected(item.id);
                                                            setRevealed(false);
                                                        }}
                                                        onContextMenu={() => {
                                                            setSelected(item.id);
                                                            setRevealed(false);
                                                        }}
                                                        onKeyDown={(event) => onRowKey(event, item)}
                                                        className={`flex w-full items-center gap-3 rounded-md border p-2.5 text-left transition-colors ${
                                                            item.id === selected
                                                                ? "border-primary/40 bg-primary/5"
                                                                : "border-transparent hover:bg-card-hover"
                                                        }`}
                                                    >
                                                        {item.type === core.CIPHER_LOGIN ? (
                                                            <ItemIcon item={item} favicons={favicons} />
                                                        ) : (
                                                            <Icon className="size-4 shrink-0 text-muted-foreground" />
                                                        )}
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
                                                </ContextMenuTrigger>
                                                <ContextMenuContent>
                                                    <ContextMenuLabel title={item.name || "Untitled"}>
                                                        {item.name || "Untitled"}
                                                    </ContextMenuLabel>
                                                    {item.type === core.CIPHER_LOGIN ? (
                                                        <>
                                                            <ContextMenuItem
                                                                disabled={!item.login.username}
                                                                onSelect={() =>
                                                                    void copy(
                                                                        "username",
                                                                        item.login.username
                                                                    )
                                                                }
                                                            >
                                                                <Copy className="size-4" />
                                                                Copy{" "}
                                                                {core.looksLikeEmail(item.login.username)
                                                                    ? "email"
                                                                    : "username"}
                                                                <MenuShortcut keys="Mod+Shift+C" />
                                                            </ContextMenuItem>
                                                            <ContextMenuItem
                                                                disabled={!item.login.password}
                                                                onSelect={() =>
                                                                    void copy(
                                                                        "password",
                                                                        item.login.password
                                                                    )
                                                                }
                                                            >
                                                                <Copy className="size-4" />
                                                                Copy password
                                                                <MenuShortcut keys="Mod+C" />
                                                            </ContextMenuItem>
                                                            {item.login.totp ? (
                                                                <ContextMenuItem
                                                                    onSelect={() => void copyTotp(item)}
                                                                >
                                                                    <Copy className="size-4" />
                                                                    Copy the six digits
                                                                </ContextMenuItem>
                                                            ) : null}
                                                            {openableUri(item.login.uris[0]?.uri ?? "") ? (
                                                                <ContextMenuItem asChild>
                                                                    <a
                                                                        href={
                                                                            openableUri(
                                                                                item.login.uris[0]?.uri ??
                                                                                    ""
                                                                            ) ?? "#"
                                                                        }
                                                                        target="_blank"
                                                                        rel="noreferrer noopener"
                                                                    >
                                                                        <ExternalLink className="size-4" />
                                                                        Open the website
                                                                    </a>
                                                                </ContextMenuItem>
                                                            ) : null}
                                                            <ContextMenuSeparator />
                                                        </>
                                                    ) : null}
                                                    <ContextMenuItem onSelect={() => setEditing(item)}>
                                                        <Pencil className="size-4" />
                                                        Edit
                                                        <MenuShortcut keys="F2" />
                                                    </ContextMenuItem>
                                                    <ContextMenuItem
                                                        onSelect={() =>
                                                            void onSave(
                                                                { ...item, favorite: !item.favorite },
                                                                []
                                                            )
                                                        }
                                                    >
                                                        <Star className="size-4" />
                                                        {item.favorite
                                                            ? "Remove from favourites"
                                                            : "Favourite"}
                                                    </ContextMenuItem>
                                                    <ContextMenuItem onSelect={() => setMoving(item)}>
                                                        <FolderInput className="size-4" />
                                                        Move
                                                    </ContextMenuItem>
                                                    <ContextMenuSeparator />
                                                    <ContextMenuItem
                                                        variant="danger"
                                                        onSelect={() => void onDelete(item)}
                                                    >
                                                        <Trash2 className="size-4" />
                                                        {item.deleted ? "Delete for good" : "Move to trash"}
                                                        <MenuShortcut keys="Delete" />
                                                    </ContextMenuItem>
                                                </ContextMenuContent>
                                            </ContextMenu>
                                        </li>
                                    );
                                })}
                            </ul>
                        )}
                    </CardBody>
                </Card>

                {current ? (
                    <Card>
                        <CardBody className="flex flex-col gap-5">
                            <div className="flex flex-wrap items-start justify-between gap-3">
                                <div className="flex min-w-0 items-center gap-3">
                                    {current.type === core.CIPHER_LOGIN ? (
                                        <ItemIcon
                                            item={current}
                                            favicons={favicons}
                                            className="size-10 rounded-lg"
                                        />
                                    ) : (
                                        <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-muted">
                                            {(() => {
                                                const Icon = TYPE_ICON[current.type] ?? KeyRound;
                                                return <Icon className="size-5 text-muted-foreground" />;
                                            })()}
                                        </span>
                                    )}
                                    <div className="min-w-0">
                                        <h2 className="truncate text-base font-medium">
                                            {current.name || "Untitled"}
                                        </h2>
                                        <p className="truncate text-xs text-muted-foreground">
                                            {current.login.username ||
                                                core.CIPHER_TYPE_LABEL[current.type as core.CipherType]}
                                        </p>
                                    </div>
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
                                            await setItemFavoriteAction(current.id, !current.favorite);
                                            if (key) await load(key);
                                        }}
                                    >
                                        <Star
                                            className={`size-4 ${current.favorite ? "fill-amber-400 text-amber-400" : ""}`}
                                        />
                                    </Button>
                                    {/* Only when there is somewhere to move it:
                                        another vault whose key this account
                                        holds, or back to its own when it is
                                        already elsewhere. */}
                                    {!current.deleted &&
                                    (readable.some(
                                        (vault) => vault.vaultId !== current.organizationId
                                    ) ||
                                        current.organizationId) ? (
                                        <Button
                                            size="sm"
                                            variant="ghost"
                                            title="Move to another vault"
                                            aria-label={`Move ${current.name}`}
                                            onClick={() => setMoving(current)}
                                        >
                                            <MoveRight className="size-4" />
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
                                    <Section
                                        title="Sign in"
                                        when={Boolean(current.login.username || current.login.password)}
                                    >
                                        <Row
                                            label={
                                                core.looksLikeEmail(current.login.username)
                                                    ? "Email"
                                                    : "Username"
                                            }
                                            value={current.login.username}
                                            copied={copied === "username"}
                                            onCopy={() => copy("username", current.login.username)}
                                        />
                                        <Row
                                            label="Password"
                                            value={current.login.password}
                                            secret={!revealed}
                                            copied={copied === "password"}
                                            onCopy={() => copy("password", current.login.password)}
                                            onReveal={() => setRevealed((prev) => !prev)}
                                            revealed={revealed}
                                            /* Said every time the item is opened,
                                               which is the moment somebody is
                                               about to use this password
                                               somewhere. A password that was fine
                                               when it was chosen is in a breach
                                               corpus a year later, and nothing
                                               would ever have told them. The
                                               answer is kept for a month rather
                                               than asked for on every visit. */
                                            note={
                                                current.login.password ? (
                                                    <PasswordState
                                                        password={current.login.password}
                                                        scope={current.id}
                                                    />
                                                ) : null
                                            }
                                        />
                                    </Section>

                                    <Section
                                        title="Two-factor"
                                        when={Boolean(current.login.totp || recoveryCodes)}
                                    >
                                        {current.login.totp ? (
                                            <div className="px-3 py-2">
                                                <TotpCode value={current.login.totp} />
                                            </div>
                                        ) : null}
                                        {recoveryCodes ? (
                                            <div className="flex flex-col gap-2 px-3 py-2">
                                                <span className="text-xs text-muted-foreground">
                                                    Recovery codes
                                                </span>
                                                <RecoveryCodes
                                                    value={recoveryCodes}
                                                    onChange={(next) =>
                                                        void onSave(
                                                            {
                                                                ...current,
                                                                fields: core.withField(
                                                                    current.fields,
                                                                    core.RECOVERY_CODES_FIELD,
                                                                    next,
                                                                    core.FIELD_HIDDEN
                                                                )
                                                            },
                                                            []
                                                        )
                                                    }
                                                />
                                            </div>
                                        ) : null}
                                    </Section>

                                    <Section title="Websites" when={current.login.uris.length > 0}>
                                        {current.login.uris.map((entry) => (
                                            <Row
                                                key={entry.uri}
                                                label={
                                                    core.URI_MATCH_LABELS[
                                                        entry.match ?? core.DEFAULT_URI_MATCH
                                                    ]
                                                }
                                                value={entry.uri}
                                                link
                                            />
                                        ))}
                                    </Section>
                                </>
                            ) : null}

                            {current.type === core.CIPHER_CARD ? (
                                <Section title="Card" when>
                                    {/* The network's own mark, read from the
                                        number, beside who issued it. Two cards
                                        from one network look identical in a list
                                        without the bank. */}
                                    {current.card.brand ||
                                    core.fieldValue(current.fields, core.BANK_FIELD) ? (
                                        <div className="flex items-center gap-2 px-3 py-2 text-sm">
                                            <CardMark number={current.card.number} />
                                            <span>
                                                {[
                                                    current.card.brand,
                                                    core.fieldValue(current.fields, core.BANK_FIELD)
                                                ]
                                                    .filter(Boolean)
                                                    .join(" - ")}
                                            </span>
                                        </div>
                                    ) : null}
                                    <Row label="Name" value={current.card.cardholderName} />
                                    <Row
                                        label="Number"
                                        // Grouped the way the card prints it, so
                                        // it can be read back against the card in
                                        // hand.
                                        value={core.groupCardNumber(current.card.number)}
                                        secret={!revealed}
                                        revealed={revealed}
                                        copied={copied === "number"}
                                        onCopy={() => copy("number", current.card.number)}
                                        onReveal={() => setRevealed((prev) => !prev)}
                                    />
                                    <Row
                                        label="Expires"
                                        value={core.writeCardExpiry({
                                            month: current.card.expMonth,
                                            year: current.card.expYear
                                        })}
                                        /* Said where the card is read rather than
                                           only where it is edited: the moment
                                           somebody opens this is the moment they
                                           are about to use it. */
                                        note={
                                            core.cardExpired(
                                                {
                                                    month: current.card.expMonth,
                                                    year: current.card.expYear
                                                },
                                                new Date()
                                            ) ? (
                                                <span className="text-xs text-danger">
                                                    This card expired.
                                                </span>
                                            ) : core.cardExpiringSoon(
                                                  {
                                                      month: current.card.expMonth,
                                                      year: current.card.expYear
                                                  },
                                                  new Date()
                                              ) ? (
                                                <span className="text-xs text-warning">
                                                    This card expires soon.
                                                </span>
                                            ) : null
                                        }
                                    />
                                    <Row
                                        label="Security code"
                                        value={current.card.code}
                                        secret={!revealed}
                                        revealed={revealed}
                                        onReveal={() => setRevealed((prev) => !prev)}
                                    />
                                </Section>
                            ) : null}

                            {current.type === core.CIPHER_IDENTITY
                                ? IDENTITY_GROUPS.map((group) => {
                                      // The address is one thing, read the way an
                                      // address is read; the rest are rows.
                                      const lines =
                                          group.title === "Address"
                                              ? addressLines(current.identity)
                                              : [];
                                      const rows = group.fields.filter(
                                          ({ field }) => current.identity[field]
                                      );
                                      return (
                                          <Section
                                              key={group.title}
                                              title={group.title}
                                              when={
                                                  group.title === "Address"
                                                      ? lines.length > 0
                                                      : rows.length > 0
                                              }
                                          >
                                              {group.title === "Address" ? (
                                                  <div className="flex items-center gap-2 px-3 py-2">
                                                      <p className="min-w-0 flex-1 whitespace-pre-line text-sm">
                                                          {lines.join("\n")}
                                                      </p>
                                                      <Button
                                                          size="icon"
                                                          variant="ghost"
                                                          title="Copy"
                                                          aria-label="Copy the address"
                                                          onClick={() =>
                                                              copy("address", lines.join("\n"))
                                                          }
                                                      >
                                                          {copied === "address" ? (
                                                              <Check className="size-4 text-success" />
                                                          ) : (
                                                              <Copy className="size-4" />
                                                          )}
                                                      </Button>
                                                  </div>
                                              ) : (
                                                  rows.map(({ field }) => (
                                                      <Row
                                                          key={field}
                                                          label={identityLabel(field)}
                                                          value={current.identity[field] ?? ""}
                                                          copied={copied === `id-${field}`}
                                                          onCopy={() =>
                                                              copy(
                                                                  `id-${field}`,
                                                                  current.identity[field] ?? ""
                                                              )
                                                          }
                                                      />
                                                  ))
                                              )}
                                          </Section>
                                      );
                                  })
                                : null}

                            {current.type === core.CIPHER_SSH_KEY ? (
                                <Section title="Key" when>
                                    <Row
                                        label="Public key"
                                        value={current.sshKey.publicKey}
                                        copied={copied === "public"}
                                        onCopy={() => copy("public", current.sshKey.publicKey)}
                                    />
                                    <Row
                                        label="Private key"
                                        value={current.sshKey.privateKey}
                                        secret={!revealed}
                                        revealed={revealed}
                                        copied={copied === "private"}
                                        onCopy={() => copy("private", current.sshKey.privateKey)}
                                        onReveal={() => setRevealed((prev) => !prev)}
                                    />
                                </Section>
                            ) : null}

                            {/* Only the fields nothing else on this screen has
                                already drawn. The recovery codes, the bank and
                                the chosen icon are stored as custom fields so
                                other clients can read them, and listing them
                                again here printed the codes twice - the second
                                time as an unreadable row of dots. */}
                            <Section title="More" when={extraFields.length > 0}>
                                {extraFields.map(({ field, index }) => (
                                    <Row
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
                            </Section>

                            <Section title="Notes" when={Boolean(current.notes)}>
                                <p className="whitespace-pre-wrap px-3 py-2 text-sm">
                                    {current.notes}
                                </p>
                            </Section>
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
            <MoveDialog
                item={moving}
                onClose={() => setMoving(null)}
                onMoved={() => (key ? load(key) : Promise.resolve())}
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
 * means the site, not a path relative to the dashboard - and a wildcard label is
 * dropped, since `https://*.example.com` is a site somebody meant and not a
 * hostname anything can resolve.
 */
function webLink(value: string): string | null {
    const bare = core.withoutWildcard(value.trim());
    if (!bare) return null;
    try {
        const url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(bare) ? bare : `https://${bare}`);
        return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
    } catch {
        return null;
    }
}

/**
 * A block of the record, with its own heading.
 *
 * Drawn only when it has something in it, which is why the caller says so rather
 * than the section counting its children: a section that renders an empty
 * bordered box is worse than no section, and half of these are conditional on
 * fields the item may simply not have.
 */
function Section({
    title,
    when,
    children
}: {
    title: string;
    /** Whether there is anything to show. */
    when: boolean;
    children: ReactNode;
}) {
    if (!when) return null;
    return (
        <section className="flex flex-col gap-1.5">
            <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {title}
            </h3>
            <div className="divide-y divide-border overflow-hidden rounded-lg border border-border">
                {children}
            </div>
        </section>
    );
}

/** One labelled value, with the affordances that value deserves. */
function Row({
    label,
    value,
    secret = false,
    revealed = false,
    link = false,
    copied = false,
    note,
    onCopy,
    onReveal
}: {
    label: string;
    value: string;
    secret?: boolean;
    revealed?: boolean;
    link?: boolean;
    copied?: boolean;
    /** A sentence about the value that belongs under it - how strong a password
     *  is, whether a card has expired. */
    note?: ReactNode;
    onCopy?: () => void;
    onReveal?: () => void;
}) {
    if (!value) return null;
    const href = link ? webLink(value) : null;
    return (
        <div className="flex items-center gap-2 px-3 py-2">
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
                {note ? <div className="mt-1">{note}</div> : null}
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
