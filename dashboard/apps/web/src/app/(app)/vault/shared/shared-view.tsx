"use client";

/**
 * The shared vaults: an organization's passwords rather than one person's.
 *
 * Two things happen here that cannot happen anywhere else, and both need a
 * browser holding an unlocked vault:
 *
 *  - **Creating one.** The organization's key is minted here and immediately
 *    wrapped to the creator's own public key, so the server receives a vault it
 *    cannot open from the first second it exists.
 *  - **Confirming somebody.** Being on the roster puts a person on the list;
 *    what lets them read anything is an administrator's browser unwrapping the
 *    organization's key and wrapping it again to that person's public key.
 *    Nothing on the server can do that step, which is the point of it.
 */

import Link from "next/link";
import { useEffect, useState } from "react";
import * as vaultCrypto from "@/lib/vault/crypto";
import { useVaultSession } from "../vault-session";
import { useConfirm } from "@/components/confirm-dialog";
import { Building2, Check, FolderPlus, Loader2, Plus, ShieldCheck, Trash2, X } from "lucide-react";
import { Badge, Button, Card, CardBody, CardHeader, CardTitle, Input, Select } from "@polaris/ui";
import * as share from "../share-actions";
import type { VaultOrgView } from "../share-actions";

interface MemberRow {
    id: string;
    email: string;
    name: string | null;
    status: number;
}

interface CollectionRow {
    id: string;
    name: string;
}

export function SharedView() {
    const { organizations, orgKeys, key, privateKey, reloadOrgs } = useVaultSession();
    const [selected, setSelected] = useState<string>("");
    const [error, setError] = useState<string | null>(null);

    const current =
        organizations.find((org) => org.organizationId === selected) ?? organizations[0] ?? null;

    useEffect(() => {
        if (!selected && organizations[0]) setSelected(organizations[0].organizationId);
    }, [organizations, selected]);

    if (organizations.length === 0) {
        return (
            <div className="mx-auto flex max-w-3xl flex-col gap-4">
                <Header />
                <Card>
                    <CardBody className="flex flex-col items-start gap-3 p-6">
                        <p className="text-sm text-muted-foreground">
                            You are not in an organization yet. A shared vault belongs to one.
                        </p>
                        <Button asChild size="sm">
                            <Link href="/account/organizations">Organizations</Link>
                        </Button>
                    </CardBody>
                </Card>
            </div>
        );
    }

    return (
        <div className="mx-auto flex max-w-3xl flex-col gap-4">
            <Header />
            <Select
                value={current?.organizationId ?? ""}
                onValueChange={setSelected}
                aria-label="Organization"
                options={organizations.map((org) => ({
                    value: org.organizationId,
                    label: org.name
                }))}
            />
            {error ? <p className="text-sm text-danger">{error}</p> : null}
            {current ? (
                current.vaultOrgId === null ? (
                    <CreateVault org={current} onError={setError} onCreated={reloadOrgs} />
                ) : (
                    <OrgVault
                        org={current}
                        orgKey={orgKeys.get(current.vaultOrgId) ?? null}
                        hasPersonalKey={key !== null && privateKey !== null}
                        onError={setError}
                    />
                )
            ) : null}
        </div>
    );
}

function Header() {
    return (
        <div>
            <h1 className="text-lg font-semibold">Shared vaults</h1>
            <p className="text-sm text-muted-foreground">
                An organization&apos;s passwords, encrypted under its own key. Your own vault stays
                yours.
            </p>
        </div>
    );
}

/** Give an organization a vault. Every key in it is minted here. */
function CreateVault({
    org,
    onError,
    onCreated
}: {
    org: VaultOrgView;
    onError: (message: string | null) => void;
    onCreated: () => Promise<void>;
}) {
    const { key, state } = useVaultSession();
    const [pending, setPending] = useState(false);

    if (!org.mayAdminister) {
        return (
            <Card>
                <CardBody className="p-6 text-sm text-muted-foreground">
                    {org.name} has no shared vault yet, and setting one up is not something your
                    role there can do.
                </CardBody>
            </Card>
        );
    }

    async function onCreate(): Promise<void> {
        if (!key || !state.publicKey) {
            onError("Your own vault has to be open first.");
            return;
        }
        setPending(true);
        onError(null);
        try {
            // The organization's own key and pair. The key is wrapped to the
            // creator's PUBLIC key rather than to their vault key, because that
            // is the same envelope every other member will be handed later.
            const orgKey = vaultCrypto.generateSymmetricKey();
            const pair = await vaultCrypto.generateRsaKeyPair();
            const result = await share.createOrganizationVaultAction({
                organizationId: org.organizationId,
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
                    Set up a vault for {org.name}
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

/** One organization's vault: its collections and who is in it. */
function OrgVault({
    org,
    orgKey,
    hasPersonalKey,
    onError
}: {
    org: VaultOrgView;
    orgKey: vaultCrypto.SymmetricKey | null;
    hasPersonalKey: boolean;
    onError: (message: string | null) => void;
}) {
    const { privateKey } = useVaultSession();
    const [members, setMembers] = useState<MemberRow[]>([]);
    const [candidates, setCandidates] = useState<
        { userId: string; name: string; email: string; hasVault: boolean }[]
    >([]);
    const [collections, setCollections] = useState<CollectionRow[]>([]);
    const [newCollection, setNewCollection] = useState("");
    const [invitee, setInvitee] = useState("");
    const [pending, setPending] = useState(false);
    const [confirm, confirmDialog] = useConfirm();

    async function reload(): Promise<void> {
        if (org.mayAdminister) {
            const result = await share.vaultOrgMembersAction(org.organizationId);
            if (result.error) onError(result.error);
            setMembers(
                (result.members ?? []).map((row) => ({
                    id: String(row.id ?? ""),
                    email: String(row.email ?? ""),
                    name: typeof row.name === "string" ? row.name : null,
                    status: Number(row.status ?? 0)
                }))
            );
            setCandidates(result.candidates ?? []);
        }
        const list = await share.vaultCollectionsAction(org.organizationId);
        if (!orgKey) {
            setCollections([]);
            return;
        }
        const opened: CollectionRow[] = [];
        for (const raw of list.collections ?? []) {
            opened.push({
                id: String(raw.id ?? ""),
                name: (await vaultCrypto.decrypt(String(raw.name ?? ""), orgKey)) ?? "Untitled"
            });
        }
        setCollections(opened);
    }

    useEffect(() => {
        void reload();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [org.organizationId, orgKey]);

    /**
     * Vouch for somebody: unwrap the organization's key here and wrap it again
     * to them. This is the only step that turns a name on a list into access.
     */
    async function onConfirmMember(member: MemberRow): Promise<void> {
        if (!orgKey || !privateKey || !hasPersonalKey) {
            onError("Your own vault has to be open, and you have to hold this vault's key.");
            return;
        }
        setPending(true);
        onError(null);
        try {
            const theirKey = await share.memberPublicKeyAction(org.organizationId, member.id);
            if (theirKey.error || !theirKey.publicKey) {
                onError(theirKey.error ?? "That person has no key to wrap this to.");
                return;
            }
            const wrapped = await vaultCrypto.encryptRsa(
                vaultCrypto.symmetricKeyBytes(orgKey),
                theirKey.publicKey
            );
            const result = await share.confirmVaultMemberAction(
                org.organizationId,
                member.id,
                wrapped
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

    async function onInvite(): Promise<void> {
        if (!invitee) return;
        setPending(true);
        onError(null);
        const result = await share.inviteVaultMemberAction(org.organizationId, invitee, 2);
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
        const result = await share.removeVaultMemberAction(org.organizationId, member.id);
        if (result.error) {
            onError(result.error);
            return;
        }
        await reload();
    }

    async function onAddCollection(): Promise<void> {
        const name = newCollection.trim();
        if (!name || !orgKey) return;
        setPending(true);
        onError(null);
        const result = await share.saveVaultCollectionAction(
            org.organizationId,
            null,
            await vaultCrypto.encrypt(name, orgKey)
        );
        setPending(false);
        if (result.error) {
            onError(result.error);
            return;
        }
        setNewCollection("");
        await reload();
    }

    async function onDeleteCollection(collection: CollectionRow): Promise<void> {
        const confirmed = await confirm({
            title: `Delete the collection "${collection.name}"?`,
            description:
                "What is in it is not deleted. It stops being shared through this collection, which may leave it reachable only by an administrator.",
            confirmLabel: "Delete",
            danger: true
        });
        if (!confirmed) return;
        const result = await share.deleteVaultCollectionAction(org.organizationId, collection.id);
        if (result.error) {
            onError(result.error);
            return;
        }
        await reload();
    }

    return (
        <>
            {!orgKey ? (
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
                        <CardTitle>Collections</CardTitle>
                    </CardHeader>
                    <CardBody className="flex flex-col gap-2">
                        <p className="text-sm text-muted-foreground">
                            Where a shared item lives. Sharing something into one is done from the
                            item itself.
                        </p>
                        {org.mayAdminister ? (
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
                            <p className="py-2 text-sm text-muted-foreground">
                                No collections yet.
                            </p>
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
                                        {org.mayAdminister ? (
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

            {org.mayAdminister ? (
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
                                    {member.status === 2 ? (
                                        <Badge variant="success">Holds the key</Badge>
                                    ) : (
                                        <Badge variant="neutral">Not let in yet</Badge>
                                    )}
                                    {member.status !== 2 ? (
                                        <Button
                                            size="icon"
                                            variant="ghost"
                                            title="Let them in"
                                            aria-label={`Let ${member.email} in`}
                                            disabled={pending || !orgKey}
                                            onClick={() => void onConfirmMember(member)}
                                        >
                                            {pending ? (
                                                <Loader2 className="size-4 animate-spin" />
                                            ) : (
                                                <ShieldCheck className="size-4" />
                                            )}
                                        </Button>
                                    ) : (
                                        <Check className="size-4 shrink-0 text-success" />
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
            {confirmDialog}
        </>
    );
}
