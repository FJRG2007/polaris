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
import { RecoveryCodes } from "./recovery-codes";
import { PasswordState } from "@/components/password-state";
import {
    AmexMark,
    DinersClubMark,
    DiscoverMark,
    JcbMark,
    MastercardMark,
    VisaMark
} from "@/components/brand-icons";
import { parseTotp } from "@/lib/vault/totp-browser";
import {
    FolderPlus,
    Loader2,
    Lock,
    LockOpen,
    Plus,
    QrCode,
    RefreshCw,
    Trash2,
    UserRound,
    X
} from "lucide-react";
import {
    ITEM_API_KEY,
    ITEM_KINDS,
    emptyItem,
    itemKind,
    managedFieldNames,
    type VaultFolder,
    type VaultItem
} from "./vault-model";
import { IDENTITY_GROUPS, identityHintKey, identityLabelKey } from "./identity-fields";
import { cipherTypeLabel, uriMatchLabel } from "./vault-labels";
import { accountIdentityAction } from "./vault-actions";
import type { AccountIdentity } from "@/lib/vault/account-identity";
import type { NamespaceKey } from "@/lib/i18n/types";
import { useTranslations } from "@/components/i18n/i18n-provider";
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

/**
 * What core says is wrong with a website or a card number, in the reader's
 * language. Core words its answers in English for every caller; keyed by those
 * words so a new one core learns to say still reaches the screen, in English,
 * rather than nothing.
 */
const PROBLEM_KEYS: Record<string, NamespaceKey<"vault">> = {
    "That pattern will not compile, so it would never match anything.": "item.problems.pattern",
    "That does not look like a web address.": "item.problems.notAddress",
    "That is more digits than a card number has.": "item.problems.tooLong",
    "Those digits do not add up - one of them is probably wrong.": "item.problems.luhn"
};

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
    const t = useTranslations("vault");
    const tc = useTranslations("common");
    const problem = (said: string | null): string | null => {
        if (!said) return null;
        const key = PROBLEM_KEYS[said];
        return key ? t(key) : said;
    };
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
    /** The recovery codes, one per line with a leading dash for a used one. A
     *  hidden custom field, so they are encrypted like the password and read as
     *  a field by any other client. */
    const [codes, setCodes] = useState("");
    /** A login's email, apart from its username - a custom field to every
     *  other client (`EMAIL_FIELD`). */
    const [email, setEmail] = useState("");
    /** An API key's parts, kept in custom fields - see `API_KEY_FIELDS`. */
    const [apiKey, setApiKey] = useState<core.ApiKeyParts>({ key: "", secret: "", endpoint: "" });
    const [newFolder, setNewFolder] = useState<string | null>(null);
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [collectionId, setCollectionId] = useState("");
    /** The addresses on this account, once an identity has been started from
     *  it, so the email can be picked from them as well as typed. */
    const [accountEmails, setAccountEmails] = useState<string[]>([]);
    const [fromAccount, setFromAccount] = useState<"idle" | "loading" | "failed">("idle");
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
        // An API key is edited as its own kind and stored as the note it is.
        setDraft(itemKind(item) === ITEM_API_KEY ? { ...item, type: ITEM_API_KEY } : item);
        setGenerator(false);
        setScanning(false);
        setNewFolder(null);
        setError(null);
        setAccountEmails([]);
        setFromAccount("idle");
        // The one-box expiry and the bank are drawn from what was stored: two
        // fields the cipher model has, and one custom field it does not.
        setExpiry(
            item.card.expMonth || item.card.expYear
                ? core.writeCardExpiry({ month: item.card.expMonth, year: item.card.expYear })
                : ""
        );
        setBank(core.fieldValue(item.fields, core.BANK_FIELD));
        setCodes(core.fieldValue(item.fields, core.RECOVERY_CODES_FIELD));
        setEmail(core.fieldValue(item.fields, core.EMAIL_FIELD));
        setApiKey(core.readApiKey(item.fields));
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
                ? { tone: "danger" as const, text: t("item.expiry.notAMonth") }
                : null;
        }
        const stored = { month: draft.card.expMonth, year: draft.card.expYear };
        const now = new Date();
        if (core.cardExpired(stored, now)) {
            return { tone: "danger" as const, text: t("item.expiry.expired") };
        }
        if (core.cardExpiringSoon(stored, now)) {
            return { tone: "warning" as const, text: t("item.expiry.soon") };
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
            setError(t("item.folderFailed"));
            return;
        }
        patch({ folderId: id });
        setNewFolder(null);
    }

    function patch(changes: Partial<VaultItem>): void {
        setDraft((prev) => ({ ...prev, ...changes }));
    }

    /**
     * Start the identity from what the account already says: the name, the
     * company, the phone and the first email. Only into boxes still empty -
     * what somebody typed before pressing it is theirs.
     */
    async function fillFromAccount(): Promise<void> {
        setFromAccount("loading");
        const known: AccountIdentity | null = await accountIdentityAction().catch(() => null);
        if (!known) {
            setFromAccount("failed");
            return;
        }
        setFromAccount("idle");
        setAccountEmails(known.emails);
        setDraft((prev) => {
            const offered: Record<string, string> = {
                firstName: known.firstName,
                lastName: known.lastName,
                company: known.company,
                phone: known.phone,
                username: known.username,
                email: known.emails[0] ?? ""
            };
            const identity = { ...prev.identity };
            for (const [field, value] of Object.entries(offered)) {
                if (!identity[field] && value) identity[field] = value;
            }
            const whole = [identity.firstName, identity.lastName].filter(Boolean).join(" ");
            return { ...prev, name: prev.name || whole, identity };
        });
    }

    async function onSubmit(): Promise<void> {
        const intoVault = !draft.id && draft.organizationId !== null;
        if (intoVault && !collectionId) {
            setError(t("item.pickCollection"));
            return;
        }
        setPending(true);
        setError(null);
        // The conventions that live in custom fields are folded in here rather
        // than kept in the draft as it is edited: they are one value each, and
        // the field list is what actually gets stored.
        // Each one only when it changed, so an item opened and saved again
        // keeps its field list exactly as it was.
        const saving: VaultItem =
            draft.type === ITEM_API_KEY
                ? {
                      ...draft,
                      type: core.CIPHER_SECURE_NOTE,
                      fields: core.writeApiKey(draft.fields, apiKey)
                  }
                : { ...draft, fields: foldFields(draft) };
        const failure = await onSave(saving, intoVault ? [collectionId] : []);
        setPending(false);
        if (failure) {
            setError(failure);
            return;
        }
        onClose();
    }

    /** The custom fields a card or a login keeps its extra boxes in. */
    function foldFields(from: VaultItem): VaultItem["fields"] {
        if (from.type === core.CIPHER_CARD) {
            return core.withChangedField(from.fields, core.BANK_FIELD, bank, core.FIELD_TEXT);
        }
        if (from.type !== core.CIPHER_LOGIN) return from.fields;
        // Hidden, because a recovery code is a password and belongs behind the
        // same press as one.
        const withCodes = core.withChangedField(
            from.fields,
            core.RECOVERY_CODES_FIELD,
            codes,
            core.FIELD_HIDDEN
        );
        return core.withChangedField(withCodes, core.EMAIL_FIELD, email.trim(), core.FIELD_TEXT);
    }

    /** The custom fields drawn as name and value: everything this form has no
     *  box of its own for. */
    const managed = managedFieldNames(draft);

    return (
        <Dialog open={item !== null} onOpenChange={(open) => !open && onClose()}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>{draft.id ? t("item.editTitle") : t("item.newTitle")}</DialogTitle>
                    <DialogDescription>{t("item.description")}</DialogDescription>
                </DialogHeader>

                <div className="flex max-h-[65vh] flex-col gap-3 overflow-y-auto overscroll-contain pr-1">
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                        <label className="flex min-w-0 flex-col gap-1 text-sm">
                            {t("item.kind")}
                            <Select
                                value={String(draft.type)}
                                onValueChange={(value) => patch({ type: Number(value) })}
                                options={ITEM_KINDS.map((type) => ({
                                    value: String(type),
                                    label: cipherTypeLabel(t, type)
                                }))}
                                aria-label={t("item.kind")}
                                disabled={Boolean(draft.id)}
                            />
                        </label>
                        <label className="flex min-w-0 flex-col gap-1 text-sm">
                            {t("item.folder")}
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
                                    { value: "", label: t("item.noFolder") },
                                    ...folders.map((folder) => ({
                                        value: folder.id,
                                        label: folder.name || t("labels.untitled")
                                    })),
                                    { value: NEW_FOLDER, label: t("item.newFolder") }
                                ]}
                                aria-label={t("item.folder")}
                            />
                        </label>
                    </div>

                    {/* Which vault it goes in, and where inside it. Only for a new
                        item: moving one that exists re-encrypts it under another
                        key, which is what the move dialog is for. */}
                    {choosable.length > 0 ? (
                        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                            <label className="flex min-w-0 flex-col gap-1 text-sm">
                                {t("item.vault")}
                                <Select
                                    value={draft.organizationId ?? ""}
                                    onValueChange={(value) =>
                                        patch({ organizationId: value || null })
                                    }
                                    aria-label={t("item.vault")}
                                    options={[
                                        { value: "", label: t("item.myVault") },
                                        ...choosable.map((vault) => ({
                                            value: vault.vaultId ?? "",
                                            label: vault.name
                                        }))
                                    ]}
                                />
                            </label>
                            {draft.organizationId ? (
                                <label className="flex min-w-0 flex-col gap-1 text-sm">
                                    {t("item.collection")}
                                    <Select
                                        value={collectionId}
                                        onValueChange={setCollectionId}
                                        aria-label={t("item.collection")}
                                        placeholder={t("item.noCollections")}
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
                                className="min-w-0 flex-1"
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
                                placeholder={t("item.folderName")}
                                aria-label={t("item.folderNameLabel")}
                            />
                            <Button
                                type="button"
                                size="sm"
                                className="shrink-0"
                                disabled={pending || newFolder.trim().length === 0}
                                onClick={() => void createFolder()}
                            >
                                <FolderPlus className="size-4" />
                                {t("item.create")}
                            </Button>
                            <Button
                                type="button"
                                size="icon"
                                variant="ghost"
                                className="shrink-0"
                                title={tc("actions.cancel")}
                                aria-label={t("item.cancelFolder")}
                                onClick={() => setNewFolder(null)}
                            >
                                <X className="size-4" />
                            </Button>
                        </div>
                    ) : null}

                    <label className="flex flex-col gap-1 text-sm">
                        {t("item.name")}
                        <Input
                            value={draft.name}
                            onChange={(event) => patch({ name: event.target.value })}
                            placeholder={t("item.namePlaceholder")}
                            autoFocus
                        />
                    </label>

                    {draft.type === core.CIPHER_LOGIN ? (
                        <>
                            <label className="flex flex-col gap-1 text-sm">
                                {t("item.username")}
                                <Input
                                    value={draft.login.username}
                                    onChange={(event) =>
                                        patch({
                                            login: { ...draft.login, username: event.target.value }
                                        })
                                    }
                                    autoComplete="off"
                                    spellCheck={false}
                                />
                            </label>
                            {/* Apart from the username: a site that signs you in
                                by handle still writes to an address, and which
                                one is worth keeping with the login. */}
                            <label className="flex flex-col gap-1 text-sm">
                                {t("item.email")}
                                <Input
                                    type="email"
                                    inputMode="email"
                                    value={email}
                                    onChange={(event) => setEmail(event.target.value)}
                                    placeholder={t("item.emailPlaceholder")}
                                    autoComplete="off"
                                    spellCheck={false}
                                />
                            </label>
                            <label className="flex flex-col gap-1 text-sm">
                                {t("item.password")}
                                <div className="flex items-center gap-2">
                                    {/* The Input carries its own show/hide eye. */}
                                    <div className="min-w-0 flex-1">
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
                                        className="shrink-0"
                                        title={t("item.generateOne")}
                                        aria-label={t("item.generatePassword")}
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
                                    {generator ? t("item.hideGenerator") : t("item.openGenerator")}
                                </button>
                            </label>
                            {/* What is true about it, while it is being chosen.
                                Strength is arithmetic about its shape; the
                                breach answer is a fact about the world, and no
                                amount of strength fixes it. */}
                            <PasswordState password={draft.login.password} />
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
                                <span>{t("item.totp")}</span>
                                <div className="flex items-center gap-2">
                                    <Input
                                        className="min-w-0 flex-1 font-mono text-xs"
                                        value={draft.login.totp}
                                        onChange={(event) =>
                                            patch({
                                                login: { ...draft.login, totp: event.target.value }
                                            })
                                        }
                                        placeholder={t("item.totpPlaceholder")}
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
                                        className="shrink-0"
                                        onClick={() => setScanning(true)}
                                    >
                                        <QrCode className="size-4 shrink-0" />
                                        {t("item.scan")}
                                    </Button>
                                </div>
                                {draft.login.totp.trim() && !parseTotp(draft.login.totp) ? (
                                    // Said while it is being typed rather than
                                    // when the code fails to appear later: a key
                                    // that cannot be read is a two-factor login
                                    // somebody thinks they have saved.
                                    <span className="text-xs text-danger">
                                        {t("item.totpUnreadable")}
                                    </span>
                                ) : null}
                            </div>
                            <div className="flex flex-col gap-1 text-sm">
                                <span>{t("item.recoveryCodes")}</span>
                                <span className="text-xs text-muted-foreground">
                                    {t("item.recoveryHint")}
                                </span>
                                {/* Encrypted exactly like the password and the
                                    authenticator key: it is a hidden field, which
                                    is what a recovery code is. */}
                                <RecoveryCodes value={codes} onChange={setCodes} />
                            </div>

                            {/* Several, because one login is rarely one URL: the
                                site, its accounts subdomain, and the app whose
                                callback is something else again. A vault that
                                held one is a vault where the same credential
                                gets saved three times. */}
                            <div className="flex flex-col gap-1 text-sm">
                                <span>{t("item.websites")}</span>
                                <div className="flex flex-col gap-2">
                                    {(draft.login.uris.length > 0
                                        ? draft.login.uris
                                        : [{ uri: "", match: null }]
                                    ).map((entry, index) => (
                                        <div key={index} className="flex flex-col gap-1">
                                            <div className="flex items-center gap-2">
                                                <Input
                                                    className="min-w-0 flex-1"
                                                    value={entry.uri}
                                                    onChange={(event) =>
                                                        patch({
                                                            login: {
                                                                ...draft.login,
                                                                uris: replaceUri(
                                                                    draft.login.uris,
                                                                    index,
                                                                    {
                                                                        ...entry,
                                                                        uri: event.target.value
                                                                    }
                                                                )
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
                                                    className="shrink-0"
                                                    aria-label={t("item.removeWebsite")}
                                                    title={t("item.removeWebsite")}
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
                                                    {problem(
                                                        core.uriProblem(entry.uri, entry.match)
                                                    )}
                                                </span>
                                            ) : null}
                                            {/* The rule is only worth a line once
                                                there is an address for it to be
                                                about. */}
                                            {entry.uri.trim() ? (
                                                <Select
                                                    className="h-7 text-xs"
                                                    aria-label={t("item.whenOffered")}
                                                    value={String(
                                                        entry.match ?? core.DEFAULT_URI_MATCH
                                                    )}
                                                    onValueChange={(next) =>
                                                        patch({
                                                            login: {
                                                                ...draft.login,
                                                                uris: replaceUri(
                                                                    draft.login.uris,
                                                                    index,
                                                                    {
                                                                        ...entry,
                                                                        match: core.readUriMatch(
                                                                            Number(next)
                                                                        )
                                                                    }
                                                                )
                                                            }
                                                        })
                                                    }
                                                    options={core.URI_MATCHES.map((match) => ({
                                                        value: String(match),
                                                        label: uriMatchLabel(t, match)
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
                                                uris: [
                                                    ...draft.login.uris,
                                                    { uri: "", match: null }
                                                ]
                                            }
                                        })
                                    }
                                >
                                    <Plus className="size-4 shrink-0" />
                                    {t("item.anotherWebsite")}
                                </Button>
                            </div>
                        </>
                    ) : null}

                    {draft.type === core.CIPHER_CARD ? (
                        <>
                            <label className="flex flex-col gap-1 text-sm">
                                {t("item.cardName")}
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
                                <span>{t("item.number")}</span>
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
                                        {problem(core.cardNumberProblem(draft.card.number))}
                                    </span>
                                ) : draft.card.brand ? (
                                    <span className="text-xs text-muted-foreground">
                                        {draft.card.brand}
                                    </span>
                                ) : null}
                            </div>
                            <div className="grid grid-cols-1 gap-3 min-[400px]:grid-cols-2">
                                <div className="flex min-w-0 flex-col gap-1 text-sm">
                                    {/* One box, because a card prints one. People
                                        type 0830, 08/30 or 08 / 2030 and all of
                                        them mean the same August. */}
                                    <span>{t("item.expires")}</span>
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
                                        placeholder={t("item.expiryPlaceholder")}
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
                                <label className="flex min-w-0 flex-col gap-1 text-sm">
                                    {t("item.securityCode")}
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
                                {t("item.bank")}
                                <Input
                                    value={bank}
                                    onChange={(event) => setBank(event.target.value)}
                                    placeholder={t("item.bankPlaceholder")}
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
                            {draft.id ? null : (
                                <div className="flex flex-wrap items-center gap-2">
                                    <Button
                                        type="button"
                                        size="sm"
                                        variant="secondary"
                                        disabled={fromAccount === "loading"}
                                        onClick={() => void fillFromAccount()}
                                    >
                                        {fromAccount === "loading" ? (
                                            <Loader2 className="size-4 animate-spin" />
                                        ) : (
                                            <UserRound className="size-4" />
                                        )}
                                        {t("identity.fromAccount")}
                                    </Button>
                                    {fromAccount === "failed" ? (
                                        <p role="alert" className="text-xs text-destructive">
                                            {t("identity.fromAccountFailed")}
                                        </p>
                                    ) : null}
                                </div>
                            )}
                            {IDENTITY_GROUPS.map((group) => (
                                <fieldset key={group.id} className="flex flex-col gap-2">
                                    <legend className="text-xs font-medium text-muted-foreground">
                                        {t(`identity.groups.${group.id}`)}
                                    </legend>
                                    <div className="grid grid-cols-1 gap-3 min-[400px]:grid-cols-2">
                                        {group.fields.map(({ field, span }) => (
                                            <label
                                                key={field}
                                                className={cn(
                                                    "flex min-w-0 flex-col gap-1 text-sm",
                                                    span === "full" && "min-[400px]:col-span-2"
                                                )}
                                            >
                                                {t(identityLabelKey(field))}
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
                                                    placeholder={(() => {
                                                        const hint = identityHintKey(field);
                                                        return hint ? t(hint) : undefined;
                                                    })()}
                                                    autoComplete="off"
                                                />
                                                {field === "email" && accountEmails.length > 1 ? (
                                                    <Select
                                                        value={
                                                            accountEmails.includes(
                                                                draft.identity.email ?? ""
                                                            )
                                                                ? (draft.identity.email ?? "")
                                                                : ""
                                                        }
                                                        onValueChange={(email) =>
                                                            patch({
                                                                identity: {
                                                                    ...draft.identity,
                                                                    email
                                                                }
                                                            })
                                                        }
                                                        options={accountEmails.map((email) => ({
                                                            value: email,
                                                            label: email
                                                        }))}
                                                        placeholder={t("identity.pickEmail")}
                                                        aria-label={t("identity.pickEmail")}
                                                    />
                                                ) : null}
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
                                {t("item.privateKey")}
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
                                {t("item.publicKey")}
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

                    {draft.type === ITEM_API_KEY ? (
                        // Stored as a secure note with these as custom fields, so
                        // any Bitwarden client still has the key, the secret and
                        // where it is used - see `API_KEY_FIELDS`.
                        <>
                            <label className="flex flex-col gap-1 text-sm">
                                {t("item.apiKey")}
                                <Input
                                    value={apiKey.key}
                                    onChange={(event) =>
                                        setApiKey((prev) => ({ ...prev, key: event.target.value }))
                                    }
                                    className="font-mono"
                                    autoComplete="off"
                                    spellCheck={false}
                                />
                            </label>
                            <label className="flex flex-col gap-1 text-sm">
                                {t("item.apiSecret")}
                                <Input
                                    type="password"
                                    value={apiKey.secret}
                                    onChange={(event) =>
                                        setApiKey((prev) => ({
                                            ...prev,
                                            secret: event.target.value
                                        }))
                                    }
                                    className="font-mono"
                                    autoComplete="off"
                                />
                            </label>
                            <label className="flex flex-col gap-1 text-sm">
                                {t("item.endpoint")}
                                <Input
                                    type="url"
                                    inputMode="url"
                                    value={apiKey.endpoint}
                                    onChange={(event) =>
                                        setApiKey((prev) => ({
                                            ...prev,
                                            endpoint: event.target.value
                                        }))
                                    }
                                    placeholder="https://api.example.com"
                                    autoComplete="off"
                                    spellCheck={false}
                                />
                            </label>
                        </>
                    ) : null}

                    <label className="flex flex-col gap-1 text-sm">
                        {t("item.notes")}
                        <Textarea
                            rows={draft.type === core.CIPHER_SECURE_NOTE ? 10 : 3}
                            value={draft.notes}
                            onChange={(event) => patch({ notes: event.target.value })}
                        />
                    </label>

                    <div className="flex flex-col gap-2">
                        <div className="flex items-center justify-between">
                            <span className="text-sm">{t("item.customFields")}</span>
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
                                {t("item.add")}
                            </Button>
                        </div>
                        {/* Everything except the fields this form already has a
                            box of its own for. The recovery codes, the bank and
                            the chosen icon are kept as custom fields so other
                            clients can read them, and listing them here as well
                            put the codes on screen twice - once in their own
                            editor and once as a raw pair somebody could break by
                            renaming. The index is the real one, since that is
                            what every edit below writes through. */}
                        {draft.fields
                            .map((field, index) => ({ field, index }))
                            .filter(({ field }) => !managed.has(field.name))
                            .map(({ field, index }) => (
                                // Stacked on a phone, side by side from there up.
                                // Each half may shrink (`min-w-0`) and the two
                                // buttons never do: the name box used to keep its
                                // full width and leave the value a sliver.
                                <div
                                    key={index}
                                    data-custom-field=""
                                    className="flex flex-col gap-2 sm:flex-row sm:items-center"
                                >
                                    <Input
                                        className="min-w-0 sm:flex-1"
                                        value={field.name}
                                        placeholder={t("item.fieldName")}
                                        aria-label={t("item.fieldName")}
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
                                    <div className="flex min-w-0 items-center gap-2 sm:flex-1">
                                        <div className="min-w-0 flex-1">
                                            <Input
                                                value={field.value}
                                                placeholder={t("item.fieldValue")}
                                                aria-label={t("item.fieldValue")}
                                                type={
                                                    field.type === core.FIELD_HIDDEN
                                                        ? "password"
                                                        : "text"
                                                }
                                                onChange={(event) =>
                                                    patch({
                                                        fields: draft.fields.map((entry, at) =>
                                                            at === index
                                                                ? {
                                                                      ...entry,
                                                                      value: event.target.value
                                                                  }
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
                                            className="shrink-0"
                                            title={
                                                field.type === core.FIELD_HIDDEN
                                                    ? t("item.keepPlain")
                                                    : t("item.keepHidden")
                                            }
                                            aria-label={t("item.toggleHidden")}
                                            onClick={() =>
                                                patch({
                                                    fields: draft.fields.map((entry, at) =>
                                                        at === index
                                                            ? {
                                                                  ...entry,
                                                                  type:
                                                                      entry.type ===
                                                                      core.FIELD_HIDDEN
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
                                            className="shrink-0"
                                            title={t("item.removeField")}
                                            aria-label={t("item.removeField")}
                                            onClick={() =>
                                                patch({
                                                    fields: draft.fields.filter(
                                                        (_, at) => at !== index
                                                    )
                                                })
                                            }
                                        >
                                            <X className="size-4" />
                                        </Button>
                                    </div>
                                </div>
                            ))}
                    </div>
                </div>

                {error ? <p className="text-sm text-danger">{error}</p> : null}
                <DialogFooter>
                    <Button type="button" variant="secondary" onClick={onClose}>
                        {tc("actions.cancel")}
                    </Button>
                    <Button type="button" onClick={onSubmit} disabled={pending}>
                        {pending ? <Loader2 className="size-4 animate-spin" /> : null}
                        {tc("actions.save")}
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
