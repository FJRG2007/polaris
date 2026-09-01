"use client";

/**
 * Vaults: every one this account can open.
 *
 * A vault is a key and the people who hold it. One of somebody's own is that
 * with one member, an organization's is that with a roster, and this screen is
 * the same screen for both because nothing below the name differs.
 *
 * The account's own vault is listed first and drawn by a panel of its own. It is
 * a VaultAccount rather than a VaultOrganization - folders instead of
 * collections, nobody to invite - so none of the controls below apply to it, and
 * leaving it off the list made a screen headed "Vaults" look empty to somebody
 * whose items are all in one.
 *
 * Three things happen here that cannot happen anywhere else, and all three need
 * a browser holding an unlocked vault:
 *
 *  - **Creating one.** The vault's key is minted here and immediately wrapped to
 *    the creator's own public key, so the server receives a vault it cannot open
 *    from the first second it exists.
 *  - **Letting somebody in.** Being on a roster puts a person on the list; what
 *    lets them read anything is an administrator's browser unwrapping the vault's
 *    key and wrapping it again to that person's public key. Nothing on the server
 *    can do that step, which is the point of it.
 *  - **Saying how much they reach.** The key opens the whole vault either way, so
 *    a narrower scope is what the server will show and let them write, not a
 *    smaller key. Sharing with somebody you would not trust with all of it means
 *    a second vault.
 */

import Link from "next/link";
import * as core from "@polaris/core";
import * as share from "../share-actions";
import { useEffect, useState } from "react";
import * as vaultCrypto from "@/lib/vault/crypto";
import type { VaultView } from "../share-actions";
import { useVaultSession } from "../vault-session";
import { useConfirm } from "@/components/confirm-dialog";
import { useVaultCollections, type VaultCollection } from "../use-vault-collections";
import {
    Building2,
    Check,
    FolderPlus,
    KeyRound,
    Loader2,
    LogOut,
    Pencil,
    Plus,
    ShieldCheck,
    Trash2,
    User,
    X
} from "lucide-react";
import {
    Badge,
    Button,
    Card,
    CardBody,
    CardHeader,
    CardTitle,
    Checkbox,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Input,
    Select
} from "@polaris/ui";

interface MemberRow {
    id: string;
    email: string;
    name: string | null;
    status: number;
    accessAll: boolean;
    collections: { id: string; readOnly: boolean; hidePasswords: boolean }[];
}

/** What a vault is picked by. An organization with no vault yet has no id. */
function pickerValue(vault: VaultView): string {
    if (vault.account) return "account";
    return vault.vaultId ?? `org:${vault.organizationId}`;
}

export function VaultsView() {
    const { vaults, vaultKeys, key, privateKey, reloadVaults } = useVaultSession();
    const [selected, setSelected] = useState("");
    const [creating, setCreating] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const current = vaults.find((vault) => pickerValue(vault) === selected) ?? vaults[0] ?? null;

    useEffect(() => {
        if (!selected && vaults[0]) setSelected(pickerValue(vaults[0]));
    }, [vaults, selected]);

    return (
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                    <h1 className="text-[1.0625rem] font-semibold tracking-tight">Vaults</h1>
                    <p className="text-sm text-muted-foreground">
                        Every vault you can open, each with its own key. Yours is the first.
                    </p>
                </div>
                <Button size="sm" onClick={() => setCreating(true)}>
                    <Plus className="size-4" />
                    New vault
                </Button>
            </div>

            {vaults.length === 0 ? (
                <Card>
                    <CardBody className="p-6 text-sm text-muted-foreground">
                        Nothing here yet. Set up your own vault from the Vault app first; then you
                        can make another to keep something apart, or to share it with somebody.
                    </CardBody>
                </Card>
            ) : (
                <Select
                    value={current ? pickerValue(current) : ""}
                    onValueChange={setSelected}
                    aria-label="Vault"
                    options={vaults.map((vault) => ({
                        value: pickerValue(vault),
                        label: vault.organizationId ? `${vault.name} (organization)` : vault.name
                    }))}
                />
            )}

            {error ? <p className="text-sm text-danger">{error}</p> : null}

            {current ? (
                current.account ? (
                    <AccountVaultPanel />
                ) : current.vaultId === null ? (
                    <CreateOrganizationVault
                        vault={current}
                        onError={setError}
                        onCreated={reloadVaults}
                    />
                ) : (
                    <VaultPanel
                        vault={current}
                        vaultKey={vaultKeys.get(current.vaultId) ?? null}
                        hasPersonalKey={key !== null && privateKey !== null}
                        onError={setError}
                        onChanged={reloadVaults}
                    />
                )
            ) : null}

            <NewVaultDialog
                open={creating}
                onClose={() => setCreating(false)}
                onCreated={async (vaultId) => {
                    await reloadVaults();
                    // Land on what was just made, rather than leaving somebody on
                    // the vault they happened to be looking at.
                    setSelected(vaultId);
                }}
                onError={setError}
            />
        </div>
    );
}

/** Mint a vault of somebody's own. Every key in it is made in this browser. */
function NewVaultDialog({
    open,
    onClose,
    onCreated,
    onError
}: {
    open: boolean;
    onClose: () => void;
    onCreated: (vaultId: string) => Promise<void>;
    onError: (message: string | null) => void;
}) {
    const { state } = useVaultSession();
    const [name, setName] = useState("");
    const [pending, setPending] = useState(false);
    const [problem, setProblem] = useState<string | null>(null);

    useEffect(() => {
        if (open) {
            setName("");
            setProblem(null);
        }
    }, [open]);

    const parsed = core.vaultNameField.safeParse(name);
    const nameProblem = name.length > 0 && !parsed.success ? parsed.error.issues[0]?.message : null;

    async function onCreate(): Promise<void> {
        if (!parsed.success) return;
        if (!state.publicKey) {
            setProblem("Your own vault has to be open first.");
            return;
        }
        setPending(true);
        setProblem(null);
        try {
            const vaultKey = vaultCrypto.generateSymmetricKey();
            const pair = await vaultCrypto.generateRsaKeyPair();
            const result = await share.createPersonalVaultAction({
                name: parsed.data,
                // Wrapped to the creator's PUBLIC key rather than to their vault
                // key, because that is the same envelope every other member is
                // handed later.
                key: await vaultCrypto.encryptRsa(
                    vaultCrypto.symmetricKeyBytes(vaultKey),
                    state.publicKey
                ),
                keys: {
                    publicKey: pair.publicKey,
                    encryptedPrivateKey: await vaultCrypto.encryptBytes(pair.privateKey, vaultKey)
                },
                collectionName: await vaultCrypto.encrypt("General", vaultKey)
            });
            if (result.error || !result.vaultId) {
                setProblem(result.error ?? "That vault could not be created.");
                return;
            }
            onError(null);
            await onCreated(result.vaultId);
            onClose();
        } finally {
            setPending(false);
        }
    }

    return (
        <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>New vault</DialogTitle>
                    <DialogDescription>
                        Its key is made in this browser and wrapped to you. The name is the one
                        thing about it the server can read.
                    </DialogDescription>
                </DialogHeader>
                <form
                    className="flex flex-col gap-2"
                    onSubmit={(event) => {
                        event.preventDefault();
                        void onCreate();
                    }}
                >
                    <Input
                        value={name}
                        onChange={(event) => setName(event.target.value)}
                        placeholder="Work, family, side project"
                        aria-label="Vault name"
                        autoFocus
                        maxLength={core.VAULT_NAME_MAX}
                    />
                    {nameProblem ? <p className="text-sm text-danger">{nameProblem}</p> : null}
                    {problem ? <p className="text-sm text-danger">{problem}</p> : null}
                    <DialogFooter>
                        <Button type="button" variant="secondary" onClick={onClose}>
                            Cancel
                        </Button>
                        <Button type="submit" disabled={pending || !parsed.success}>
                            {pending ? (
                                <Loader2 className="size-4 animate-spin" />
                            ) : (
                                <Plus className="size-4" />
                            )}
                            Create it
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}

/** Give an organization a vault. Every key in it is minted here. */
/**
 * The vault every account already has, on the screen that lists vaults.
 *
 * It has no panel of controls because there is nothing here to run: it is one
 * person's, so there is nobody to invite and no collection to scope. What it
 * needs to say is that it exists, that it is where items land by default, and
 * how something gets out of it - which is by moving the item, not by sharing
 * the vault.
 */
function AccountVaultPanel() {
    return (
        <Card>
            <CardHeader>
                <CardTitle>My own vault</CardTitle>
            </CardHeader>
            <CardBody className="flex flex-col gap-3 text-[0.8125rem] text-muted-foreground">
                <p>
                    Everything you save lands here unless you put it somewhere else. It is yours
                    alone: nobody can be let in, because the key is wrapped under your master
                    password and nothing on the server can derive it.
                </p>
                <p>
                    To let somebody at one of these items, make a vault below and move the item
                    into it from the item itself. Moving re-encrypts it under that vault&apos;s key,
                    which is what sharing actually is here.
                </p>
                <Button asChild variant="outline" size="sm" className="self-start">
                    <Link href="/vault">Open it</Link>
                </Button>
            </CardBody>
        </Card>
    );
}

function CreateOrganizationVault({
    vault,
    onError,
    onCreated
}: {
    vault: VaultView;
    onError: (message: string | null) => void;
    onCreated: () => Promise<void>;
}) {
    const { state } = useVaultSession();
    const [pending, setPending] = useState(false);

    if (!vault.mayAdminister) {
        return (
            <Card>
                <CardBody className="p-6 text-sm text-muted-foreground">
                    {vault.name} has no vault yet, and setting one up is not something your role
                    there can do.
                </CardBody>
            </Card>
        );
    }

    async function onCreate(): Promise<void> {
        if (!state.publicKey || !vault.organizationId) {
            onError("Your own vault has to be open first.");
            return;
        }
        setPending(true);
        onError(null);
        try {
            const orgKey = vaultCrypto.generateSymmetricKey();
            const pair = await vaultCrypto.generateRsaKeyPair();
            const result = await share.createOrganizationVaultAction({
                organizationId: vault.organizationId,
                key: await vaultCrypto.encryptRsa(
                    vaultCrypto.symmetricKeyBytes(orgKey),
                    state.publicKey
                ),
                keys: {
                    publicKey: pair.publicKey,
                    encryptedPrivateKey: await vaultCrypto.encryptBytes(pair.privateKey, orgKey)
                },
                collectionName: await vaultCrypto.encrypt("Shared", orgKey)
            });
            if (result.error) {
                onError(result.error);
                return;
            }
            await onCreated();
        } finally {
            setPending(false);
        }
    }

    return (
        <Card>
            <CardHeader>
                <CardTitle className="flex items-center gap-2">
                    <Building2 className="size-4" />
                    Set up a vault for {vault.name}
                </CardTitle>
            </CardHeader>
            <CardBody className="flex flex-col gap-3">
                <p className="text-sm text-muted-foreground">
                    The keys are made in this browser. You will hold it first, and anybody else who
                    should read it has to be let in by somebody who already can.
                </p>
                <div className="flex justify-end">
                    <Button onClick={onCreate} disabled={pending}>
                        {pending ? (
                            <Loader2 className="size-4 animate-spin" />
                        ) : (
                            <Plus className="size-4" />
                        )}
                        Create it
                    </Button>
                </div>
            </CardBody>
        </Card>
    );
}

/** One vault: what it is called, what is in it, and who is in it. */
function VaultPanel({
    vault,
    vaultKey,
    hasPersonalKey,
    onError,
    onChanged
}: {
    vault: VaultView;
    vaultKey: vaultCrypto.SymmetricKey | null;
    hasPersonalKey: boolean;
    onError: (message: string | null) => void;
    onChanged: () => Promise<void>;
}) {
    const { privateKey } = useVaultSession();
    const [members, setMembers] = useState<MemberRow[]>([]);
    const [candidates, setCandidates] = useState<
        { userId: string; name: string; email: string; hasVault: boolean }[]
    >([]);
    const { collections, reload: reloadCollections } = useVaultCollections(vault.vaultId);
    const [newCollection, setNewCollection] = useState("");
    const [invitee, setInvitee] = useState("");
    const [renaming, setRenaming] = useState<string | null>(null);
    const [pending, setPending] = useState(false);
    const [access, setAccess] = useState<MemberRow | null>(null);
    const [confirm, confirmDialog] = useConfirm();
    const vaultId = vault.vaultId ?? "";

    async function reload(): Promise<void> {
        if (vault.mayAdminister) {
            const result = await share.vaultMembersAction(vaultId);
            if (result.error) onError(result.error);
            setMembers(
                (result.members ?? []).map((row) => ({
                    id: String(row.id ?? ""),
                    email: String(row.email ?? ""),
                    name: typeof row.name === "string" ? row.name : null,
                    status: Number(row.status ?? 0),
                    accessAll: row.accessAll === true,
                    collections: Array.isArray(row.collections)
                        ? (row.collections as Record<string, unknown>[]).map((entry) => ({
                              id: String(entry.id ?? ""),
                              readOnly: entry.readOnly === true,
                              hidePasswords: entry.hidePasswords === true
                          }))
                        : []
                }))
            );
            setCandidates(result.candidates ?? []);
        }
        await reloadCollections();
    }

    useEffect(() => {
        setInvitee("");
        void reload();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [vaultId, vaultKey]);

    /**
     * Vouch for somebody: unwrap the vault's key here and wrap it again to them.
     * This is the only step that turns a name on a list into access.
     */
    async function onLetIn(member: MemberRow, scope: core.VaultScope): Promise<void> {
        if (!vaultKey || !privateKey || !hasPersonalKey) {
            onError("Your own vault has to be open, and you have to hold this vault's key.");
            return;
        }
        setPending(true);
        onError(null);
        try {
            const theirKey = await share.memberPublicKeyAction(vaultId, member.id);
            if (theirKey.error || !theirKey.publicKey) {
                onError(theirKey.error ?? "That person has no key to wrap this to.");
                return;
            }
            const wrapped = await vaultCrypto.encryptRsa(
                vaultCrypto.symmetricKeyBytes(vaultKey),
                theirKey.publicKey
            );
            const result = await share.confirmVaultMemberAction(
                vaultId,
                member.id,
                wrapped,
                scope
            );
            if (result.error) {
                onError(result.error);
                return;
            }
            await reload();
        } finally {
            setPending(false);
        }
    }

    async function onScope(member: MemberRow, scope: core.VaultScope): Promise<void> {
        setPending(true);
        onError(null);
        const result = await share.setMemberScopeAction(vaultId, member.id, scope);
        setPending(false);
        if (result.error) {
            onError(result.error);
            return;
        }
        await reload();
    }

    async function onInvite(): Promise<void> {
        const email = invitee.trim();
        if (!email) return;
        setPending(true);
        onError(null);
        const result = await share.inviteVaultMemberAction(vaultId, email, core.ORG_ROLE_USER);
        setPending(false);
        if (result.error) {
            onError(result.error);
            return;
        }
        setInvitee("");
        await reload();
    }

    async function onRemove(member: MemberRow): Promise<void> {
        const confirmed = await confirm({
            title: `Take ${member.email} out of this vault?`,
            description:
                "They keep whatever they already synced - a key cannot be un-given - but they stop receiving anything new. Change what they knew if that matters.",
            confirmLabel: "Remove",
            danger: true
        });
        if (!confirmed) return;
        const result = await share.removeVaultMemberAction(vaultId, member.id);
        if (result.error) {
            onError(result.error);
            return;
        }
        await reload();
    }

    async function onAddCollection(): Promise<void> {
        const name = newCollection.trim();
        if (!name || !vaultKey) return;
        setPending(true);
        onError(null);
        const result = await share.saveVaultCollectionAction(
            vaultId,
            null,
            await vaultCrypto.encrypt(name, vaultKey)
        );
        setPending(false);
        if (result.error) {
            onError(result.error);
            return;
        }
        setNewCollection("");
        await reload();
    }

    async function onDeleteCollection(collection: VaultCollection): Promise<void> {
        const confirmed = await confirm({
            title: `Delete the collection "${collection.name}"?`,
            description:
                "What is in it is not deleted. It stops being shared through this collection, which may leave it reachable only by an administrator.",
            confirmLabel: "Delete",
            danger: true
        });
        if (!confirmed) return;
        const result = await share.deleteVaultCollectionAction(vaultId, collection.id);
        if (result.error) {
            onError(result.error);
            return;
        }
        await reload();
    }

    async function onRename(): Promise<void> {
        const name = (renaming ?? "").trim();
        if (!name) return;
        setPending(true);
        onError(null);
        const result = await share.renameVaultAction(vaultId, name);
        setPending(false);
        if (result.error) {
            onError(result.error);
            return;
        }
        setRenaming(null);
        await onChanged();
    }

    async function onLeave(): Promise<void> {
        const confirmed = await confirm({
            title: `Leave "${vault.name}"?`,
            description:
                "It stops syncing to you and you lose what is in it. Whatever you already synced stays on the devices that have it.",
            confirmLabel: "Leave",
            danger: true
        });
        if (!confirmed) return;
        const result = await share.leaveVaultAction(vaultId);
        if (result.error) {
            onError(result.error);
            return;
        }
        await onChanged();
    }

    async function onDeleteVault(): Promise<void> {
        const confirmed = await confirm({
            title: `Delete "${vault.name}"?`,
            description:
                "Everything in it goes with it, and its key goes too. Anybody you let in keeps what they already synced. This cannot be undone.",
            confirmLabel: "Delete the vault",
            danger: true
        });
        if (!confirmed) return;
        const result = await share.deleteVaultAction(vaultId);
        if (result.error) {
            onError(result.error);
            return;
        }
        await onChanged();
    }

    return (
        <>
            {!vaultKey ? (
                <Card>
                    <CardBody className="p-6 text-sm text-muted-foreground">
                        You are on this vault&apos;s list but nobody has let you in yet. Until
                        somebody who holds its key vouches for you, there is nothing here to read -
                        which is what makes it worth being in.
                    </CardBody>
                </Card>
            ) : (
                <Card>
                    <CardHeader>
                        <CardTitle className="flex items-center gap-2">
                            {vault.organizationId ? (
                                <Building2 className="size-4" />
                            ) : (
                                <User className="size-4" />
                            )}
                            Collections
                        </CardTitle>
                    </CardHeader>
                    <CardBody className="flex flex-col gap-2">
                        <p className="text-sm text-muted-foreground">
                            Where an item in this vault lives. Moving something into one is done
                            from the item itself.
                        </p>
                        {vault.mayAdminister ? (
                            <form
                                className="flex items-center gap-2"
                                onSubmit={(event) => {
                                    event.preventDefault();
                                    void onAddCollection();
                                }}
                            >
                                <Input
                                    value={newCollection}
                                    onChange={(event) => setNewCollection(event.target.value)}
                                    placeholder="New collection"
                                    aria-label="New collection name"
                                />
                                <Button
                                    type="submit"
                                    size="sm"
                                    disabled={pending || !newCollection.trim()}
                                >
                                    <FolderPlus className="size-4" />
                                    Add
                                </Button>
                            </form>
                        ) : null}
                        {collections.length === 0 ? (
                            <p className="py-2 text-sm text-muted-foreground">No collections yet.</p>
                        ) : (
                            <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
                                {collections.map((collection) => (
                                    <li
                                        key={collection.id}
                                        className="flex items-center gap-2 p-2 text-sm"
                                    >
                                        <span className="min-w-0 flex-1 truncate">
                                            {collection.name}
                                        </span>
                                        {vault.mayAdminister ? (
                                            <Button
                                                size="icon"
                                                variant="ghost"
                                                title="Delete"
                                                aria-label={`Delete ${collection.name}`}
                                                onClick={() => void onDeleteCollection(collection)}
                                            >
                                                <Trash2 className="size-4" />
                                            </Button>
                                        ) : null}
                                    </li>
                                ))}
                            </ul>
                        )}
                    </CardBody>
                </Card>
            )}

            {vault.mayAdminister ? (
                <Card>
                    <CardHeader>
                        <CardTitle>Who is in it</CardTitle>
                    </CardHeader>
                    <CardBody className="flex flex-col gap-2">
                        <p className="text-sm text-muted-foreground">
                            Adding somebody puts them on the list. Letting them in hands over the
                            key, and only somebody who already holds it can do that.
                        </p>
                        <div className="flex items-center gap-2">
                            {vault.organizationId ? (
                                <Select
                                    value={invitee}
                                    onValueChange={setInvitee}
                                    aria-label="Somebody to add"
                                    placeholder="Everybody on the roster is already here"
                                    className="min-w-0 flex-1"
                                    options={candidates.map((person) => ({
                                        value: person.email,
                                        label: person.hasVault
                                            ? `${person.name} (${person.email})`
                                            : `${person.name} - no vault of their own yet`,
                                        disabled: !person.hasVault
                                    }))}
                                />
                            ) : (
                                <Input
                                    type="email"
                                    value={invitee}
                                    onChange={(event) => setInvitee(event.target.value)}
                                    placeholder="Their email address"
                                    aria-label="Somebody to add"
                                    className="min-w-0 flex-1"
                                />
                            )}
                            <Button size="sm" onClick={onInvite} disabled={pending || !invitee}>
                                <Plus className="size-4" />
                                Add
                            </Button>
                        </div>
                        <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
                            {members.map((member) => (
                                <li key={member.id} className="flex items-center gap-2 p-2">
                                    <div className="min-w-0 flex-1">
                                        <p className="truncate text-sm">
                                            {member.name ?? member.email}
                                        </p>
                                        <p className="truncate text-xs text-muted-foreground">
                                            {member.email}
                                        </p>
                                    </div>
                                    {member.status === core.ORG_USER_CONFIRMED ? (
                                        <>
                                            <Badge variant="neutral">
                                                {member.accessAll
                                                    ? "Whole vault"
                                                    : `${member.collections.length} collections`}
                                            </Badge>
                                            <Badge variant="success">Holds the key</Badge>
                                            <Button
                                                size="icon"
                                                variant="ghost"
                                                title="Change what they reach"
                                                aria-label={`Change what ${member.email} reaches`}
                                                onClick={() => setAccess(member)}
                                            >
                                                <Pencil className="size-4" />
                                            </Button>
                                        </>
                                    ) : (
                                        <>
                                            <Badge variant="neutral">Not let in yet</Badge>
                                            <Button
                                                size="icon"
                                                variant="ghost"
                                                title="Let them in"
                                                aria-label={`Let ${member.email} in`}
                                                disabled={pending || !vaultKey}
                                                onClick={() => setAccess(member)}
                                            >
                                                {pending ? (
                                                    <Loader2 className="size-4 animate-spin" />
                                                ) : (
                                                    <ShieldCheck className="size-4" />
                                                )}
                                            </Button>
                                        </>
                                    )}
                                    <Button
                                        size="icon"
                                        variant="ghost"
                                        title="Remove"
                                        aria-label={`Remove ${member.email}`}
                                        onClick={() => void onRemove(member)}
                                    >
                                        <X className="size-4" />
                                    </Button>
                                </li>
                            ))}
                        </ul>
                    </CardBody>
                </Card>
            ) : null}

            {vault.mine ? (
                <Card>
                    <CardHeader>
                        <CardTitle>This vault</CardTitle>
                    </CardHeader>
                    <CardBody className="flex flex-col gap-3">
                        {renaming === null ? (
                            <div className="flex items-center gap-2">
                                <p className="min-w-0 flex-1 truncate text-sm" title={vault.name}>{vault.name}</p>
                                <Button
                                    size="icon"
                                    variant="ghost"
                                    title="Rename"
                                    aria-label={`Rename ${vault.name}`}
                                    onClick={() => setRenaming(vault.name)}
                                >
                                    <Pencil className="size-4" />
                                </Button>
                            </div>
                        ) : (
                            <form
                                className="flex items-center gap-2"
                                onSubmit={(event) => {
                                    event.preventDefault();
                                    void onRename();
                                }}
                            >
                                <Input
                                    value={renaming}
                                    onChange={(event) => setRenaming(event.target.value)}
                                    aria-label="Vault name"
                                    maxLength={core.VAULT_NAME_MAX}
                                    autoFocus
                                />
                                <Button type="submit" size="sm" disabled={pending}>
                                    Save
                                </Button>
                                <Button
                                    type="button"
                                    size="sm"
                                    variant="secondary"
                                    onClick={() => setRenaming(null)}
                                >
                                    Cancel
                                </Button>
                            </form>
                        )}
                        <div className="flex items-center justify-between gap-2">
                            <p className="text-sm text-muted-foreground">
                                Deleting it takes everything in it, and its key.
                            </p>
                            <Button size="sm" variant="danger" onClick={() => void onDeleteVault()}>
                                <Trash2 className="size-4" />
                                Delete
                            </Button>
                        </div>
                    </CardBody>
                </Card>
            ) : null}

            {!vault.mine && vault.memberId ? (
                <Card>
                    <CardBody className="flex flex-wrap items-center justify-between gap-2 p-4">
                        <p className="text-sm text-muted-foreground">
                            {vault.organizationId
                                ? "You were let into this vault."
                                : "Somebody let you into this vault."}
                        </p>
                        <Button size="sm" variant="secondary" onClick={() => void onLeave()}>
                            <LogOut className="size-4" />
                            Leave it
                        </Button>
                    </CardBody>
                </Card>
            ) : null}

            <AccessDialog
                member={access}
                collections={collections}
                onClose={() => setAccess(null)}
                onSave={async (member, scope) => {
                    if (member.status === core.ORG_USER_CONFIRMED) await onScope(member, scope);
                    else await onLetIn(member, scope);
                }}
            />
            {confirmDialog}
        </>
    );
}

/**
 * How much of the vault one member reaches.
 *
 * The same dialog whether they are being let in for the first time or having it
 * changed afterwards: it is one question, and asking it differently the second
 * time is how a scope quietly gets widened.
 */
function AccessDialog({
    member,
    collections,
    onClose,
    onSave
}: {
    member: MemberRow | null;
    collections: VaultCollection[];
    onClose: () => void;
    onSave: (member: MemberRow, scope: core.VaultScope) => Promise<void>;
}) {
    const [whole, setWhole] = useState(true);
    const [picked, setPicked] = useState<Map<string, { readOnly: boolean }>>(new Map());
    const [pending, setPending] = useState(false);

    useEffect(() => {
        if (!member) return;
        setWhole(member.accessAll);
        setPicked(
            new Map(
                member.collections.map((entry) => [entry.id, { readOnly: entry.readOnly }])
            )
        );
    }, [member]);

    function toggle(id: string): void {
        setPicked((previous) => {
            const next = new Map(previous);
            if (next.has(id)) next.delete(id);
            else next.set(id, { readOnly: false });
            return next;
        });
    }

    function setReadOnly(id: string, readOnly: boolean): void {
        setPicked((previous) => {
            const next = new Map(previous);
            if (next.has(id)) next.set(id, { readOnly });
            return next;
        });
    }

    async function onConfirm(): Promise<void> {
        if (!member) return;
        setPending(true);
        try {
            await onSave(member, {
                accessAll: whole,
                collections: whole
                    ? []
                    : [...picked.entries()].map(([collectionId, options]) => ({
                          collectionId,
                          readOnly: options.readOnly,
                          hidePasswords: false
                      }))
            });
            onClose();
        } finally {
            setPending(false);
        }
    }

    const firstTime = member !== null && member.status !== core.ORG_USER_CONFIRMED;
    return (
        <Dialog open={member !== null} onOpenChange={(open) => !open && onClose()}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>
                        {firstTime ? `Let ${member?.email} in` : `What ${member?.email} reaches`}
                    </DialogTitle>
                    <DialogDescription>
                        They are handed this vault&apos;s key either way. What you choose here is
                        what they are shown and allowed to change.
                    </DialogDescription>
                </DialogHeader>

                <div className="flex flex-col gap-2">
                    <label className="flex items-center gap-2 text-sm">
                        <Checkbox
                            checked={whole}
                            onChange={(event) => setWhole(event.target.checked)}
                            aria-label="The whole vault"
                        />
                        The whole vault
                    </label>
                    {whole ? null : collections.length === 0 ? (
                        <p className="text-sm text-muted-foreground">
                            There are no collections to pick. Make one first.
                        </p>
                    ) : (
                        <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
                            {collections.map((collection) => {
                                const chosen = picked.get(collection.id);
                                return (
                                    <li
                                        key={collection.id}
                                        className="flex items-center gap-2 p-2 text-sm"
                                    >
                                        <Checkbox
                                            checked={chosen !== undefined}
                                            onChange={() => toggle(collection.id)}
                                            aria-label={collection.name}
                                        />
                                        <span className="min-w-0 flex-1 truncate">
                                            {collection.name}
                                        </span>
                                        {chosen ? (
                                            <label className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
                                                <Checkbox
                                                    checked={chosen.readOnly}
                                                    onChange={(event) =>
                                                        setReadOnly(
                                                            collection.id,
                                                            event.target.checked
                                                        )
                                                    }
                                                    aria-label={`Read only in ${collection.name}`}
                                                />
                                                Read only
                                            </label>
                                        ) : null}
                                    </li>
                                );
                            })}
                        </ul>
                    )}
                </div>

                <DialogFooter>
                    <Button type="button" variant="secondary" onClick={onClose}>
                        Cancel
                    </Button>
                    <Button
                        type="button"
                        onClick={onConfirm}
                        disabled={pending || (!whole && picked.size === 0)}
                    >
                        {pending ? (
                            <Loader2 className="size-4 animate-spin" />
                        ) : firstTime ? (
                            <KeyRound className="size-4" />
                        ) : (
                            <Check className="size-4" />
                        )}
                        {firstTime ? "Let them in" : "Save"}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
