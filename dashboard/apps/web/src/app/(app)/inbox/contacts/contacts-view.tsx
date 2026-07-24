"use client";

/**
 * Contacts CRM: a master list of people (searchable, with their platform handles)
 * and a detail panel to edit a person's name, note, and the handles they can be
 * reached on. One person unifies WhatsApp / Telegram / Discord / Slack, so a chat
 * is started against a person, not a raw id. Discord handles distinguish a server
 * channel from a user DM. Mutations go through the inbox server actions.
 */

import { useCallback, useEffect, useMemo, useState, useTransition } from "react";
import { Loader2, Plus, Search, Trash2, UserPlus } from "lucide-react";
import { Button, Card, CardBody, Input, Select, cn } from "@polaris/ui";
import type { Platform } from "@polaris/messaging";
import type { ContactIdentityView, ContactView } from "@/lib/messaging-service";
import {
    addContactIdentityAction,
    createContactAction,
    deleteContactAction,
    deleteContactIdentityAction,
    listContactsAction,
    updateContactAction,
    updateContactIdentityAction
} from "../actions";
import {
    PEER_HINT,
    PLATFORM_LABEL,
    PLATFORM_LOGO,
    PLATFORM_OPTIONS,
    editablePeer
} from "../platform-meta";
import { DiscordPeerFields } from "../discord-peer-fields";

const AVATAR_TONES = [
    "#2563eb",
    "#7c3aed",
    "#db2777",
    "#e11d48",
    "#ea580c",
    "#16a34a",
    "#0891b2",
    "#4f46e5"
];

function initials(name: string): string {
    const parts = name.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return "?";
    if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
    return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

/** Deterministic tone from the name, so a person keeps the same avatar color. */
function toneFor(name: string): string {
    let hash = 0;
    for (let i = 0; i < name.length; i += 1) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
    return AVATAR_TONES[hash % AVATAR_TONES.length]!;
}

function Avatar({ name, className }: { name: string; className?: string }) {
    const tone = toneFor(name);
    return (
        <span
            className={cn("grid size-9 shrink-0 place-items-center rounded-full text-xs font-semibold", className)}
            style={{ color: tone, backgroundColor: `${tone}1f` }}
        >
            {initials(name)}
        </span>
    );
}

export function ContactsView({ initialContacts }: { initialContacts: ContactView[] }) {
    const [contacts, setContacts] = useState(initialContacts);
    const [query, setQuery] = useState("");
    const [selectedId, setSelectedId] = useState<string | null>(initialContacts[0]?.id ?? null);
    const [creating, setCreating] = useState(false);
    const [newName, setNewName] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();

    const reload = useCallback(() => {
        void listContactsAction()
            .then(setContacts)
            .catch(() => undefined);
    }, []);

    // Refresh on mount so the CRM reflects handles added elsewhere (e.g. New chat).
    useEffect(() => {
        reload();
    }, [reload]);

    const filtered = useMemo(() => {
        const term = query.trim().toLowerCase();
        if (!term) return contacts;
        return contacts.filter(
            (contact) =>
                contact.name.toLowerCase().includes(term) ||
                (contact.note ?? "").toLowerCase().includes(term) ||
                contact.identities.some((identity) => identity.peerId.toLowerCase().includes(term))
        );
    }, [contacts, query]);

    const selected = contacts.find((item) => item.id === selectedId) ?? null;

    function patch(updated: ContactView) {
        setContacts((prev) => prev.map((item) => (item.id === updated.id ? updated : item)));
    }

    function createContact() {
        const name = newName.trim();
        if (!name) return;
        setError(null);
        startTransition(async () => {
            const result = await createContactAction({ name });
            if (result.error || !result.contact) {
                setError(result.error ?? "Could not create the contact");
                return;
            }
            setContacts((prev) => [...prev, result.contact!]);
            setSelectedId(result.contact.id);
            setNewName("");
            setCreating(false);
        });
    }

    return (
        <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                    <h1 className="text-lg font-semibold">Contacts</h1>
                    <p className="text-sm text-muted-foreground">
                        One entry per person, unified across every platform they use. Pick them when starting a chat.
                    </p>
                </div>
                <Button onClick={() => setCreating((value) => !value)}>
                    <UserPlus className="size-4" /> New contact
                </Button>
            </div>

            {creating && (
                <Card>
                    <CardBody className="flex flex-wrap items-center gap-2">
                        <Input
                            className="min-w-48 flex-1"
                            autoFocus
                            value={newName}
                            onChange={(event) => setNewName(event.target.value)}
                            onKeyDown={(event) => event.key === "Enter" && createContact()}
                            placeholder="Full name"
                        />
                        <Button onClick={createContact} disabled={pending || newName.trim() === ""}>
                            {pending && <Loader2 className="size-4 animate-spin" />}
                            Add
                        </Button>
                        <Button variant="ghost" onClick={() => setCreating(false)} disabled={pending}>
                            Cancel
                        </Button>
                        {error && <p className="w-full text-sm text-danger">{error}</p>}
                    </CardBody>
                </Card>
            )}

            <div className="grid min-h-0 gap-4 lg:grid-cols-[20rem_1fr]">
                <Card className="flex max-h-[calc(100vh-16rem)] flex-col overflow-hidden">
                    <div className="border-b border-border p-2">
                        <div className="flex items-center gap-2 rounded-md border border-border px-2">
                            <Search className="size-4 text-muted-foreground" />
                            <input
                                value={query}
                                onChange={(event) => setQuery(event.target.value)}
                                placeholder="Search people"
                                className="w-full bg-transparent py-1.5 text-sm outline-none"
                            />
                        </div>
                    </div>
                    <div className="min-h-0 flex-1 overflow-y-auto">
                        {filtered.length === 0 ? (
                            <p className="p-4 text-sm text-muted-foreground">
                                {contacts.length === 0 ? "No contacts yet." : "No matches."}
                            </p>
                        ) : (
                            <ul className="divide-y divide-border">
                                {filtered.map((contact) => (
                                    <li key={contact.id}>
                                        <button
                                            type="button"
                                            onClick={() => setSelectedId(contact.id)}
                                            className={cn(
                                                "flex w-full items-center gap-3 p-2.5 text-left transition-colors hover:bg-muted",
                                                contact.id === selectedId && "bg-muted"
                                            )}
                                        >
                                            <Avatar name={contact.name} />
                                            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                                                <span className="truncate text-sm font-medium">{contact.name}</span>
                                                <span className="flex flex-wrap items-center gap-1">
                                                    {contact.identities.length === 0 ? (
                                                        <span className="text-xs text-muted-foreground">No handles</span>
                                                    ) : (
                                                        contact.identities.map((identity) => (
                                                            <PlatformDot key={identity.id} platform={identity.platform} />
                                                        ))
                                                    )}
                                                </span>
                                            </span>
                                        </button>
                                    </li>
                                ))}
                            </ul>
                        )}
                    </div>
                </Card>

                {selected ? (
                    <ContactDetail
                        key={selected.id}
                        contact={selected}
                        onChange={patch}
                        onRemoved={(id) => {
                            setContacts((prev) => prev.filter((item) => item.id !== id));
                            setSelectedId((current) => (current === id ? null : current));
                        }}
                    />
                ) : (
                    <Card>
                        <CardBody className="grid min-h-48 place-items-center text-sm text-muted-foreground">
                            Select a contact, or add one.
                        </CardBody>
                    </Card>
                )}
            </div>
        </div>
    );
}

function PlatformDot({ platform }: { platform: string }) {
    const meta = PLATFORM_LOGO[platform];
    const Logo = meta?.Logo;
    return (
        <span
            className="grid size-4 place-items-center"
            style={{ color: meta?.color }}
            title={PLATFORM_LABEL[platform] ?? platform}
        >
            {Logo ? <Logo className="size-3.5" /> : null}
        </span>
    );
}

function ContactDetail({
    contact,
    onChange,
    onRemoved
}: {
    contact: ContactView;
    onChange: (contact: ContactView) => void;
    onRemoved: (id: string) => void;
}) {
    const [name, setName] = useState(contact.name);
    const [note, setNote] = useState(contact.note ?? "");
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();

    useEffect(() => {
        setName(contact.name);
        setNote(contact.note ?? "");
    }, [contact.id, contact.name, contact.note]);

    function run(op: () => Promise<{ error?: string; contact?: ContactView }>) {
        setError(null);
        startTransition(async () => {
            const result = await op();
            if (result.error) {
                setError(result.error);
                return;
            }
            if (result.contact) onChange(result.contact);
        });
    }

    const detailsDirty = name.trim() !== contact.name || (note.trim() || "") !== (contact.note ?? "");

    return (
        <Card>
            <CardBody className="flex flex-col gap-5">
                <div className="flex items-start gap-3">
                    <Avatar name={contact.name} className="size-12 text-sm" />
                    <div className="min-w-0 flex-1">
                        <h2 className="truncate text-base font-semibold">{contact.name}</h2>
                        <p className="text-xs text-muted-foreground">
                            {contact.identities.length} handle{contact.identities.length === 1 ? "" : "s"}
                        </p>
                    </div>
                    <Button
                        variant="ghost"
                        size="sm"
                        className="text-danger"
                        disabled={pending}
                        onClick={() =>
                            startTransition(async () => {
                                const result = await deleteContactAction(contact.id);
                                if (result.error) setError(result.error);
                                else onRemoved(contact.id);
                            })
                        }
                    >
                        <Trash2 className="size-4" /> Delete
                    </Button>
                </div>

                <div className="grid gap-3 sm:grid-cols-2">
                    <label className="flex flex-col gap-1 text-sm">
                        <span className="font-medium">Name</span>
                        <Input value={name} onChange={(event) => setName(event.target.value)} />
                    </label>
                    <label className="flex flex-col gap-1 text-sm">
                        <span className="font-medium">Note</span>
                        <Input value={note} onChange={(event) => setNote(event.target.value)} placeholder="Optional" />
                    </label>
                </div>
                {detailsDirty && (
                    <div className="flex justify-end">
                        <Button
                            size="sm"
                            disabled={pending || name.trim() === ""}
                            onClick={() =>
                                run(() =>
                                    updateContactAction({ id: contact.id, name: name.trim(), note: note.trim() || null })
                                )
                            }
                        >
                            Save details
                        </Button>
                    </div>
                )}

                <div className="flex flex-col gap-2">
                    <span className="text-sm font-medium">Handles</span>
                    {contact.identities.length === 0 ? (
                        <p className="text-xs text-muted-foreground">No handles yet. Add one below to start chats.</p>
                    ) : (
                        contact.identities.map((identity) => (
                            <HandleRow
                                key={identity.id}
                                identity={identity}
                                disabled={pending}
                                onSave={(platform, peerId) =>
                                    run(() =>
                                        updateContactIdentityAction({ identityId: identity.id, platform, peerId })
                                    )
                                }
                                onRemove={() => run(() => deleteContactIdentityAction(identity.id))}
                            />
                        ))
                    )}
                    <AddHandle
                        disabled={pending}
                        onAdd={(platform, peerId) =>
                            run(() => addContactIdentityAction({ contactId: contact.id, platform, peerId }))
                        }
                    />
                </div>

                {error && <p className="text-sm text-danger">{error}</p>}
            </CardBody>
        </Card>
    );
}

/** The platform + recipient inputs for a handle. Discord splits into a target
 *  toggle (server channel vs user DM) and an id; other platforms take one field
 *  seeded with the human form. Reports back the encoded, save-ready peer id. */
function PeerFields({
    platform,
    draft,
    onDraft
}: {
    platform: Platform;
    draft: string;
    onDraft: (value: string) => void;
}) {
    if (platform === "discord") {
        return <DiscordPeerFields draft={draft} onDraft={onDraft} />;
    }
    return (
        <div className="flex flex-1 flex-col gap-1">
            <Input
                value={draft}
                onChange={(event) => onDraft(event.target.value)}
                placeholder={PEER_HINT[platform] ?? "Number or id"}
            />
        </div>
    );
}

function HandleRow({
    identity,
    disabled,
    onSave,
    onRemove
}: {
    identity: ContactIdentityView;
    disabled: boolean;
    onSave: (platform: Platform, peerId: string) => void;
    onRemove: () => void;
}) {
    const [platform, setPlatform] = useState<Platform>(identity.platform as Platform);
    const [draft, setDraft] = useState(editablePeer(identity.platform, identity.peerId));

    useEffect(() => {
        setPlatform(identity.platform as Platform);
        setDraft(editablePeer(identity.platform, identity.peerId));
    }, [identity.platform, identity.peerId]);

    const dirty = platform !== identity.platform || draft.trim() !== editablePeer(identity.platform, identity.peerId);

    return (
        <div className="flex items-start gap-2">
            <div className="w-32 shrink-0">
                <Select
                    value={platform}
                    onValueChange={(value) => {
                        setPlatform(value as Platform);
                        setDraft("");
                    }}
                    options={PLATFORM_OPTIONS}
                />
            </div>
            <PeerFields platform={platform} draft={draft} onDraft={setDraft} />
            {dirty && (
                <Button
                    size="sm"
                    disabled={disabled || draft.trim() === ""}
                    onClick={() => onSave(platform, draft.trim())}
                >
                    Save
                </Button>
            )}
            <button
                type="button"
                aria-label="Remove handle"
                className="mt-1.5 text-muted-foreground hover:text-danger disabled:opacity-50"
                disabled={disabled}
                onClick={onRemove}
            >
                <Trash2 className="size-4" />
            </button>
        </div>
    );
}

function AddHandle({
    disabled,
    onAdd
}: {
    disabled: boolean;
    onAdd: (platform: Platform, peerId: string) => void;
}) {
    const [platform, setPlatform] = useState<Platform>("whatsapp");
    const [draft, setDraft] = useState("");

    return (
        <div className="flex items-start gap-2 border-t border-border pt-2">
            <div className="w-32 shrink-0">
                <Select
                    value={platform}
                    onValueChange={(value) => {
                        setPlatform(value as Platform);
                        setDraft("");
                    }}
                    options={PLATFORM_OPTIONS}
                />
            </div>
            <PeerFields platform={platform} draft={draft} onDraft={setDraft} />
            <Button
                size="sm"
                variant="secondary"
                disabled={disabled || draft.trim() === ""}
                onClick={() => {
                    onAdd(platform, draft.trim());
                    setDraft("");
                }}
            >
                <Plus className="size-4" /> Add
            </Button>
        </div>
    );
}
