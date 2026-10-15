"use client";

/**
 * Adding or editing one registry login.
 *
 * Validated as it is typed against the schema the server checks again. A field
 * left empty is unfinished rather than wrong, so it shows no error until it has
 * been touched; the save button stays off until the whole form passes.
 */

import { useState, useTransition } from "react";
import { Loader2, PlugZap } from "lucide-react";
import { useTranslations } from "@/components/i18n/i18n-provider";
import {
    Button,
    Dialog,
    DialogContent,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Input,
    Select
} from "@polaris/ui";
import {
    REGISTRY_DEFAULT_HOST,
    REGISTRY_KINDS,
    REGISTRY_NAME_MAX,
    REGISTRY_SECRET_MAX,
    REGISTRY_USERNAME_MAX,
    registryFormIssues,
    type RegistryFormValues,
    type RegistryKind
} from "@/lib/registries/registry-form";
import { RegistryKindIcon } from "./registry-kind-icon";
import type { RegistryView } from "@/lib/registry-credential-service";
import {
    createRegistryAction,
    testRegistryAction,
    updateRegistryAction
} from "../registry-actions";

type Field = keyof RegistryFormValues;

export function RegistryDialog({
    registry,
    onClose,
    onSaved
}: {
    registry: RegistryView | null;
    onClose: () => void;
    onSaved: (registry: RegistryView) => void;
}) {
    const t = useTranslations("deployRegistries");
    const editing = registry !== null;
    const initial: RegistryFormValues = {
        kind: registry?.kind ?? "dockerhub",
        name: registry?.name === registry?.registry ? "" : (registry?.name ?? ""),
        host: registry?.registry ?? "",
        username: registry?.username ?? "",
        password: ""
    };
    const [values, setValues] = useState<RegistryFormValues>(initial);
    const [touched, setTouched] = useState<Partial<Record<Field, boolean>>>({});
    const [error, setError] = useState<string | null>(null);
    const [testNote, setTestNote] = useState<{ ok: boolean; text: string } | null>(null);
    const [pending, startTransition] = useTransition();
    const [testing, startTest] = useTransition();

    const issues = registryFormIssues(values, editing);
    const valid = Object.keys(issues).length === 0;
    const dirty = (Object.keys(initial) as Field[]).some(
        (field) => initial[field] !== values[field]
    );

    function set(field: Field, value: string) {
        setValues((current) => ({ ...current, [field]: value }));
        setTouched((current) => ({ ...current, [field]: true }));
        setTestNote(null);
    }

    function issueOf(field: Field): string | null {
        const key = issues[field];
        if (!key || !touched[field]) return null;
        return t(key as never);
    }

    function save() {
        if (!valid || !dirty) return;
        setError(null);
        startTransition(async () => {
            const answer = registry
                ? await updateRegistryAction(registry.id, values)
                : await createRegistryAction(values);
            if (answer.error || !answer.registry) {
                setError(answer.error ?? t("errors.saveFailed"));
                return;
            }
            onSaved(answer.registry);
        });
    }

    function test() {
        if (!valid) return;
        setTestNote(null);
        startTest(async () => {
            const answer = await testRegistryAction({
                ...(registry ? { id: registry.id } : {}),
                values
            });
            if (answer.error || !answer.result) {
                setTestNote({ ok: false, text: answer.error ?? t("errors.testFailed") });
                return;
            }
            setTestNote({ ok: answer.result === "ok", text: t(`test.${answer.result}`) });
        });
    }

    const kindOptions = REGISTRY_KINDS.map((kind) => ({
        value: kind,
        label: t(`kinds.${kind}`),
        icon: <RegistryKindIcon kind={kind} />
    }));
    const hostPlaceholder = REGISTRY_DEFAULT_HOST[values.kind] || t("form.hostPlaceholder");

    return (
        <Dialog open onOpenChange={(open) => !open && onClose()}>
            <DialogContent className="max-w-lg">
                <DialogHeader>
                    <DialogTitle>{editing ? t("form.editTitle") : t("form.addTitle")}</DialogTitle>
                </DialogHeader>
                <form
                    className="flex min-w-0 flex-col gap-3"
                    onSubmit={(event) => {
                        event.preventDefault();
                        save();
                    }}
                >
                    <Labelled label={t("form.kind")} required>
                        <Select
                            value={values.kind}
                            onValueChange={(kind) => set("kind", kind as RegistryKind)}
                            options={kindOptions}
                            aria-label={t("form.kind")}
                        />
                    </Labelled>
                    <Labelled
                        label={t("form.name")}
                        hint={t("form.nameHint")}
                        issue={issueOf("name")}
                    >
                        <Input
                            value={values.name}
                            maxLength={REGISTRY_NAME_MAX}
                            placeholder={t("form.namePlaceholder")}
                            onChange={(event) => set("name", event.target.value)}
                            aria-invalid={issueOf("name") !== null}
                        />
                    </Labelled>
                    <Labelled
                        label={t("form.host")}
                        required={values.kind === "generic"}
                        hint={
                            values.kind === "generic"
                                ? t("form.hostHintGeneric")
                                : t("form.hostHint")
                        }
                        issue={issueOf("host")}
                    >
                        <Input
                            value={values.host}
                            placeholder={hostPlaceholder}
                            autoComplete="off"
                            spellCheck={false}
                            onChange={(event) => set("host", event.target.value)}
                            aria-invalid={issueOf("host") !== null}
                        />
                    </Labelled>
                    <Labelled
                        label={t(`hints.${values.kind}.user`)}
                        required
                        issue={issueOf("username")}
                    >
                        <Input
                            value={values.username}
                            maxLength={REGISTRY_USERNAME_MAX}
                            autoComplete="off"
                            spellCheck={false}
                            onChange={(event) => set("username", event.target.value)}
                            aria-invalid={issueOf("username") !== null}
                        />
                    </Labelled>
                    <Labelled
                        label={t(`hints.${values.kind}.secret`)}
                        required={!editing}
                        hint={editing ? t("form.secretKeep") : t(`hints.${values.kind}.secretHint`)}
                        issue={issueOf("password")}
                    >
                        {/* An existing token for somebody else's registry, not a password this account picks: enigma:allow-no-breach-check enigma:allow-identity-password */}
                        <Input
                            type="password"
                            value={values.password}
                            maxLength={REGISTRY_SECRET_MAX}
                            autoComplete="off"
                            onChange={(event) => set("password", event.target.value)}
                            aria-invalid={issueOf("password") !== null}
                        />
                    </Labelled>
                    {testNote && (
                        <p
                            role="status"
                            className={
                                testNote.ok ? "text-sm text-success-ink" : "text-sm text-danger"
                            }
                        >
                            {testNote.text}
                        </p>
                    )}
                    {error && (
                        <p role="alert" className="text-sm text-danger">
                            {error}
                        </p>
                    )}
                    <DialogFooter className="flex-wrap gap-2">
                        <Button
                            type="button"
                            variant="outline"
                            onClick={test}
                            disabled={!valid || testing}
                            title={valid ? undefined : t("form.fixFirst")}
                        >
                            {testing ? (
                                <Loader2 className="size-4 animate-spin" />
                            ) : (
                                <PlugZap className="size-4" />
                            )}{" "}
                            {t("test.button")}
                        </Button>
                        <Button type="submit" disabled={!valid || !dirty || pending}>
                            {pending && <Loader2 className="size-4 animate-spin" />}{" "}
                            {t("form.save")}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}

function Labelled({
    label,
    hint,
    issue,
    required,
    children
}: {
    label: string;
    hint?: string;
    issue?: string | null;
    required?: boolean;
    children: React.ReactNode;
}) {
    return (
        <label className="flex min-w-0 flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">
                {label}
                {required && <span aria-hidden> *</span>}
            </span>
            {children}
            {issue ? (
                <span className="text-xs text-danger">{issue}</span>
            ) : hint ? (
                <span className="text-xs text-muted-foreground">{hint}</span>
            ) : null}
        </label>
    );
}
