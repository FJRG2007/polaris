"use client";

/**
 * Create-connection form. Fields are declared per provider kind and rendered
 * dynamically, so adding a provider is a data change, not new JSX. Values are
 * coerced (numbers, booleans) and split into non-secret config and secret
 * credentials before being handed to the server action, which validates them
 * again with the shared Zod schema - the client is never the source of truth.
 */

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, Plus, Radar, XCircle } from "lucide-react";
import { STORAGE_PROVIDER_KINDS, type StorageProviderKind } from "@polaris/core";
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
import { createConnectionAction, detectNasAction, testUnasConnectionAction, type UnasTestResult } from "./actions";

interface FieldDef {
    name: string;
    label: string;
    type?: "text" | "number" | "password" | "checkbox";
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

const host: FieldDef = { name: "host", label: "Host", required: true, group: "config" };
const port: FieldDef = { name: "port", label: "Port", type: "number", group: "config" };

const FIELDS: Record<StorageProviderKind, FieldDef[]> = {
    local: [{ name: "root", label: "Root path", required: true, group: "config" }],
    sftp: [
        host,
        port,
        { name: "username", label: "Username", required: true, group: "config" },
        { name: "root", label: "Base path", placeholder: "/", group: "config" },
        { name: "password", label: "Password", type: "password", group: "credentials" }
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
        { name: "password", label: "Console password", type: "password", group: "credentials" }
    ]
};

export function ConnectionDialog() {
    const router = useRouter();
    const [open, setOpen] = useState(false);
    const [kind, setKind] = useState<StorageProviderKind>("local");
    const [error, setError] = useState<string | null>(null);
    const [pending, setPending] = useState(false);
    const [detectIp, setDetectIp] = useState("");
    const [detectedHost, setDetectedHost] = useState("");
    const [detecting, setDetecting] = useState(false);
    const [detectMsg, setDetectMsg] = useState<string | null>(null);
    const [testing, setTesting] = useState(false);
    const [testResult, setTestResult] = useState<UnasTestResult | null>(null);

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
        if (result.suggested) setKind(result.suggested);
        setDetectedHost(result.host);
        setDetectMsg(
            result.hints.length > 0
                ? `Found: ${result.hints.join(", ")}${result.suggested ? ` - selected ${LABELS[result.suggested]}` : ""}`
                : "Nothing recognizable answered on that host"
        );
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
        <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
                <Button size="sm" variant="secondary">
                    <Plus className="size-4" />
                    Add connection
                </Button>
            </DialogTrigger>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>New storage connection</DialogTitle>
                    <DialogDescription>Connect a NAS, cloud bucket, or local folder.</DialogDescription>
                </DialogHeader>
                <form onSubmit={onSubmit} className="flex flex-col gap-3">
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
                    <label className="flex flex-col gap-1 text-sm">
                        Provider
                        <select
                            className="h-9 rounded-md border border-input bg-surface px-3 text-sm"
                            value={kind}
                            onChange={(event) => setKind(event.target.value as StorageProviderKind)}
                        >
                            {STORAGE_PROVIDER_KINDS.map((value) => (
                                <option key={value} value={value}>
                                    {LABELS[value]}
                                </option>
                            ))}
                        </select>
                    </label>
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
                                            ? `${testResult.device}${testResult.version ? ` (${testResult.version})` : ""} - ${testResult.pools} pools, ${testResult.shares} shares`
                                            : testResult.error}
                                    </span>
                                ) : null}
                            </div>
                        </div>
                    ) : null}
                    {error ? <p className="text-sm text-danger">{error}</p> : null}
                    <div className="mt-2 flex justify-end gap-2">
                        <DialogClose asChild>
                            <Button type="button" variant="ghost">
                                Cancel
                            </Button>
                        </DialogClose>
                        <Button type="submit" disabled={pending}>
                            {pending ? "Connecting..." : "Create"}
                        </Button>
                    </div>
                </form>
            </DialogContent>
        </Dialog>
    );
}
