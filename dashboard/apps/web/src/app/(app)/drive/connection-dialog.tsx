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

import { useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, ArrowLeft, CheckCircle2, ChevronRight, Plus, Radar, XCircle } from "lucide-react";
import { type StorageProviderKind } from "@polaris/core";
import {
    Button,
    Dialog,
    DialogClose,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    DialogTrigger,
    Input
} from "@polaris/ui";
import {
    createConnectionAction,
    detectNasAction,
    testUnasConnectionAction,
    updateConnectionAction,
    type UnasTestResult
} from "./actions";
import type { ConnectionSummary } from "./types";

interface FieldDef {
    name: string;
    label: string;
    type?: "text" | "number" | "password" | "checkbox" | "keyfile";
    required?: boolean;
    placeholder?: string;
    group: "config" | "credentials";
}

const LABELS: Record<StorageProviderKind, string> = {
    local: "Local folder",
    sftp: "SFTP / SSH",
    webdav: "WebDAV",
    s3: "S3-compatible",
    smb: "SMB / CIFS",
    nfs: "NFS",
    synology: "Synology DSM",
    qnap: "QNAP QTS",
    truenas: "TrueNAS",
    "unifi-unas": "UniFi UNAS"
};

// One-line "what is this" per provider, shown on the picker cards.
const DESCRIPTIONS: Record<StorageProviderKind, string> = {
    "unifi-unas": "UniFi console over HTTPS - just username + password.",
    local: "A folder on this server or a mounted volume.",
    sftp: "Any server reachable over SSH / SFTP.",
    smb: "Windows or Samba shares (SMB / CIFS).",
    nfs: "Unix NFS exports.",
    webdav: "WebDAV endpoints (Nextcloud, ownCloud, ...).",
    s3: "S3-compatible object storage (AWS, MinIO, R2).",
    synology: "Synology DiskStation (DSM).",
    qnap: "QNAP (QTS).",
    truenas: "TrueNAS via API key."
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
    "synology",
    "qnap",
    "truenas"
];

/** SSH private-key input: paste it, or load it from a file into the textarea. */
function KeyFileField({ name, label }: { name: string; label: string }) {
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
                    Upload key file
                    <input type="file" hidden onChange={onFile} />
                </label>
            </span>
            <textarea
                ref={ref}
                name={name}
                rows={3}
                spellCheck={false}
                placeholder="Paste your private key (-----BEGIN OPENSSH PRIVATE KEY-----) or upload a file"
                className="rounded-md border border-input bg-surface px-3 py-2 font-mono text-xs"
            />
        </>
    );
}

const host: FieldDef = { name: "host", label: "Host", required: true, group: "config" };
const port: FieldDef = { name: "port", label: "Port", type: "number", group: "config" };

const FIELDS: Record<StorageProviderKind, FieldDef[]> = {
    local: [{ name: "root", label: "Root path", required: true, group: "config" }],
    sftp: [
        host,
        { name: "port", label: "Port", type: "number", placeholder: "22 (default)", group: "config" },
        { name: "username", label: "Username", required: true, group: "config" },
        { name: "root", label: "Base path", placeholder: "/", group: "config" },
        { name: "password", label: "Password (or use a key)", type: "password", group: "credentials" },
        { name: "privateKey", label: "Private key (optional)", type: "keyfile", group: "credentials" }
    ],
    webdav: [
        { name: "baseUrl", label: "Base URL", required: true, group: "config" },
        { name: "username", label: "Username", group: "config" },
        { name: "password", label: "Password", type: "password", group: "credentials" }
    ],
    s3: [
        { name: "endpoint", label: "Endpoint (optional)", group: "config" },
        { name: "region", label: "Region", placeholder: "us-east-1", group: "config" },
        { name: "bucket", label: "Bucket", required: true, group: "config" },
        { name: "forcePathStyle", label: "Force path style", type: "checkbox", group: "config" },
        { name: "accessKeyId", label: "Access key ID", required: true, group: "config" },
        { name: "secretAccessKey", label: "Secret access key", type: "password", required: true, group: "credentials" }
    ],
    smb: [
        host,
        { name: "share", label: "Share", required: true, group: "config" },
        { name: "domain", label: "Domain", group: "config" },
        { name: "username", label: "Username", group: "config" },
        { name: "password", label: "Password", type: "password", group: "credentials" }
    ],
    nfs: [host, { name: "exportPath", label: "Export path", required: true, group: "config" }],
    synology: [
        host,
        { name: "username", label: "Username", required: true, group: "config" },
        { name: "password", label: "Password", type: "password", required: true, group: "credentials" }
    ],
    qnap: [
        host,
        { name: "username", label: "Username", required: true, group: "config" },
        { name: "password", label: "Password", type: "password", required: true, group: "credentials" }
    ],
    truenas: [host, { name: "apiKey", label: "API key", type: "password", required: true, group: "credentials" }],
    "unifi-unas": [
        host,
        port,
        { name: "username", label: "Console username", required: true, group: "config" },
        { name: "password", label: "Console password", type: "password", group: "credentials" },
        { name: "smbShare", label: "SMB share (optional, for file browsing)", group: "config" }
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
    const [error, setError] = useState<string | null>(null);
    const [pending, setPending] = useState(false);

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
                    <DialogTitle>{rekey ? `Update ${LABELS[kind]} credentials` : `Edit ${LABELS[kind]}`}</DialogTitle>
                    <DialogDescription>
                        {rekey
                            ? "Re-enter the password or key to restore access. Your files, shares, and settings are kept."
                            : "Change the name, host, and settings. Leave a password or key blank to keep the current one."}
                    </DialogDescription>
                </DialogHeader>
                {rekey ? (
                    <div className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 p-2 text-xs text-muted-foreground">
                        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
                        <span>
                            The saved credentials were encrypted with a different master key and can no longer be read.
                            Entering them again re-encrypts under the current key - nothing else about this connection
                            changes.
                        </span>
                    </div>
                ) : null}
                <form key={connection.id} onSubmit={onSubmit} className="flex flex-col gap-3">
                    <label className="flex flex-col gap-1 text-sm">
                        Name
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
                                        {field.label}
                                    </span>
                                ) : field.type === "keyfile" ? (
                                    <KeyFileField name={field.name} label={field.label} />
                                ) : (
                                    <>
                                        {field.label}
                                        <Input
                                            name={field.name}
                                            type={field.type ?? "text"}
                                            required={field.required && field.group === "config"}
                                            placeholder={
                                                field.group === "credentials"
                                                    ? rekey
                                                        ? "Enter to restore access"
                                                        : "Leave blank to keep current"
                                                    : field.placeholder
                                            }
                                            defaultValue={
                                                field.group === "config" && current !== undefined && current !== null
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
                                Cancel
                            </Button>
                        </DialogClose>
                        <Button type="submit" disabled={pending}>
                            {pending ? "Saving..." : "Save changes"}
                        </Button>
                    </div>
                </form>
            </DialogContent>
        </Dialog>
    );
}

export function ConnectionDialog() {
    const router = useRouter();
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
        setDetectMsg("Nothing recognizable answered on that host - pick a provider below.");
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
                    Add connection
                </Button>
            </DialogTrigger>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>
                        {step === "provider" ? "New storage connection" : `Connect ${LABELS[kind]}`}
                    </DialogTitle>
                    <DialogDescription>
                        {step === "provider"
                            ? "Pick where your files live. You can go back and change this anytime."
                            : DESCRIPTIONS[kind]}
                    </DialogDescription>
                </DialogHeader>

                {step === "provider" ? (
                    <div className="flex flex-col gap-3">
                        <div className="rounded-md border border-border bg-muted/30 p-2">
                            <div className="flex items-end gap-2">
                                <label className="flex flex-1 flex-col gap-1 text-xs text-muted-foreground">
                                    Detect a NAS by IP
                                    <Input
                                        placeholder="192.168.1.145"
                                        value={detectIp}
                                        onChange={(event) => setDetectIp(event.target.value)}
                                    />
                                </label>
                                <Button type="button" size="sm" variant="ghost" onClick={onDetect} disabled={detecting}>
                                    <Radar className="size-4" />
                                    {detecting ? "Scanning..." : "Detect"}
                                </Button>
                            </div>
                            {detectMsg ? <p className="mt-1 text-xs text-muted-foreground">{detectMsg}</p> : null}
                        </div>

                        <div className="grid grid-cols-2 gap-2">
                            {PROVIDER_ORDER.map((value) => (
                                <button
                                    key={value}
                                    type="button"
                                    onClick={() => chooseProvider(value)}
                                    className={`flex flex-col gap-1 rounded-md border p-3 text-left transition-colors hover:border-primary hover:bg-primary/5 ${
                                        value === "unifi-unas" ? "border-primary/60 bg-primary/5" : "border-border"
                                    }`}
                                >
                                    <span className="flex items-center justify-between text-sm font-medium">
                                        {LABELS[value]}
                                        <ChevronRight className="size-4 text-muted-foreground" />
                                    </span>
                                    <span className="text-xs text-muted-foreground">{DESCRIPTIONS[value]}</span>
                                </button>
                            ))}
                        </div>
                    </div>
                ) : (
                    <form onSubmit={onSubmit} className="flex flex-col gap-3">
                        <label className="flex flex-col gap-1 text-sm">
                            Name
                            <Input name="name" required placeholder="My NAS" />
                        </label>
                        {FIELDS[kind].map((field) => (
                            <label key={`${field.name}:${detectedHost}`} className="flex flex-col gap-1 text-sm">
                                {field.type === "checkbox" ? (
                                    <span className="flex items-center gap-2">
                                        <input type="checkbox" name={field.name} className="size-4" />
                                        {field.label}
                                    </span>
                                ) : field.type === "keyfile" ? (
                                    <KeyFileField name={field.name} label={field.label} />
                                ) : (
                                    <>
                                        {field.label}
                                        <Input
                                            name={field.name}
                                            type={field.type ?? "text"}
                                            required={field.required}
                                            placeholder={field.placeholder}
                                            defaultValue={field.name === "host" ? detectedHost : undefined}
                                        />
                                    </>
                                )}
                            </label>
                        ))}
                        {kind === "unifi-unas" ? (
                            <div className="flex flex-col gap-2 rounded-md border border-border bg-muted/30 p-2">
                                <p className="text-xs text-muted-foreground">
                                    Use a <strong>local console account</strong> (not a Ubiquiti SSO login with 2FA).
                                    Polaris reads metrics from the UniFi OS console over HTTPS; SSH stays off.
                                </p>
                                <div className="flex items-center gap-2">
                                    <Button
                                        type="button"
                                        size="sm"
                                        variant="ghost"
                                        disabled={testing}
                                        onClick={(event) => onTestUnas(event.currentTarget.form)}
                                    >
                                        {testing ? "Testing..." : "Test connection"}
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
                                                ? `${testResult.device}${testResult.firmware ? ` (fw ${testResult.firmware})` : ""} - ${testResult.pools} pools, ${testResult.bays} disks`
                                                : testResult.error}
                                        </span>
                                    ) : null}
                                </div>
                            </div>
                        ) : null}
                        {error ? <p className="text-sm text-danger">{error}</p> : null}
                        <div className="mt-2 flex items-center justify-between gap-2">
                            <Button type="button" variant="ghost" onClick={() => setStep("provider")}>
                                <ArrowLeft className="size-4" />
                                Back
                            </Button>
                            <div className="flex gap-2">
                                <DialogClose asChild>
                                    <Button type="button" variant="ghost">
                                        Cancel
                                    </Button>
                                </DialogClose>
                                <Button type="submit" disabled={pending}>
                                    {pending ? "Connecting..." : "Create"}
                                </Button>
                            </div>
                        </div>
                    </form>
                )}
            </DialogContent>
        </Dialog>
    );
}
