"use client";

import { useMemo, useState } from "react";
import * as core from "@polaris/core";
import { Check, Plus, X } from "lucide-react";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { validationMessage } from "@/components/i18n/validation-message";
import type { SamlCheck, SamlProviderView } from "@/lib/saml-providers";
import { checkSamlProviderAction, deleteSamlProviderAction, saveSamlProviderAction } from "./actions";
import {
    Badge,
    Button,
    Card,
    CardBody,
    CardHeader,
    CardTitle,
    ConfirmDeleteDialog,
    CopyButton,
    Input,
    SegmentedControl,
    Switch,
    Textarea
} from "@polaris/ui";

type SourceKind = core.SamlSource["kind"];

/** Each refusal's sentence; the server never sends its own words for these. */
const PROBLEMS = {
    metadata: "sso.problems.metadata",
    certificate: "sso.problems.certificate",
    certificateExpired: "sso.problems.certificateExpired",
    ssoUrl: "sso.problems.ssoUrl",
    fetch: "sso.problems.fetch",
    domainTaken: "sso.problems.domainTaken",
    notFound: "sso.problems.notFound",
    invalid: "sso.problems.invalid",
    failed: "sso.problems.failed"
} as const;

interface Draft {
    name: string;
    domains: string;
    kind: SourceKind;
    url: string;
    xml: string;
    entityId: string;
    ssoUrl: string;
    certificate: string;
    email: string;
    displayName: string;
    firstName: string;
    lastName: string;
    allowSignUp: boolean;
    enforced: boolean;
}

function draftFor(provider: SamlProviderView | null): Draft {
    return {
        name: provider?.name ?? "",
        domains: provider?.domains.join(", ") ?? "",
        kind: provider ? "current" : "metadataUrl",
        url: "",
        xml: "",
        entityId: provider?.entityId ?? "",
        ssoUrl: provider?.ssoUrl ?? "",
        certificate: "",
        email: provider?.mapping.email ?? core.DEFAULT_SAML_MAPPING.email,
        displayName: provider?.mapping.name ?? core.DEFAULT_SAML_MAPPING.name,
        firstName: provider?.mapping.firstName ?? core.DEFAULT_SAML_MAPPING.firstName ?? "",
        lastName: provider?.mapping.lastName ?? core.DEFAULT_SAML_MAPPING.lastName ?? "",
        allowSignUp: provider?.allowSignUp ?? false,
        enforced: provider?.enforced ?? false
    };
}

/** The form's values in the shape the schema parses, on both sides. */
function inputFor(draft: Draft): unknown {
    const source =
        draft.kind === "current"
            ? { kind: draft.kind }
            : draft.kind === "metadataUrl"
            ? { kind: draft.kind, url: draft.url }
              : draft.kind === "metadataXml"
                ? { kind: draft.kind, xml: draft.xml }
                : { kind: draft.kind, entityId: draft.entityId, ssoUrl: draft.ssoUrl, certificate: draft.certificate };
    return {
        name: draft.name,
        domains: draft.domains.split(/[\s,]+/).filter(Boolean),
        source,
        mapping: { email: draft.email, name: draft.displayName, firstName: draft.firstName, lastName: draft.lastName },
        allowSignUp: draft.allowSignUp,
        enforced: draft.enforced
    };
}

function Field({ label, error, children }: { label: string; error?: string | null; children: React.ReactNode }) {
    return (
        <label className="flex min-w-0 flex-col gap-1 text-sm">
            <span className="font-medium">{label}</span>
            {children}
            {error ? <span className="text-xs text-danger">{error}</span> : null}
        </label>
    );
}

function Copyable({ label, value }: { label: string; value: string }) {
    return (
        <div className="flex min-w-0 flex-col gap-1">
            <span className="text-xs text-muted-foreground">{label}</span>
            <div className="flex min-w-0 items-center gap-2">
                <code className="min-w-0 flex-1 truncate rounded bg-muted px-2 py-1 text-xs" title={value}>
                    {value}
                </code>
                <CopyButton value={value} label={label} />
            </div>
        </div>
    );
}

function ProviderForm({
    provider,
    onDone
}: {
    provider: SamlProviderView | null;
    onDone: (saved: SamlProviderView | null) => void;
}) {
    const t = useTranslations("admin");
    const tv = useTranslations("validation");
    const initial = useMemo(() => draftFor(provider), [provider]);
    const [draft, setDraft] = useState<Draft>(initial);
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const parsed = core.samlProviderInputSchema.safeParse(inputFor(draft));
    const issues = parsed.success ? [] : parsed.error.issues;
    // Core words its refusals in English; they are shown in the reader's language.
    const issueFor = (path: string) => {
        const issue = issues.find((entry) => {
            const at = entry.path.join(".");
            return at === path || at.startsWith(`${path}.`);
        });
        return issue ? validationMessage(tv, issue.message) : null;
    };
    // Saving what is already saved does nothing, so an untouched edit cannot be sent.
    const changed = provider === null || JSON.stringify(draft) !== JSON.stringify(initial);
    const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((prev) => ({ ...prev, [key]: value }));

    async function save() {
        if (!parsed.success || !changed) return;
        setPending(true);
        setError(null);
        const outcome = await saveSamlProviderAction(inputFor(draft), provider?.providerId ?? null);
        setPending(false);
        if (outcome.ok) onDone(outcome.value);
        else setError(outcome.message ? validationMessage(tv, outcome.message) : t(PROBLEMS[outcome.problem]));
    }

    const touched = (value: string) => value.trim().length > 0;
    return (
        <Card>
            <CardHeader>
                <CardTitle>{provider ? provider.name : t("sso.form.newTitle")}</CardTitle>
            </CardHeader>
            <CardBody className="flex flex-col gap-4">
                <div className="grid gap-3 sm:grid-cols-2">
                    <Field label={`${t("sso.form.name")} *`} error={touched(draft.name) ? issueFor("name") : null}>
                        <Input value={draft.name} onChange={(event) => set("name", event.target.value)} />
                    </Field>
                    <Field label={`${t("sso.form.domains")} *`} error={touched(draft.domains) ? issueFor("domains") : null}>
                        <Input
                            value={draft.domains}
                            placeholder="example.com"
                            onChange={(event) => set("domains", event.target.value)}
                        />
                    </Field>
                </div>
                <div className="flex flex-col gap-2">
                    <span className="text-sm font-medium">{t("sso.form.source")}</span>
                    <SegmentedControl
                        aria-label={t("sso.form.source")}
                        value={draft.kind}
                        onValueChange={(kind) => set("kind", kind)}
                        options={[
                            ...(provider ? [{ value: "current" as const, label: t("sso.form.sourceCurrent") }] : []),
                            { value: "metadataUrl", label: t("sso.form.sourceUrl") },
                            { value: "metadataXml", label: t("sso.form.sourceXml") },
                            { value: "manual", label: t("sso.form.sourceManual") }
                        ]}
                    />
                    {provider && draft.kind !== "current" ? (
                        <p className="text-xs text-muted-foreground">{t("sso.form.replaceHint")}</p>
                    ) : null}
                </div>
                {draft.kind === "current" ? (
                    <p className="min-w-0 break-all text-xs text-muted-foreground">{provider?.entityId}</p>
                ) : draft.kind === "metadataUrl" ? (
                    <Field label={`${t("sso.form.metadataUrl")} *`} error={touched(draft.url) ? issueFor("source") : null}>
                        <Input
                            value={draft.url}
                            placeholder="https://"
                            onChange={(event) => set("url", event.target.value)}
                        />
                    </Field>
                ) : draft.kind === "metadataXml" ? (
                    <Field label={`${t("sso.form.metadataXml")} *`} error={touched(draft.xml) ? issueFor("source") : null}>
                        <Textarea rows={6} value={draft.xml} onChange={(event) => set("xml", event.target.value)} />
                    </Field>
                ) : (
                    <div className="grid gap-3">
                        <Field
                            label={`${t("sso.form.entityId")} *`}
                            error={touched(draft.entityId) ? issueFor("source.entityId") : null}
                        >
                            <Input value={draft.entityId} onChange={(event) => set("entityId", event.target.value)} />
                        </Field>
                        <Field
                            label={`${t("sso.form.ssoUrl")} *`}
                            error={touched(draft.ssoUrl) ? issueFor("source.ssoUrl") : null}
                        >
                            <Input
                                value={draft.ssoUrl}
                                placeholder="https://"
                                onChange={(event) => set("ssoUrl", event.target.value)}
                            />
                        </Field>
                        <Field
                            label={`${t("sso.form.certificate")} *`}
                            error={touched(draft.certificate) ? issueFor("source.certificate") : null}
                        >
                            <Textarea
                                rows={5}
                                value={draft.certificate}
                                placeholder="-----BEGIN CERTIFICATE-----"
                                onChange={(event) => set("certificate", event.target.value)}
                            />
                        </Field>
                    </div>
                )}
                <div className="flex flex-col gap-2">
                    <span className="text-sm font-medium">{t("sso.form.mapping")}</span>
                    <div className="grid gap-3 sm:grid-cols-2">
                        <Field
                            label={`${t("sso.form.mapEmail")} *`}
                            error={touched(draft.email) ? issueFor("mapping.email") : null}
                        >
                            <Input value={draft.email} onChange={(event) => set("email", event.target.value)} />
                        </Field>
                        <Field
                            label={`${t("sso.form.mapName")} *`}
                            error={touched(draft.displayName) ? issueFor("mapping.name") : null}
                        >
                            <Input value={draft.displayName} onChange={(event) => set("displayName", event.target.value)} />
                        </Field>
                        <Field label={t("sso.form.mapFirstName")} error={issueFor("mapping.firstName")}>
                            <Input value={draft.firstName} onChange={(event) => set("firstName", event.target.value)} />
                        </Field>
                        <Field label={t("sso.form.mapLastName")} error={issueFor("mapping.lastName")}>
                            <Input value={draft.lastName} onChange={(event) => set("lastName", event.target.value)} />
                        </Field>
                    </div>
                </div>
                <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                        <p className="text-sm font-medium">{t("sso.form.allowSignUp")}</p>
                        <p className="text-xs text-muted-foreground">{t("sso.form.allowSignUpHint")}</p>
                    </div>
                    <Switch
                        checked={draft.allowSignUp}
                        onChange={(value) => set("allowSignUp", value)}
                        aria-label={t("sso.form.allowSignUp")}
                    />
                </div>
                <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                        <p className="text-sm font-medium">{t("sso.form.enforced")}</p>
                        <p className="text-xs text-muted-foreground">{t("sso.form.enforcedHint")}</p>
                    </div>
                    <Switch
                        checked={draft.enforced}
                        onChange={(value) => set("enforced", value)}
                        aria-label={t("sso.form.enforced")}
                    />
                </div>
                {error ? <p className="text-sm text-danger">{error}</p> : null}
                <div className="flex flex-wrap justify-end gap-2">
                    <Button type="button" variant="ghost" disabled={pending} onClick={() => onDone(null)}>
                        {t("sso.form.cancel")}
                    </Button>
                    <Button
                        type="button"
                        disabled={pending || !parsed.success || !changed}
                        aria-disabled={!parsed.success || !changed}
                        onClick={() => void save()}
                    >
                        {pending ? t("sso.form.saving") : t("sso.form.save")}
                    </Button>
                </div>
            </CardBody>
        </Card>
    );
}

function ProviderCard({
    provider,
    onEdit,
    onChecked,
    onDeleted
}: {
    provider: SamlProviderView;
    onEdit: () => void;
    onChecked: (provider: SamlProviderView) => void;
    onDeleted: () => void;
}) {
    const t = useTranslations("admin");
    const [checks, setChecks] = useState<SamlCheck[] | null>(null);
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [confirming, setConfirming] = useState(false);

    async function check() {
        setPending(true);
        setError(null);
        const outcome = await checkSamlProviderAction(provider.providerId);
        setPending(false);
        if (outcome.ok) {
            setChecks(outcome.value.checks);
            onChecked(outcome.value.provider);
        } else setError(t(PROBLEMS[outcome.problem]));
    }

    return (
        <Card>
            <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
                <CardTitle className="min-w-0 truncate">{provider.name}</CardTitle>
                <div className="flex flex-wrap gap-1">
                    <Badge variant={provider.domainVerified ? "success" : "warning"}>
                        {provider.domainVerified ? t("sso.card.verified") : t("sso.card.unverified")}
                    </Badge>
                    {provider.enforced ? <Badge>{t("sso.card.enforced")}</Badge> : null}
                    {provider.allowSignUp ? <Badge>{t("sso.card.jit")}</Badge> : null}
                </div>
            </CardHeader>
            <CardBody className="flex flex-col gap-4">
                <p className="text-sm text-muted-foreground">{provider.domains.join(", ")}</p>
                <div className="grid gap-3">
                    <Copyable label={t("sso.card.spEntityId")} value={provider.serviceProvider.entityId} />
                    <Copyable label={t("sso.card.acsUrl")} value={provider.serviceProvider.acsUrl} />
                    <Copyable label={t("sso.card.spMetadata")} value={provider.serviceProvider.metadataUrl} />
                </div>
                {provider.domainVerified ? null : (
                    <div className="flex flex-col gap-2">
                        <p className="text-sm">{t("sso.card.recordsIntro")}</p>
                        {provider.records.map((record) => (
                            <div key={record.name} className="grid gap-2 sm:grid-cols-2">
                                <Copyable label={t("sso.card.recordName")} value={record.name} />
                                <Copyable label={t("sso.card.recordValue")} value={record.value} />
                            </div>
                        ))}
                    </div>
                )}
                {checks ? (
                    <ul className="flex flex-col gap-1 text-sm">
                        {checks.map((entry, index) => (
                            <li key={`${entry.key}-${index}`} className="flex min-w-0 items-center gap-2">
                                {entry.ok ? (
                                    <Check className="size-4 shrink-0 text-success" aria-hidden />
                                ) : (
                                    <X className="size-4 shrink-0 text-danger" aria-hidden />
                                )}
                                <span
                                    className="min-w-0 truncate"
                                    title={entry.detail ? `${t(`sso.checks.${entry.key}`)} - ${entry.detail}` : undefined}
                                >
                                    {t(`sso.checks.${entry.key}`)}
                                    {entry.detail ? ` - ${entry.detail}` : ""}
                                </span>
                            </li>
                        ))}
                    </ul>
                ) : null}
                {error ? <p className="text-sm text-danger">{error}</p> : null}
                <div className="flex flex-wrap justify-end gap-2">
                    <Button type="button" variant="ghost" onClick={() => setConfirming(true)}>
                        {t("sso.card.remove")}
                    </Button>
                    <Button type="button" variant="secondary" onClick={onEdit}>
                        {t("sso.card.edit")}
                    </Button>
                    <Button type="button" disabled={pending} onClick={() => void check()}>
                        {pending ? t("sso.card.checking") : t("sso.card.check")}
                    </Button>
                </div>
            </CardBody>
            <ConfirmDeleteDialog
                open={confirming}
                onOpenChange={setConfirming}
                name={provider.name}
                kind={t("sso.card.kind")}
                description={t("sso.card.removeHint")}
                onConfirm={async () => {
                    const outcome = await deleteSamlProviderAction(provider.providerId);
                    if (outcome.ok) onDeleted();
                    else setError(t(PROBLEMS[outcome.problem]));
                }}
            />
        </Card>
    );
}

export function SsoAdmin({ providers: initial }: { providers: SamlProviderView[] }) {
    const t = useTranslations("admin");
    const [providers, setProviders] = useState(initial);
    const [editing, setEditing] = useState<string | "new" | null>(null);

    function saved(provider: SamlProviderView | null) {
        setEditing(null);
        if (provider) replace(provider);
    }

    function replace(provider: SamlProviderView) {
        setProviders((list) =>
            list.some((entry) => entry.providerId === provider.providerId)
                ? list.map((entry) => (entry.providerId === provider.providerId ? provider : entry))
                : [...list, provider]
        );
    }

    return (
        <div className="flex max-w-3xl flex-col gap-3">
            {providers.length === 0 && editing !== "new" ? (
                <p className="text-sm text-muted-foreground">{t("sso.empty")}</p>
            ) : null}
            {providers.map((provider) =>
                editing === provider.providerId ? (
                    <ProviderForm key={provider.providerId} provider={provider} onDone={saved} />
                ) : (
                    <ProviderCard
                        key={provider.providerId}
                        provider={provider}
                        onEdit={() => setEditing(provider.providerId)}
                        onChecked={replace}
                        onDeleted={() => setProviders((list) => list.filter((entry) => entry.providerId !== provider.providerId))}
                    />
                )
            )}
            {editing === "new" ? (
                <ProviderForm provider={null} onDone={saved} />
            ) : (
                <div>
                    <Button type="button" variant="secondary" onClick={() => setEditing("new")}>
                        <Plus className="size-4 shrink-0" aria-hidden />
                        {t("sso.add")}
                    </Button>
                </div>
            )}
        </div>
    );
}
