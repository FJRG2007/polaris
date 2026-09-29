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
 * leaving it off the list made a screen headed t("vaults.title") look empty to somebody
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
import { useTranslations } from "@/components/i18n/i18n-provider";
import { vaultSchemaText } from "../vault-labels";
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
    const t = useTranslations("vault");
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
                    <h1 className="text-[1.0625rem] font-semibold tracking-tight">{t("vaults.title")}</h1>
                    <p className="text-sm text-muted-foreground">
                        {t("vaults.intro")}
                    </p>
                </div>
                <Button size="sm" onClick={() => setCreating(true)}>
                    <Plus className="size-4" />
                    {t("vaults.newVault")}
                </Button>
            </div>

            {vaults.length === 0 ? (
                <Card>
                    <CardBody className="p-6 text-sm text-muted-foreground">
                        {t("vaults.empty")}
                    </CardBody>
                </Card>
            ) : (
                <Select
                    value={current ? pickerValue(current) : ""}
                    onValueChange={setSelected}
                    aria-label={t("vaults.picker")}
                    options={vaults.map((vault) => ({
                        value: pickerValue(vault),
                        label: vault.organizationId ? t("vaults.orgOption", { name: vault.name }) : vault.name
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
    const t = useTranslations("vault");
    const tv = useTranslations("validation");
    const tc = useTranslations("common");
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
    const issue = name.length > 0 && !parsed.success ? parsed.error.issues[0]?.message : undefined;
    const nameProblem = issue ? vaultSchemaText(t, tv, issue) : null;

    async function onCreate(): Promise<void> {
        if (!parsed.success) return;
        if (!state.publicKey) {
            setProblem(t("vaults.openOwnFirst"));
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
                collectionName: await vaultCrypto.encrypt(t("vaults.generalCollection"), vaultKey)
            });
            if (result.error || !result.vaultId) {
                setProblem(result.error ?? t("vaults.notCreated"));
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
                    <DialogTitle>{t("vaults.newVault")}</DialogTitle>
                    <DialogDescription>
                        {t("vaults.newIntro")}
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
                        placeholder={t("vaults.namePlaceholder")}
                        aria-label={t("vaults.nameLabel")}
                        autoFocus
                        maxLength={core.VAULT_NAME_MAX}
                    />
                    {nameProblem ? <p className="text-sm text-danger">{nameProblem}</p> : null}
                    {problem ? <p className="text-sm text-danger">{problem}</p> : null}
                    <DialogFooter>
                        <Button type="button" variant="secondary" onClick={onClose}>
                            {tc("actions.cancel")}
                        </Button>
                        <Button type="submit" disabled={pending || !parsed.success}>
                            {pending ? (
                                <Loader2 className="size-4 animate-spin" />
                            ) : (
                                <Plus className="size-4" />
                            )}
                            {t("vaults.create")}
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
    const t = useTranslations("vault");
    return (
        <Card>
            <CardHeader>
                <CardTitle>{t("vaults.ownTitle")}</CardTitle>
            </CardHeader>
            <CardBody className="flex flex-col gap-3 text-[0.8125rem] text-muted-foreground">
                <p>
                    {t("vaults.ownBody")}
                </p>
                <p>
                    {t("vaults.ownShare")}
                </p>
                <Button asChild variant="outline" size="sm" className="self-start">
                    <Link href="/vault">{t("vaults.open")}</Link>
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
    const t = useTranslations("vault");
    const [pending, setPending] = useState(false);

    if (!vault.mayAdminister) {
        return (
            <Card>
                <CardBody className="p-6 text-sm text-muted-foreground">
                    {t("vaults.orgNoVault", { name: vault.name })}
                </CardBody>
            </Card>
        );
    }

    async function onCreate(): Promise<void> {
        if (!state.publicKey || !vault.organizationId) {
            onError(t("vaults.openOwnFirst"));
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
                collectionName: await vaultCrypto.encrypt(t("vaults.sharedCollection"), orgKey)
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
                    {t("vaults.setUpFor", { name: vault.name })}
                </CardTitle>
            </CardHeader>
            <CardBody className="flex flex-col gap-3">
                <p className="text-sm text-muted-foreground">
                    {t("vaults.setUpIntro")}
                </p>
                <div className="flex justify-end">
                    <Button onClick={onCreate} disabled={pending}>
                        {pending ? (
                            <Loader2 className="size-4 animate-spin" />
                        ) : (
                            <Plus className="size-4" />
                        )}
                        {t("vaults.create")}
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
    const t = useTranslations("vault");
    const tc = useTranslations("common");
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
            onError(t("vaults.needKeys"));
            return;
        }
        setPending(true);
        onError(null);
        try {
            const theirKey = await share.memberPublicKeyAction(vaultId, member.id);
            if (theirKey.error || !theirKey.publicKey) {
                onError(theirKey.error ?? t("vaults.noKey"));
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
            title: t("vaults.removeTitle", { email: member.email }),
            description: t("vaults.removeBody"),
            confirmLabel: t("vaults.remove"),
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
            title: t("vaults.deleteCollectionTitle", { name: collection.name }),
            description: t("vaults.deleteCollectionBody"),
            confirmLabel: t("vaults.delete"),
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
            title: t("vaults.leaveTitle", { name: vault.name }),
            description: t("vaults.leaveBody"),
            confirmLabel: t("vaults.leaveConfirm"),
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
            title: t("vaults.deleteVaultTitle", { name: vault.name }),
            description: t("vaults.deleteVaultBody"),
            confirmLabel: t("vaults.deleteVault"),
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
                        {t("vaults.waiting")}
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
                            {t("vaults.collections")}
                        </CardTitle>
                    </CardHeader>
                    <CardBody className="flex flex-col gap-2">
                        <p className="text-sm text-muted-foreground">
                            {t("vaults.collectionsIntro")}
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
                                    placeholder={t("vaults.newCollection")}
                                    aria-label={t("vaults.newCollectionName")}
                                />
                                <Button
                                    type="submit"
                                    size="sm"
                                    disabled={pending || !newCollection.trim()}
                                >
                                    <FolderPlus className="size-4" />
                                    {t("vaults.add")}
                                </Button>
                            </form>
                        ) : null}
                        {collections.length === 0 ? (
                            <p className="py-2 text-sm text-muted-foreground">{t("vaults.noCollections")}</p>
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
                                                title={t("vaults.delete")}
                                                aria-label={t("vaults.deleteNamed", { name: collection.name })}
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
                        <CardTitle>{t("vaults.members")}</CardTitle>
                    </CardHeader>
                    <CardBody className="flex flex-col gap-2">
                        <p className="text-sm text-muted-foreground">
                            {t("vaults.membersIntro")}
                        </p>
                        <div className="flex items-center gap-2">
                            {vault.organizationId ? (
                                <Select
                                    value={invitee}
                                    onValueChange={setInvitee}
                                    aria-label={t("vaults.addWho")}
                                    placeholder={t("vaults.everybodyHere")}
                                    className="min-w-0 flex-1"
                                    options={candidates.map((person) => ({
                                        value: person.email,
                                        label: person.hasVault
                                            ? `${person.name} (${person.email})`
                                            : t("vaults.noVaultYet", { name: person.name }),
                                        disabled: !person.hasVault
                                    }))}
                                />
                            ) : (
                                <Input
                                    type="email"
                                    value={invitee}
                                    onChange={(event) => setInvitee(event.target.value)}
                                    placeholder={t("vaults.theirEmail")}
                                    aria-label={t("vaults.addWho")}
                                    className="min-w-0 flex-1"
                                />
                            )}
                            <Button size="sm" onClick={onInvite} disabled={pending || !invitee}>
                                <Plus className="size-4" />
                                {t("vaults.add")}
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
                                                    ? t("vaults.wholeVault")
                                                    : t("vaults.collectionCount", { count: member.collections.length })}
                                            </Badge>
                                            <Badge variant="success">{t("vaults.holdsKey")}</Badge>
                                            <Button
                                                size="icon"
                                                variant="ghost"
                                                title={t("vaults.changeScope")}
                                                aria-label={t("vaults.changeScopeNamed", { email: member.email })}
                                                onClick={() => setAccess(member)}
                                            >
                                                <Pencil className="size-4" />
                                            </Button>
                                        </>
                                    ) : (
                                        <>
                                            <Badge variant="neutral">{t("vaults.notLetIn")}</Badge>
                                            <Button
                                                size="icon"
                                                variant="ghost"
                                                title={t("vaults.letIn")}
                                                aria-label={t("vaults.letInNamed", { email: member.email })}
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
                                        title={t("vaults.remove")}
                                        aria-label={t("vaults.removeNamed", { email: member.email })}
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
                        <CardTitle>{t("vaults.thisVault")}</CardTitle>
                    </CardHeader>
                    <CardBody className="flex flex-col gap-3">
                        {renaming === null ? (
                            <div className="flex items-center gap-2">
                                <p className="min-w-0 flex-1 truncate text-sm" title={vault.name}>{vault.name}</p>
                                <Button
                                    size="icon"
                                    variant="ghost"
                                    title={t("vaults.rename")}
                                    aria-label={t("vaults.renameNamed", { name: vault.name })}
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
                                    aria-label={t("vaults.nameLabel")}
                                    maxLength={core.VAULT_NAME_MAX}
                                    autoFocus
                                />
                                <Button type="submit" size="sm" disabled={pending}>
                                    {tc("actions.save")}
                                </Button>
                                <Button
                                    type="button"
                                    size="sm"
                                    variant="secondary"
                                    onClick={() => setRenaming(null)}
                                >
                                    {tc("actions.cancel")}
                                </Button>
                            </form>
                        )}
                        <div className="flex items-center justify-between gap-2">
                            <p className="text-sm text-muted-foreground">
                                {t("vaults.deleteHint")}
                            </p>
                            <Button size="sm" variant="danger" onClick={() => void onDeleteVault()}>
                                <Trash2 className="size-4" />
                                {t("vaults.delete")}
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
                                ? t("vaults.letInOrg")
                                : t("vaults.letInPersonal")}
                        </p>
                        <Button size="sm" variant="secondary" onClick={() => void onLeave()}>
                            <LogOut className="size-4" />
                            {t("vaults.leave")}
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
    const t = useTranslations("vault");
    const tc = useTranslations("common");
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
                        {firstTime
                            ? t("vaults.letInNamed", { email: member?.email ?? "" })
                            : t("vaults.scopeOf", { email: member?.email ?? "" })}
                    </DialogTitle>
                    <DialogDescription>
                        {t("vaults.scopeIntro")}
                    </DialogDescription>
                </DialogHeader>

                <div className="flex flex-col gap-2">
                    <label className="flex items-center gap-2 text-sm">
                        <Checkbox
                            checked={whole}
                            onChange={(event) => setWhole(event.target.checked)}
                            aria-label={t("vaults.theWholeVault")}
                        />
                        {t("vaults.theWholeVault")}
                    </label>
                    {whole ? null : collections.length === 0 ? (
                        <p className="text-sm text-muted-foreground">
                            {t("vaults.nothingToPick")}
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
                                                    aria-label={t("vaults.readOnlyIn", { name: collection.name })}
                                                />
                                                {t("vaults.readOnly")}
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
                        {tc("actions.cancel")}
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
                        {firstTime ? t("vaults.letIn") : tc("actions.save")}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
