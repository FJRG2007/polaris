"use client";

/**
 * Create-connection wizard. Two guided steps: first pick a provider (a card
 * grid, UniFi UNAS featured first), then configure it. Fields are declared per
 * provider kind and rendered dynamically, so adding a provider is a data change,
 * not new JSX. Values are coerced (numbers, booleans) and split into non-secret
 * config and secret credentials before being handed to the server action, which
 * validates them again with the shared Zod schema - the client is never the
 * source of truth.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import type { ConnectionSummary } from "./types";
import { useFormChanged } from "@/lib/use-form-changed";
import { useTranslations } from "@/components/i18n/i18n-provider";
import type { NamespaceKey, NamespaceTranslator } from "@/lib/i18n/types";
import { type ConnectionProviderSlug, type StorageProviderKind } from "@polaris/core";
import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import {
    AlertTriangle,
    ArrowLeft,
    CheckCircle2,
    ChevronRight,
    Plus,
    Radar,
    XCircle
} from "lucide-react";
import {
    createConnectionAction,
    detectNasAction,
    linkedAccountsAction,
    testUnasConnectionAction,
    updateConnectionAction,
    type LinkedAccountOption,
    type UnasTestResult
} from "./actions";
import {
    Input,
    Button,
    Dialog,
    Select,
    Skeleton,
    Textarea,
    DialogClose,
    DialogTitle,
    DialogHeader,
    DialogContent,
    DialogTrigger,
    DialogDescription
} from "@polaris/ui";

interface FieldDef {
    name: string;
    /** Catalog key of the field's label, in the drive namespace. */
    label: NamespaceKey<"drive">;
    /** Catalog key of a placeholder that is words rather than an example value. */
    hint?: NamespaceKey<"drive">;
    type?: "text" | "number" | "password" | "checkbox" | "keyfile" | "account";
    required?: boolean;
    placeholder?: string;
    group: "config" | "credentials";
    /** For type=account: which linked service the account is chosen from. */
    provider?: ConnectionProviderSlug;
}

const LABELS = {
    local: "connection.kinds.local",
    sftp: "connection.kinds.sftp",
    webdav: "connection.kinds.webdav",
    s3: "connection.kinds.s3",
    smb: "connection.kinds.smb",
    nfs: "connection.kinds.nfs",
    synology: "connection.kinds.synology",
    qnap: "connection.kinds.qnap",
    truenas: "connection.kinds.truenas",
    "unifi-unas": "connection.kinds.unifiUnas",
    gdrive: "connection.kinds.gdrive",
    onedrive: "connection.kinds.onedrive",
    dropbox: "connection.kinds.dropbox",
    // Never offered here - Polaris makes it - but the picker's tables are
    // exhaustive so that a new provider cannot be added without a name.
    personal: "connection.kinds.personal"
} as const satisfies Record<StorageProviderKind, string>;

// One-line "what is this" per provider, shown on the picker cards.
const DESCRIPTIONS = {
    "unifi-unas": "connection.descriptions.unifiUnas",
    local: "connection.descriptions.local",
    sftp: "connection.descriptions.sftp",
    smb: "connection.descriptions.smb",
    nfs: "connection.descriptions.nfs",
    webdav: "connection.descriptions.webdav",
    s3: "connection.descriptions.s3",
    synology: "connection.descriptions.synology",
    qnap: "connection.descriptions.qnap",
    truenas: "connection.descriptions.truenas",
    gdrive: "connection.descriptions.gdrive",
    onedrive: "connection.descriptions.onedrive",
    dropbox: "connection.descriptions.dropbox",
    personal: "connection.descriptions.personal"
} as const satisfies Record<StorageProviderKind, string>;

/** A field's placeholder: its translated hint, or the literal example value. */
function placeholderOf(field: FieldDef, t: NamespaceTranslator<"drive">) {
    return field.hint ? t(field.hint) : field.placeholder;
}

/** The service a linked-account field is chosen from, by its brand name. */
const PROVIDER_NAMES: Partial<Record<ConnectionProviderSlug, string>> = {
    google: "Google",
    microsoft: "Microsoft",
    dropbox: "Dropbox"
};

// Display order for the picker: UniFi first (the featured quick connect), then
// the rest. Every kind must appear so nothing is unreachable.
const PROVIDER_ORDER: StorageProviderKind[] = [
    "unifi-unas",
    "local",
    "sftp",
    "smb",
    "nfs",
    "webdav",
    "s3",
    "gdrive",
    "onedrive",
    "dropbox",
    "synology",
    "qnap",
    "truenas"
];

/**
 * Pick which linked account a consumer drive is reached through.
 *
 * The accounts are loaded when the field appears rather than with the page: most
 * connections are to a NAS and never open this, and asking for somebody's linked
 * accounts on every render of the dialog would be a query nobody reads.
 *
 * With none linked there is nothing to choose, so it says so and points at the
 * screen that fixes it - an empty select somebody cannot submit explains nothing.
 */
function LinkedAccountField({ field }: { field: FieldDef }) {
    const t = useTranslations("drive");
    const [accounts, setAccounts] = useState<LinkedAccountOption[] | null>(null);
    const [chosen, setChosen] = useState("");

    useEffect(() => {
        let live = true;
        if (!field.provider) return;
        linkedAccountsAction(field.provider).then((rows) => {
            if (!live) return;
            setAccounts(rows);
            // One account is the common case; preselecting it saves a click and
            // makes the form submittable the moment it renders.
            setChosen(rows[0]?.accountId ?? "");
        });
        return () => {
            live = false;
        };
    }, [field.provider]);

    if (accounts === null) return <Skeleton className="h-9 w-full" />;
    if (accounts.length === 0) {
        return (
            <span className="rounded-md border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">
                {t.rich("connection.noLinkedAccount", {
                    provider: (field.provider && PROVIDER_NAMES[field.provider]) ?? "",
                    link: (chunks) => (
                        <Link key="link" href="/account/connections" className="text-primary hover:underline">
                            {chunks}
                        </Link>
                    )
                })}
            </span>
        );
    }
    return (
        <Select
            name={field.name}
            value={chosen}
            onValueChange={setChosen}
            aria-label={t(field.label)}
            options={accounts.map((account) => ({
                value: account.accountId,
                label: account.label
            }))}
        />
    );
}

/** SSH private-key input: paste it, or load it from a file into the textarea. */
function KeyFileField({ name, label }: { name: string; label: string }) {
    const t = useTranslations("drive");
    const ref = useRef<HTMLTextAreaElement>(null);
    async function onFile(event: ChangeEvent<HTMLInputElement>) {
        const file = event.target.files?.[0];
        if (!file || !ref.current) return;
        ref.current.value = await file.text();
        event.target.value = "";
    }
    return (
        <>
            <span className="flex items-center justify-between gap-2">
                {label}
                <label className="cursor-pointer text-xs text-primary hover:underline">
                    {t("connection.uploadKey")}
                    <input type="file" hidden onChange={onFile} />
                </label>
            </span>
            <Textarea
                ref={ref}
                name={name}
                rows={3}
                spellCheck={false}
                placeholder={t("connection.keyPlaceholder")}
                className="rounded-md border border-border bg-surface px-3 py-2 font-mono text-xs"
            />
        </>
    );
}

const host: FieldDef = { name: "host", label: "connection.fields.host", required: true, group: "config" };
const port: FieldDef = { name: "port", label: "connection.fields.port", type: "number", group: "config" };

const FIELDS: Record<StorageProviderKind, FieldDef[]> = {
    local: [{ name: "root", label: "connection.fields.rootPath", required: true, group: "config" }],
    // Nothing to fill in: a personal drive is made by Polaris, on the storage
    // the instance already keeps files on, and is never offered by this form.
    personal: [],
    sftp: [
        host,
        {
            name: "port",
            label: "connection.fields.port",
            type: "number",
            hint: "connection.placeholders.sshPort",
            group: "config"
        },
        { name: "username", label: "connection.fields.username", required: true, group: "config" },
        { name: "root", label: "connection.fields.basePath", placeholder: "/", group: "config" },
        {
            name: "password",
            label: "connection.fields.passwordOrKey",
            type: "password",
            group: "credentials"
        },
        {
            name: "privateKey",
            label: "connection.fields.privateKey",
            type: "keyfile",
            group: "credentials"
        }
    ],
    webdav: [
        { name: "baseUrl", label: "connection.fields.baseUrl", required: true, group: "config" },
        { name: "username", label: "connection.fields.username", group: "config" },
        { name: "password", label: "connection.fields.password", type: "password", group: "credentials" }
    ],
    s3: [
        { name: "endpoint", label: "connection.fields.endpoint", group: "config" },
        { name: "region", label: "connection.fields.region", placeholder: "us-east-1", group: "config" },
        { name: "bucket", label: "connection.fields.bucket", required: true, group: "config" },
        { name: "forcePathStyle", label: "connection.fields.forcePathStyle", type: "checkbox", group: "config" },
        { name: "accessKeyId", label: "connection.fields.accessKeyId", required: true, group: "config" },
        {
            name: "secretAccessKey",
            label: "connection.fields.secretAccessKey",
            type: "password",
            required: true,
            group: "credentials"
        }
    ],
    smb: [
        host,
        { name: "share", label: "connection.fields.share", required: true, group: "config" },
        { name: "domain", label: "connection.fields.domain", group: "config" },
        { name: "username", label: "connection.fields.username", group: "config" },
        { name: "password", label: "connection.fields.password", type: "password", group: "credentials" }
    ],
    nfs: [host, { name: "exportPath", label: "connection.fields.exportPath", required: true, group: "config" }],
    synology: [
        host,
        { name: "username", label: "connection.fields.username", required: true, group: "config" },
        {
            name: "password",
            label: "connection.fields.password",
            type: "password",
            required: true,
            group: "credentials"
        }
    ],
    qnap: [
        host,
        { name: "username", label: "connection.fields.username", required: true, group: "config" },
        {
            name: "password",
            label: "connection.fields.password",
            type: "password",
            required: true,
            group: "credentials"
        }
    ],
    truenas: [
        host,
        { name: "apiKey", label: "connection.fields.apiKey", type: "password", required: true, group: "credentials" }
    ],
    "unifi-unas": [
        host,
        port,
        { name: "username", label: "connection.fields.consoleUsername", required: true, group: "config" },
        { name: "password", label: "connection.fields.consolePassword", type: "password", group: "credentials" },
        { name: "smbShare", label: "connection.fields.smbShare", group: "config" }
    ],
    // The consumer drives hold no credentials of their own: the account is
    // chosen from the ones somebody has already linked, and the token comes from
    // there. All that is left to decide is which folder to live in.
    gdrive: [
        {
            name: "accountId",
            label: "connection.fields.googleAccount",
            type: "account",
            provider: "google",
            required: true,
            group: "config"
        },
        // i18n-ignore: the default folder is named after the product
        { name: "rootFolderName", label: "connection.fields.folderName", placeholder: "Polaris", group: "config" }
    ],
    onedrive: [
        {
            name: "accountId",
            label: "connection.fields.microsoftAccount",
            type: "account",
            provider: "microsoft",
            required: true,
            group: "config"
        },
        // i18n-ignore: the default folder is named after the product
        { name: "rootFolderName", label: "connection.fields.folderName", placeholder: "Polaris", group: "config" }
    ],
    dropbox: [
        {
            name: "accountId",
            label: "connection.fields.dropboxAccount",
            type: "account",
            provider: "dropbox",
            required: true,
            group: "config"
        },
        { name: "rootPath", label: "connection.fields.folder", placeholder: "/Polaris", group: "config" }
    ]
};

/**
 * Edit an existing connection. Reuses the per-kind field map, prefilling the
 * non-secret config from the stored connection. Credential fields start empty
 * with a "leave blank to keep current" hint - the server only replaces the stored
 * secret when new material is entered, so editing a host never re-prompts for a
 * password. The provider kind is fixed (changing it would be a new connection).
 */
export function EditConnectionDialog({
    connection,
    open,
    onOpenChange
}: {
    connection: ConnectionSummary | null;
    open: boolean;
    onOpenChange: (open: boolean) => void;
}) {
    const router = useRouter();
    const t = useTranslations("drive");
    const [error, setError] = useState<string | null>(null);
    const [pending, setPending] = useState(false);
    const { formProps, changed } = useFormChanged();

    if (!connection) return null;
    const kind = connection.kind;
    const config = connection.config ?? {};
    // Re-key mode: the stored secret was encrypted under a previous master key and
    // can no longer be decrypted, so "leave blank to keep" would keep a dead
    // secret. Prompt for the credential and explain that everything else is kept.
    const rekey = Boolean(connection.needsRekey);

    async function onSubmit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        setPending(true);
        setError(null);
        const form = new FormData(event.currentTarget);
        // Start from the stored config so keys without a form field (e.g. a UNAS
        // `secure` flag) are preserved rather than dropped on save.
        const nextConfig: Record<string, unknown> = { ...config, kind };
        const credentials: Record<string, unknown> = { kind };
        for (const field of FIELDS[kind]) {
            const raw = form.get(field.name);
            const target = field.group === "config" ? nextConfig : credentials;
            if (field.type === "checkbox") {
                target[field.name] = raw === "on";
            } else if (field.type === "number") {
                if (raw) target[field.name] = Number(raw);
            } else if (raw) {
                target[field.name] = String(raw);
            }
        }
        const result = await updateConnectionAction(connection!.id, {
            name: String(form.get("name") ?? ""),
            config: nextConfig,
            credentials
        });
        setPending(false);
        if (result.error) {
            setError(result.error);
            return;
        }
        onOpenChange(false);
        router.refresh();
    }

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>
                        {rekey ? t("connection.rekeyTitle", { kind: t(LABELS[kind]) }) : t("connection.editTitle", { kind: t(LABELS[kind]) })}
                    </DialogTitle>
                    <DialogDescription>
                        {rekey
                            ? t("connection.rekeyDescription")
                            : t("connection.editDescription")}
                    </DialogDescription>
                </DialogHeader>
                {rekey ? (
                    <div className="flex items-start gap-2 rounded-md border border-warning-edge bg-warning-soft p-2 text-xs text-muted-foreground">
                        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
                        <span>
                            {t("connection.rekeyWarning")}
                        </span>
                    </div>
                ) : null}
                <form
                    key={connection.id}
                    onSubmit={onSubmit}
                    className="flex flex-col gap-3"
                    {...formProps}
                >
                    <label className="flex flex-col gap-1 text-sm">
                        {t("connection.name")}
                        <Input name="name" required defaultValue={connection.name} />
                    </label>
                    {FIELDS[kind].map((field) => {
                        const current = config[field.name];
                        return (
                            <label key={field.name} className="flex flex-col gap-1 text-sm">
                                {field.type === "checkbox" ? (
                                    <span className="flex items-center gap-2">
                                        <input
                                            type="checkbox"
                                            name={field.name}
                                            defaultChecked={Boolean(current)}
                                            className="size-4"
                                        />
                                        {t(field.label)}
                                    </span>
                                ) : field.type === "keyfile" ? (
                                    <KeyFileField name={field.name} label={t(field.label)} />
                                ) : field.type === "account" ? (
                                    <>
                                        {t(field.label)}
                                        <LinkedAccountField field={field} />
                                    </>
                                ) : (
                                    <>
                                        {t(field.label)}
                                        <Input
                                            name={field.name}
                                            type={field.type ?? "text"}
                                            required={field.required && field.group === "config"}
                                            placeholder={
                                                field.group === "credentials"
                                                    ? rekey
                                                        ? t("connection.restorePlaceholder")
                                                        : t("connection.keepPlaceholder")
                                                    : placeholderOf(field, t)
                                            }
                                            defaultValue={
                                                field.group === "config" &&
                                                current !== undefined &&
                                                current !== null
                                                    ? String(current)
                                                    : undefined
                                            }
                                        />
                                    </>
                                )}
                            </label>
                        );
                    })}
                    {error ? <p className="text-sm text-danger">{error}</p> : null}
                    <div className="mt-2 flex justify-end gap-2">
                        <DialogClose asChild>
                            <Button type="button" variant="ghost">
                                {t("connection.cancel")}
                            </Button>
                        </DialogClose>
                        <Button type="submit" disabled={pending || !changed}>
                            {pending ? t("connection.saving") : t("connection.save")}
                        </Button>
                    </div>
                </form>
            </DialogContent>
        </Dialog>
    );
}

export function ConnectionDialog() {
    const router = useRouter();
    const t = useTranslations("drive");
    const [open, setOpen] = useState(false);
    const [step, setStep] = useState<"provider" | "configure">("provider");
    const [kind, setKind] = useState<StorageProviderKind>("unifi-unas");
    const [error, setError] = useState<string | null>(null);
    const [pending, setPending] = useState(false);
    const [detectIp, setDetectIp] = useState("");
    const [detectedHost, setDetectedHost] = useState("");
    const [detecting, setDetecting] = useState(false);
    const [detectMsg, setDetectMsg] = useState<string | null>(null);
    const [testing, setTesting] = useState(false);
    const [testResult, setTestResult] = useState<UnasTestResult | null>(null);

    /** Reset the wizard to its first step whenever the dialog is (re)opened. */
    function onOpenChange(next: boolean) {
        setOpen(next);
        if (next) {
            setStep("provider");
            setKind("unifi-unas");
            setError(null);
            setDetectMsg(null);
            setDetectedHost("");
            setTestResult(null);
        }
    }

    /** Pick a provider from the grid and advance to its configuration step. */
    function chooseProvider(next: StorageProviderKind) {
        setKind(next);
        setError(null);
        setTestResult(null);
        setStep("configure");
    }

    /** Read the current form values for a live UNAS dry-run. */
    async function onTestUnas(form: HTMLFormElement | null) {
        if (!form) return;
        const data = new FormData(form);
        const portRaw = data.get("port");
        setTesting(true);
        setTestResult(null);
        const result = await testUnasConnectionAction({
            host: String(data.get("host") ?? ""),
            port: portRaw ? Number(portRaw) : undefined,
            username: String(data.get("username") ?? ""),
            password: String(data.get("password") ?? "")
        });
        setTesting(false);
        setTestResult(result);
    }

    async function onDetect() {
        if (!detectIp.trim()) return;
        setDetecting(true);
        setDetectMsg(null);
        const result = await detectNasAction(detectIp.trim());
        setDetecting(false);
        if ("error" in result) {
            setDetectMsg(result.error);
            return;
        }
        setDetectedHost(result.host);
        if (result.suggested) {
            // A recognizable NAS answered - jump straight into its configuration.
            chooseProvider(result.suggested);
            return;
        }
        setDetectMsg(t("connection.nothingDetected"));
    }

    async function onSubmit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        setPending(true);
        setError(null);
        const form = new FormData(event.currentTarget);
        const config: Record<string, unknown> = { kind };
        const credentials: Record<string, unknown> = { kind };
        for (const field of FIELDS[kind]) {
            const raw = form.get(field.name);
            const target = field.group === "config" ? config : credentials;
            if (field.type === "checkbox") {
                target[field.name] = raw === "on";
            } else if (field.type === "number") {
                if (raw) target[field.name] = Number(raw);
            } else if (raw) {
                target[field.name] = String(raw);
            }
        }
        const result = await createConnectionAction({
            name: String(form.get("name") ?? ""),
            config,
            credentials
        });
        setPending(false);
        if (result.error) {
            setError(result.error);
            return;
        }
        setOpen(false);
        router.refresh();
    }

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogTrigger asChild>
                <Button size="sm" variant="secondary">
                    <Plus className="size-4" />
                    {t("connection.add")}
                </Button>
            </DialogTrigger>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>
                        {step === "provider" ? t("connection.newTitle") : t("connection.connectTitle", { kind: t(LABELS[kind]) })}
                    </DialogTitle>
                    <DialogDescription>
                        {step === "provider"
                            ? t("connection.pickDescription")
                            : t(DESCRIPTIONS[kind])}
                    </DialogDescription>
                </DialogHeader>

                {step === "provider" ? (
                    <div className="flex flex-col gap-3">
                        <div className="rounded-md border border-border bg-muted/30 p-2">
                            <div className="flex items-end gap-2">
                                <label className="flex flex-1 flex-col gap-1 text-xs text-muted-foreground">
                                    {t("connection.detectLabel")}
                                    <Input
                                        placeholder="10.0.1.145"
                                        value={detectIp}
                                        onChange={(event) => setDetectIp(event.target.value)}
                                    />
                                </label>
                                <Button
                                    type="button"
                                    size="sm"
                                    variant="ghost"
                                    onClick={onDetect}
                                    disabled={detecting}
                                >
                                    <Radar className="size-4" />
                                    {detecting ? t("connection.scanning") : t("connection.detect")}
                                </Button>
                            </div>
                            {detectMsg ? (
                                <p className="mt-1 text-xs text-muted-foreground">{detectMsg}</p>
                            ) : null}
                        </div>

                        <div className="grid grid-cols-2 gap-2">
                            {PROVIDER_ORDER.map((value) => (
                                <button
                                    key={value}
                                    type="button"
                                    onClick={() => chooseProvider(value)}
                                    className={`flex flex-col gap-1 rounded-md border p-3 text-left transition-colors hover:border-primary hover:bg-primary/5 ${
                                        value === "unifi-unas"
                                            ? "border-primary/60 bg-primary/5"
                                            : "border-border"
                                    }`}
                                >
                                    <span className="flex items-center justify-between text-sm font-medium">
                                        {t(LABELS[value])}
                                        <ChevronRight className="size-4 text-muted-foreground" />
                                    </span>
                                    <span className="text-xs text-muted-foreground">
                                        {t(DESCRIPTIONS[value])}
                                    </span>
                                </button>
                            ))}
                        </div>
                    </div>
                ) : (
                    <form onSubmit={onSubmit} className="flex flex-col gap-3">
                        <label className="flex flex-col gap-1 text-sm">
                            {t("connection.name")}
                            <Input name="name" required placeholder={t("connection.namePlaceholder")} />
                        </label>
                        {FIELDS[kind].map((field) => (
                            <label
                                key={`${field.name}:${detectedHost}`}
                                className="flex flex-col gap-1 text-sm"
                            >
                                {field.type === "checkbox" ? (
                                    <span className="flex items-center gap-2">
                                        <input
                                            type="checkbox"
                                            name={field.name}
                                            className="size-4"
                                        />
                                        {t(field.label)}
                                    </span>
                                ) : field.type === "keyfile" ? (
                                    <KeyFileField name={field.name} label={t(field.label)} />
                                ) : field.type === "account" ? (
                                    <>
                                        {t(field.label)}
                                        <LinkedAccountField field={field} />
                                    </>
                                ) : (
                                    <>
                                        {t(field.label)}
                                        <Input
                                            name={field.name}
                                            type={field.type ?? "text"}
                                            required={field.required}
                                            placeholder={placeholderOf(field, t)}
                                            defaultValue={
                                                field.name === "host" ? detectedHost : undefined
                                            }
                                        />
                                    </>
                                )}
                            </label>
                        ))}
                        {kind === "unifi-unas" ? (
                            <div className="flex flex-col gap-2 rounded-md border border-border bg-muted/30 p-2">
                                <p className="text-xs text-muted-foreground">
                                    {t.rich("connection.unasHint", {
                                        strong: (chunks) => <strong key="account">{chunks}</strong>
                                    })}
                                </p>
                                <div className="flex items-center gap-2">
                                    <Button
                                        type="button"
                                        size="sm"
                                        variant="ghost"
                                        disabled={testing}
                                        onClick={(event) => onTestUnas(event.currentTarget.form)}
                                    >
                                        {testing ? t("connection.testing") : t("connection.test")}
                                    </Button>
                                    {testResult ? (
                                        <span
                                            className={`flex items-center gap-1 text-xs ${testResult.ok ? "text-success" : "text-danger"}`}
                                        >
                                            {testResult.ok ? (
                                                <CheckCircle2 className="size-3.5" />
                                            ) : (
                                                <XCircle className="size-3.5" />
                                            )}
                                            {testResult.ok
                                                ? t("connection.testResult", {
                                                      device: testResult.firmware
                                                          ? `${testResult.device} (fw ${testResult.firmware})`
                                                          : testResult.device,
                                                      pools: testResult.pools,
                                                      bays: testResult.bays
                                                  })
                                                : testResult.error}
                                        </span>
                                    ) : null}
                                </div>
                            </div>
                        ) : null}
                        {error ? <p className="text-sm text-danger">{error}</p> : null}
                        <div className="mt-2 flex items-center justify-between gap-2">
                            <Button
                                type="button"
                                variant="ghost"
                                onClick={() => setStep("provider")}
                            >
                                <ArrowLeft className="size-4" />
                                {t("connection.back")}
                            </Button>
                            <div className="flex gap-2">
                                <DialogClose asChild>
                                    <Button type="button" variant="ghost">
                                        {t("connection.cancel")}
                                    </Button>
                                </DialogClose>
                                <Button type="submit" disabled={pending}>
                                    {pending ? t("connection.connecting") : t("connection.create")}
                                </Button>
                            </div>
                        </div>
                    </form>
                )}
            </DialogContent>
        </Dialog>
    );
}
