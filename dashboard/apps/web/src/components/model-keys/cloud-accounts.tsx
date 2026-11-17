"use client";

/**
 * Cloud accounts as AI providers: Amazon Bedrock, Azure OpenAI, Google Vertex
 * AI, Snowflake Cortex and DigitalOcean. Each takes more than one value, so it
 * has a form of its own instead of the key field; what it ends with is an
 * ordinary key row in the table below. The form checks itself against the
 * schema the server parses with (`cloud-credentials.ts`).
 */

import { useRouter } from "next/navigation";
import { ExternalLink, Loader2 } from "lucide-react";
import { useMemo, useState } from "react";
import {
    Button,
    Card,
    CardBody,
    CardHeader,
    CardTitle,
    Dialog,
    DialogContent,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Input,
    SegmentedControl,
    Textarea
} from "@polaris/ui";
import { runAction } from "@/lib/run-action";
import { IntegrationLogo } from "@/components/logos";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { useChooseFiles } from "@/components/file-picker/use-choose-files";
import { cloudCredentialSchema, type CloudProvider } from "@/lib/agents/cloud-credentials";
import {
    addCloudAccountAction,
    finishDigitaloceanLoginAction,
    startDigitaloceanLoginAction,
    type CloudAddResult
} from "@/app/(app)/account/ai-keys/cloud-actions";

const CLOUDS: readonly { provider: CloudProvider; name: string }[] = [
    { provider: "amazon-bedrock", name: "Amazon Bedrock" }, // i18n-ignore: product name
    { provider: "azure", name: "Azure OpenAI" }, // i18n-ignore: product name
    { provider: "google-vertex", name: "Google Vertex AI" }, // i18n-ignore: product name
    { provider: "snowflake-cortex", name: "Snowflake Cortex" }, // i18n-ignore: product name
    { provider: "digitalocean", name: "DigitalOcean" } // i18n-ignore: product name
];

type FieldKind = "text" | "secret" | "long";
type MethodKey = "keys" | "api-key" | "key" | "entra" | "service-account" | "pat" | "oauth";
type FieldKey =
    | "accessKeyId"
    | "secretAccessKey"
    | "sessionToken"
    | "region"
    | "apiKey"
    | "endpoint"
    | "deployments"
    | "tenantId"
    | "clientId"
    | "clientSecret"
    | "serviceAccount"
    | "project"
    | "location"
    | "account"
    | "token";
interface Field {
    key: FieldKey;
    kind: FieldKind;
    optional?: boolean;
    placeholder?: string;
}

/** Each provider's ways in, and the fields each one asks for. */
const METHODS: Record<CloudProvider, Partial<Record<MethodKey, readonly Field[]>>> = {
    "amazon-bedrock": {
        keys: [
            { key: "accessKeyId", kind: "text", placeholder: "AKIA..." }, // i18n-ignore: format
            { key: "secretAccessKey", kind: "secret" },
            { key: "sessionToken", kind: "secret", optional: true },
            { key: "region", kind: "text", placeholder: "us-east-1" } // i18n-ignore: example value
        ],
        "api-key": [
            { key: "apiKey", kind: "secret" },
            { key: "region", kind: "text", placeholder: "us-east-1" } // i18n-ignore: example value
        ]
    },
    azure: {
        key: [
            { key: "endpoint", kind: "text", placeholder: "https://my-resource.openai.azure.com" }, // i18n-ignore: example
            { key: "apiKey", kind: "secret" },
            { key: "deployments", kind: "text", optional: true }
        ],
        entra: [
            { key: "endpoint", kind: "text", placeholder: "https://my-resource.openai.azure.com" }, // i18n-ignore: example
            { key: "tenantId", kind: "text" },
            { key: "clientId", kind: "text" },
            { key: "clientSecret", kind: "secret" },
            { key: "deployments", kind: "text", optional: true }
        ]
    },
    "google-vertex": {
        "service-account": [
            { key: "serviceAccount", kind: "long" },
            { key: "project", kind: "text" },
            { key: "location", kind: "text", placeholder: "global" } // i18n-ignore: example value
        ]
    },
    "snowflake-cortex": {
        pat: [
            { key: "account", kind: "text", placeholder: "myorg-myaccount" }, // i18n-ignore: example value
            { key: "token", kind: "secret" }
        ]
    },
    digitalocean: {
        oauth: [],
        key: [{ key: "token", kind: "secret" }]
    }
};

const DOCS: Record<CloudProvider, string> = {
    "amazon-bedrock": "https://docs.aws.amazon.com/bedrock/latest/userguide/api-keys.html",
    azure: "https://learn.microsoft.com/en-us/azure/ai-foundry/openai/reference",
    "google-vertex": "https://cloud.google.com/iam/docs/keys-create-delete",
    "snowflake-cortex": "https://docs.snowflake.com/en/user-guide/programmatic-access-tokens",
    digitalocean: "https://docs.digitalocean.com/products/gradient-ai-platform/how-to/use-serverless-inference/"
};

/** The request body a form's values make, before the schema sees it. */
function payloadOf(provider: CloudProvider, method: MethodKey, values: Record<string, string>): unknown {
    const body: Record<string, unknown> = { provider, method };
    for (const field of METHODS[provider][method] ?? []) {
        const value = values[field.key] ?? "";
        if (field.key === "deployments") {
            body.deployments = value
                .split(/[\s,]+/)
                .map((entry) => entry.trim())
                .filter(Boolean);
        } else if (field.key === "serviceAccount") {
            try {
                body.serviceAccount = JSON.parse(value);
            } catch {
                body.serviceAccount = null;
            }
        } else if (!(field.optional && value.trim() === "")) {
            body[field.key] = value;
        }
    }
    return body;
}

export function CloudAccounts() {
    const t = useTranslations("account");
    const [open, setOpen] = useState<CloudProvider | null>(null);
    return (
        <Card>
            <CardHeader>
                <CardTitle>{t("aiKeys.cloud.title")}</CardTitle>
                <p className="text-muted-foreground text-xs">{t("aiKeys.cloud.hint")}</p>
            </CardHeader>
            <CardBody className="flex flex-wrap gap-2">
                {CLOUDS.map((cloud) => (
                    <Button key={cloud.provider} size="sm" variant="outline" onClick={() => setOpen(cloud.provider)}>
                        <IntegrationLogo slug={cloud.provider} name={cloud.name} className="size-4 shrink-0" />
                        <span className="min-w-0 truncate">{t("aiKeys.cloud.add", { name: cloud.name })}</span>
                    </Button>
                ))}
            </CardBody>
            {open ? (
                <CloudDialog
                    provider={open}
                    name={CLOUDS.find((cloud) => cloud.provider === open)?.name ?? open}
                    onClose={() => setOpen(null)}
                />
            ) : null}
        </Card>
    );
}

function CloudDialog({ provider, name, onClose }: { provider: CloudProvider; name: string; onClose: () => void }) {
    const t = useTranslations("account");
    const router = useRouter();
    const methods = Object.keys(METHODS[provider]) as MethodKey[];
    const [method, setMethod] = useState(methods[0]!);
    const [values, setValues] = useState<Record<string, string>>({ location: "global" }); // i18n-ignore: value
    const [busy, setBusy] = useState(false);
    const [failure, setFailure] = useState<string | null>(null);
    const [login, setLogin] = useState<{ id: string; url: string } | null>(null);
    const fields = METHODS[provider][method] ?? [];
    const oauth = provider === "digitalocean" && method === "oauth";

    const parsed = useMemo(
        () => cloudCredentialSchema.safeParse(payloadOf(provider, method, values)),
        [provider, method, values]
    );
    /** Fields that hold something the schema refuses; an empty one is only incomplete. */
    const invalid = new Set(
        parsed.success
            ? []
            : parsed.error.issues
                  .map((issue) => String(issue.path[0] ?? ""))
                  .filter((key) => (values[key] ?? "").trim() !== "")
    );

    const set = (key: string, value: string) => {
        setFailure(null);
        setValues((current) => {
            const next = { ...current, [key]: value };
            // A service account names its project; offered until one is typed.
            if (key === "serviceAccount" && !current.project) {
                try {
                    const project = (JSON.parse(value) as { project_id?: unknown }).project_id;
                    if (typeof project === "string") next.project = project;
                } catch {
                    // Not JSON yet.
                }
            }
            return next;
        });
    };

    const [choose, chooser] = useChooseFiles();
    const loadFile = async () => {
        const [file] = await choose({ accept: "application/json,.json" });
        if (!file || file.size > 64 * 1024) return;
        void file.text().then((content) => set("serviceAccount", content));
    };

    const finish = (result: CloudAddResult | null) => {
        setBusy(false);
        if (!result) return;
        if (result.ok) {
            router.refresh();
            onClose();
            return;
        }
        setFailure(failureText(result.reason));
    };

    const failureText = (reason: string) => {
        switch (reason) {
            case "refused":
                return t("aiKeys.cloud.refused", { name });
            case "no-deployments":
                return t("aiKeys.cloud.noDeployments");
            case "bad-paste":
                return t("aiKeys.cloud.badPaste");
            case "denied":
                return t("aiKeys.cloud.denied");
            case "gone":
                return t("aiKeys.cloud.gone");
            case "invalid":
                return t("aiKeys.cloud.invalid");
            default:
                return t("aiKeys.cloud.unreachable", { name });
        }
    };

    const submit = () => {
        if (busy) return;
        if (oauth) {
            if (!login) return;
            setBusy(true);
            void runAction(
                () => finishDigitaloceanLoginAction({ id: login.id, pasted: values.pasted ?? "" }),
                setFailure
            ).then(finish);
            return;
        }
        if (!parsed.success) return;
        setBusy(true);
        void runAction(() => addCloudAccountAction(parsed.data), setFailure).then(finish);
    };

    const startLogin = () => {
        setFailure(null);
        void runAction(() => startDigitaloceanLoginAction(), setFailure).then((started) => {
            if (!started) return;
            setLogin(started);
            window.open(started.url, "_blank", "noopener,noreferrer");
        });
    };

    const ready = oauth ? Boolean(login && (values.pasted ?? "").trim()) : parsed.success;

    return (
        <Dialog open onOpenChange={(next) => (next ? undefined : onClose())}>
            <DialogContent className="max-w-lg">
                <DialogHeader>
                    <DialogTitle>{t("aiKeys.cloud.add", { name })}</DialogTitle>
                </DialogHeader>
                <div className="flex min-w-0 flex-col gap-3">
                    {methods.length > 1 ? (
                        <SegmentedControl
                            aria-label={t("aiKeys.cloud.method")}
                            value={method}
                            onValueChange={(next) => {
                                setMethod(next);
                                setFailure(null);
                            }}
                            options={methods.map((value) => ({ value, label: t(`aiKeys.cloud.methods.${value}`) }))}
                        />
                    ) : null}
                    <p className="text-muted-foreground text-xs">
                        {t(`aiKeys.cloud.about.${provider}`)}{" "}
                        <a
                            className="inline-flex items-center gap-1 underline"
                            href={DOCS[provider]}
                            target="_blank"
                            rel="noreferrer noopener"
                        >
                            {t("aiKeys.cloud.docs")}
                            <ExternalLink className="size-3 shrink-0" />
                        </a>
                    </p>
                    {oauth ? (
                        <div className="flex min-w-0 flex-col gap-2">
                            <p className="text-muted-foreground text-xs">{t("aiKeys.cloud.digitalocean.steps")}</p>
                            <Button size="sm" variant="outline" className="self-start" onClick={startLogin}>
                                {login ? t("aiKeys.cloud.digitalocean.again") : t("aiKeys.cloud.digitalocean.open")}
                            </Button>
                            {login ? (
                                <label className="flex min-w-0 flex-col gap-1 text-sm">
                                    <span>{t("aiKeys.cloud.digitalocean.paste")} *</span>
                                    <Input
                                        value={values.pasted ?? ""}
                                        onChange={(event) => set("pasted", event.target.value)}
                                        placeholder="http://localhost:1456/auth/callback#access_token=..." // i18n-ignore: address
                                    />
                                </label>
                            ) : null}
                        </div>
                    ) : null}
                    {fields.map((field) => (
                        <label key={field.key} className="flex min-w-0 flex-col gap-1 text-sm">
                            <span className="min-w-0">
                                {t(`aiKeys.cloud.fields.${field.key}`)}
                                {field.optional ? ` (${t("aiKeys.cloud.optional")})` : " *"}
                            </span>
                            {field.kind === "long" ? (
                                <>
                                    <Textarea
                                        rows={5}
                                        className="font-mono text-xs"
                                        value={values[field.key] ?? ""}
                                        onChange={(event) => set(field.key, event.target.value)}
                                        aria-invalid={invalid.has(field.key) || undefined}
                                        placeholder={t("aiKeys.cloud.serviceAccountPlaceholder")}
                                    />
                                    <Button
                                        type="button"
                                        size="sm"
                                        variant="outline"
                                        className="self-start"
                                        onClick={() => void loadFile()}
                                    >
                                        {t("aiKeys.cloud.chooseFile")}
                                    </Button>
                                    {chooser}
                                </>
                            ) : (
                                <Input
                                    type={field.kind === "secret" ? "password" : "text"}
                                    autoComplete="off"
                                    value={values[field.key] ?? ""}
                                    onChange={(event) => set(field.key, event.target.value)}
                                    aria-invalid={invalid.has(field.key) || undefined}
                                    placeholder={field.placeholder}
                                />
                            )}
                            {field.key === "deployments" ? (
                                <span className="text-muted-foreground text-xs">{t("aiKeys.cloud.deploymentsHint")}</span>
                            ) : null}
                            {invalid.has(field.key) ? (
                                <span className="text-destructive text-xs">
                                    {t(`aiKeys.cloud.fieldInvalid.${field.key}`)}
                                </span>
                            ) : null}
                        </label>
                    ))}
                    {failure ? <p className="text-destructive text-sm">{failure}</p> : null}
                </div>
                <DialogFooter>
                    <Button variant="ghost" onClick={onClose}>
                        {t("aiKeys.cloud.cancel")}
                    </Button>
                    <Button onClick={submit} aria-disabled={!ready || busy} disabled={busy}>
                        {busy ? <Loader2 className="size-4 shrink-0 animate-spin" /> : null}
                        {t("aiKeys.cloud.save")}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
