"use client";

/**
 * The dialogs that create and change things on a status page. Each validates
 * as the person types against the same schema the server action uses; an empty
 * required field is marked with a star and holds the button, never shown as an
 * error.
 */

import type { ZodTypeAny } from "zod";
import { useEffect, useId, useState, type ReactNode } from "react";
import {
    Button,
    cn,
    Dialog,
    DialogContent,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Input,
    Select,
    Switch,
    Textarea,
    useToast
} from "@polaris/ui";
import { unwrap, useStatusT } from "./i18n";
import {
    checkInput,
    componentInput,
    incidentInput,
    incidentUpdateInput,
    maintenanceInput,
    normalizeSlug,
    pageInput
} from "../model/schemas";
import { INCIDENT_IMPACTS, INCIDENT_STATES } from "../model/incidents";
import { DNS_TYPES, MAX_INTERVAL_SEC, MIN_INTERVAL_SEC, type CheckKind } from "../model/checks";
import {
    deployedTargetsAction,
    openIncidentAction,
    postIncidentUpdateAction,
    saveCheckAction,
    saveComponentAction,
    saveMaintenanceAction,
    savePageAction
} from "../actions/manage";
import type { CheckView } from "../lib/manage";

type Values = Record<string, unknown>;

/** Which fields the schema refuses for these values, by field name. */
function fieldErrors(schema: ZodTypeAny, values: Values): Record<string, string> {
    const parsed = schema.safeParse(values);
    if (parsed.success) return {};
    const errors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
        const key = String(issue.path[0] ?? "");
        if (key && !errors[key]) errors[key] = issue.message;
    }
    return errors;
}

function blank(value: unknown): boolean {
    return value === "" || value === null || value === undefined;
}

function Field({
    label,
    required,
    error,
    hint,
    children
}: {
    label: string;
    required?: boolean;
    error?: string | null;
    hint?: string;
    children: (id: string) => ReactNode;
}) {
    const id = useId();
    return (
        <div className="min-w-0 space-y-1">
            <label htmlFor={id} className="text-xs font-medium">
                {label}
                {required ? <span aria-hidden> *</span> : null}
            </label>
            {children(id)}
            {error ? (
                <p className="text-xs text-danger" role="alert">
                    {error}
                </p>
            ) : hint ? (
                <p className="text-xs text-muted-foreground">{hint}</p>
            ) : null}
        </div>
    );
}

/** A dialog with a form: validated values in, one action out. */
function FormDialog({
    open,
    onOpenChange,
    title,
    schema,
    values,
    submitLabel,
    onSubmit,
    children
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    title: string;
    schema: ZodTypeAny;
    values: Values;
    submitLabel: string;
    onSubmit: () => Promise<void>;
    children: (errors: Record<string, string>) => ReactNode;
}) {
    const t = useStatusT();
    const toast = useToast();
    const [pending, setPending] = useState(false);
    const errors = fieldErrors(schema, values);
    const ready = Object.keys(errors).length === 0 && !pending;
    // An empty field is incomplete, not wrong: only a value that is there is
    // reported.
    const shown = Object.fromEntries(
        Object.entries(errors)
            .filter(([key]) => !blank(values[key]))
            .map(([key]) => [key, t("errors.fieldInvalid")])
    );
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
                <DialogHeader>
                    <DialogTitle>{title}</DialogTitle>
                </DialogHeader>
                <form
                    className="space-y-3"
                    onSubmit={(event) => {
                        event.preventDefault();
                        if (!ready) return;
                        setPending(true);
                        onSubmit()
                            .then(() => onOpenChange(false))
                            .catch((caught: Error) => toast.show({ title: t("errors.saveFailed"), body: caught.message }))
                            .finally(() => setPending(false));
                    }}
                >
                    {children(shown)}
                    <DialogFooter>
                        <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
                            {t("actions.cancel")}
                        </Button>
                        <Button type="submit" aria-disabled={!ready} className={ready ? undefined : "opacity-60"}>
                            {submitLabel}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}

export interface PageFormValues {
    readonly id: string | null;
    readonly title: string;
    readonly slug: string;
    readonly description: string;
    readonly published: boolean;
}

export function PageDialog({
    open,
    onOpenChange,
    initial,
    onSaved
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    initial: PageFormValues;
    onSaved: (id: string) => void;
}) {
    const t = useStatusT();
    const [values, setValues] = useState(initial);
    const [slugTouched, setSlugTouched] = useState(Boolean(initial.id));
    useEffect(() => {
        if (open) {
            setValues(initial);
            setSlugTouched(Boolean(initial.id));
        }
    }, [open, initial]);
    const normalized = { ...values, slug: normalizeSlug(values.slug) };
    return (
        <FormDialog
            open={open}
            onOpenChange={onOpenChange}
            title={initial.id ? t("page.editTitle") : t("page.newTitle")}
            schema={pageInput}
            values={normalized}
            submitLabel={initial.id ? t("actions.save") : t("actions.create")}
            onSubmit={async () => {
                const saved = await unwrap(() => savePageAction(normalized), t("errors.generic"));
                onSaved(saved.id);
            }}
        >
            {(errors) => (
                <>
                    <Field label={t("page.title")} required error={errors.title}>
                        {(id) => (
                            <Input
                                id={id}
                                value={values.title}
                                maxLength={80}
                                onChange={(event) => {
                                    const title = event.target.value;
                                    setValues((current) => ({
                                        ...current,
                                        title,
                                        slug: slugTouched ? current.slug : normalizeSlug(title).replace(/[^a-z0-9-]/g, "")
                                    }));
                                }}
                            />
                        )}
                    </Field>
                    <Field label={t("page.slug")} required error={errors.slug ? t("errors.slug") : null} hint={t("page.slugHint", { slug: normalized.slug || "..." })}>
                        {(id) => (
                            <Input
                                id={id}
                                value={values.slug}
                                maxLength={50}
                                onChange={(event) => {
                                    setSlugTouched(true);
                                    setValues((current) => ({ ...current, slug: event.target.value }));
                                }}
                            />
                        )}
                    </Field>
                    <Field label={t("page.description")} error={errors.description}>
                        {(id) => (
                            <Textarea
                                id={id}
                                value={values.description}
                                maxLength={500}
                                rows={2}
                                onChange={(event) => setValues((current) => ({ ...current, description: event.target.value }))}
                            />
                        )}
                    </Field>
                    <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0">
                            <p className="text-xs font-medium">{t("page.published")}</p>
                            <p className="text-xs text-muted-foreground">{t("page.publishedHint")}</p>
                        </div>
                        <Switch
                            checked={values.published}
                            aria-label={t("page.published")}
                            onChange={(published) => setValues((current) => ({ ...current, published }))}
                        />
                    </div>
                </>
            )}
        </FormDialog>
    );
}

export function ComponentDialog({
    open,
    onOpenChange,
    pageId,
    initial,
    onSaved
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    pageId: string;
    initial: { id: string | null; name: string; description: string };
    onSaved: () => void;
}) {
    const t = useStatusT();
    const [values, setValues] = useState(initial);
    useEffect(() => {
        if (open) setValues(initial);
    }, [open, initial]);
    const payload = { ...values, pageId };
    return (
        <FormDialog
            open={open}
            onOpenChange={onOpenChange}
            title={initial.id ? t("component.editTitle") : t("component.newTitle")}
            schema={componentInput}
            values={payload}
            submitLabel={initial.id ? t("actions.save") : t("actions.add")}
            onSubmit={async () => {
                await unwrap(() => saveComponentAction(payload), t("errors.generic"));
                onSaved();
            }}
        >
            {(errors) => (
                <>
                    <Field label={t("component.name")} required error={errors.name}>
                        {(id) => (
                            <Input
                                id={id}
                                value={values.name}
                                maxLength={80}
                                placeholder={t("component.namePlaceholder")}
                                onChange={(event) => setValues((current) => ({ ...current, name: event.target.value }))}
                            />
                        )}
                    </Field>
                    <Field label={t("component.description")} error={errors.description}>
                        {(id) => (
                            <Input
                                id={id}
                                value={values.description}
                                maxLength={300}
                                onChange={(event) => setValues((current) => ({ ...current, description: event.target.value }))}
                            />
                        )}
                    </Field>
                </>
            )}
        </FormDialog>
    );
}

interface CheckValues {
    kind: CheckKind;
    target: string;
    port: string;
    expectStatus: string;
    keyword: string;
    dnsType: string;
    dnsExpect: string;
    intervalSec: string;
    timeoutSec: string;
    enabled: boolean;
}

function checkValues(check: CheckView | null): CheckValues {
    return {
        kind: (check?.kind as CheckKind | undefined) ?? "http",
        target: check?.target ?? "",
        port: check?.port?.toString() ?? "",
        expectStatus: check?.expectStatus?.toString() ?? "",
        keyword: check?.keyword ?? "",
        dnsType: check?.dnsType ?? "A",
        dnsExpect: check?.dnsExpect ?? "",
        intervalSec: (check?.intervalSec ?? 60).toString(),
        timeoutSec: ((check?.timeoutMs ?? 10_000) / 1000).toString(),
        enabled: check?.enabled ?? true
    };
}

/** The values as the schema reads them, only the fields this kind uses. */
function checkPayload(componentId: string, id: string | null, values: CheckValues): Values {
    const base = {
        id,
        componentId,
        kind: values.kind,
        target: values.target.trim(),
        intervalSec: values.intervalSec.trim(),
        timeoutMs: values.timeoutSec.trim() === "" ? "" : Math.round(Number(values.timeoutSec) * 1000),
        enabled: values.enabled
    };
    switch (values.kind) {
        case "http":
            return {
                ...base,
                expectStatus: values.expectStatus.trim() === "" ? null : values.expectStatus.trim(),
                keyword: values.keyword
            };
        case "tcp":
            return { ...base, port: values.port.trim() };
        case "ping":
            return { ...base, port: values.port.trim() === "" ? 443 : values.port.trim() };
        case "dns":
            return { ...base, dnsType: values.dnsType, dnsExpect: values.dnsExpect };
    }
}

export function CheckDialog({
    open,
    onOpenChange,
    componentId,
    check,
    onSaved
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    componentId: string;
    check: CheckView | null;
    onSaved: () => void;
}) {
    const t = useStatusT();
    const [values, setValues] = useState(() => checkValues(check));
    const [targets, setTargets] = useState<{ label: string; url: string }[] | null>(null);
    useEffect(() => {
        if (!open) return;
        setValues(checkValues(check));
        let live = true;
        deployedTargetsAction()
            .then((answer) => {
                if (live && answer.ok) setTargets(answer.targets);
            })
            .catch(() => undefined);
        return () => {
            live = false;
        };
    }, [open, check]);
    const set = (patch: Partial<CheckValues>) => setValues((current) => ({ ...current, ...patch }));
    const payload = checkPayload(componentId, check?.id ?? null, values);
    return (
        <FormDialog
            open={open}
            onOpenChange={onOpenChange}
            title={check ? t("check.editTitle") : t("check.newTitle")}
            schema={checkInput}
            values={payload}
            submitLabel={check ? t("actions.save") : t("actions.add")}
            onSubmit={async () => {
                await unwrap(() => saveCheckAction(payload), t("errors.generic"));
                onSaved();
            }}
        >
            {(errors) => (
                <>
                    <Field label={t("check.kind")} required>
                        {(id) => (
                            <Select
                                id={id}
                                value={values.kind}
                                onValueChange={(kind) => set({ kind: kind as CheckKind })}
                                options={(["http", "tcp", "dns", "ping"] as const).map((kind) => ({
                                    value: kind,
                                    label: t(`check.kinds.${kind}`)
                                }))}
                            />
                        )}
                    </Field>
                    {values.kind === "http" && targets && targets.length > 0 ? (
                        <Field label={t("check.deployed")} hint={t("check.deployedHint")}>
                            {(id) => (
                                <Select
                                    id={id}
                                    value=""
                                    placeholder={t("check.deployedPlaceholder")}
                                    onValueChange={(url) => set({ target: url })}
                                    options={targets.map((target) => ({ value: target.url, label: target.label }))}
                                />
                            )}
                        </Field>
                    ) : null}
                    <Field
                        label={values.kind === "http" ? t("check.url") : t("check.host")}
                        required
                        error={errors.target}
                        hint={values.kind === "http" ? t("check.urlHint") : t("check.hostHint")}
                    >
                        {(id) => (
                            <Input
                                id={id}
                                value={values.target}
                                maxLength={2048}
                                inputMode="url"
                                placeholder={values.kind === "http" ? "https://example.com/health" : "example.com"}
                                onChange={(event) => set({ target: event.target.value })}
                            />
                        )}
                    </Field>
                    {values.kind === "http" ? (
                        <div className="grid gap-3 sm:grid-cols-2">
                            <Field label={t("check.expectStatus")} error={errors.expectStatus} hint={t("check.expectStatusHint")}>
                                {(id) => (
                                    <Input
                                        id={id}
                                        value={values.expectStatus}
                                        inputMode="numeric"
                                        maxLength={3}
                                        onChange={(event) => set({ expectStatus: event.target.value })}
                                    />
                                )}
                            </Field>
                            <Field label={t("check.keyword")} error={errors.keyword} hint={t("check.keywordHint")}>
                                {(id) => (
                                    <Input
                                        id={id}
                                        value={values.keyword}
                                        maxLength={200}
                                        onChange={(event) => set({ keyword: event.target.value })}
                                    />
                                )}
                            </Field>
                        </div>
                    ) : null}
                    {values.kind === "tcp" || values.kind === "ping" ? (
                        <Field
                            label={t("check.port")}
                            required={values.kind === "tcp"}
                            error={errors.port}
                            hint={values.kind === "ping" ? t("check.pingHint") : undefined}
                        >
                            {(id) => (
                                <Input
                                    id={id}
                                    value={values.port}
                                    inputMode="numeric"
                                    maxLength={5}
                                    placeholder={values.kind === "ping" ? "443" : undefined}
                                    onChange={(event) => set({ port: event.target.value })}
                                />
                            )}
                        </Field>
                    ) : null}
                    {values.kind === "dns" ? (
                        <div className="grid gap-3 sm:grid-cols-2">
                            <Field label={t("check.dnsType")} required>
                                {(id) => (
                                    <Select
                                        id={id}
                                        value={values.dnsType}
                                        onValueChange={(dnsType) => set({ dnsType })}
                                        options={DNS_TYPES.map((type) => ({ value: type, label: type }))}
                                    />
                                )}
                            </Field>
                            <Field label={t("check.dnsExpect")} error={errors.dnsExpect} hint={t("check.dnsExpectHint")}>
                                {(id) => (
                                    <Input
                                        id={id}
                                        value={values.dnsExpect}
                                        maxLength={255}
                                        onChange={(event) => set({ dnsExpect: event.target.value })}
                                    />
                                )}
                            </Field>
                        </div>
                    ) : null}
                    <div className="grid gap-3 sm:grid-cols-2">
                        <Field
                            label={t("check.interval")}
                            required
                            error={errors.intervalSec}
                            hint={t("check.intervalHint", { min: MIN_INTERVAL_SEC.toString(), max: MAX_INTERVAL_SEC.toString() })}
                        >
                            {(id) => (
                                <Input
                                    id={id}
                                    value={values.intervalSec}
                                    inputMode="numeric"
                                    maxLength={4}
                                    onChange={(event) => set({ intervalSec: event.target.value })}
                                />
                            )}
                        </Field>
                        <Field label={t("check.timeout")} required error={errors.timeoutMs} hint={t("check.timeoutHint")}>
                            {(id) => (
                                <Input
                                    id={id}
                                    value={values.timeoutSec}
                                    inputMode="decimal"
                                    maxLength={4}
                                    onChange={(event) => set({ timeoutSec: event.target.value })}
                                />
                            )}
                        </Field>
                    </div>
                    <div className="flex items-center justify-between gap-3">
                        <p className="text-xs font-medium">{t("check.enabled")}</p>
                        <Switch checked={values.enabled} aria-label={t("check.enabled")} onChange={(enabled) => set({ enabled })} />
                    </div>
                </>
            )}
        </FormDialog>
    );
}

function ComponentPicker({
    components,
    selected,
    onChange
}: {
    components: readonly { id: string; name: string }[];
    selected: readonly string[];
    onChange: (ids: string[]) => void;
}) {
    const t = useStatusT();
    if (components.length === 0) return null;
    return (
        <fieldset className="space-y-1">
            <legend className="text-xs font-medium">{t("incident.components")}</legend>
            <div className="flex flex-wrap gap-1.5">
                {components.map((component) => {
                    const on = selected.includes(component.id);
                    return (
                        <button
                            key={component.id}
                            type="button"
                            aria-pressed={on}
                            onClick={() =>
                                onChange(on ? selected.filter((id) => id !== component.id) : [...selected, component.id])
                            }
                            className={
                                cn(
                                    "max-w-full truncate rounded-full border px-2.5 py-0.5 text-xs",
                                    on ? "border-primary bg-primary/10 text-foreground" : "border-border text-muted-foreground"
                                )
                            }
                        >
                            {component.name}
                        </button>
                    );
                })}
            </div>
        </fieldset>
    );
}

export function IncidentDialog({
    open,
    onOpenChange,
    pageId,
    components,
    onSaved
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    pageId: string;
    components: readonly { id: string; name: string }[];
    onSaved: () => void;
}) {
    const t = useStatusT();
    const empty = { title: "", impact: "minor", state: "investigating", body: "", componentIds: [] as string[] };
    const [values, setValues] = useState(empty);
    useEffect(() => {
        if (open) setValues(empty);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open]);
    const payload = { ...values, pageId };
    return (
        <FormDialog
            open={open}
            onOpenChange={onOpenChange}
            title={t("incident.newTitle")}
            schema={incidentInput}
            values={payload}
            submitLabel={t("incident.post")}
            onSubmit={async () => {
                await unwrap(() => openIncidentAction(payload), t("errors.generic"));
                onSaved();
            }}
        >
            {(errors) => (
                <>
                    <Field label={t("incident.title")} required error={errors.title}>
                        {(id) => (
                            <Input
                                id={id}
                                value={values.title}
                                maxLength={120}
                                onChange={(event) => setValues((current) => ({ ...current, title: event.target.value }))}
                            />
                        )}
                    </Field>
                    <div className="grid gap-3 sm:grid-cols-2">
                        <Field label={t("incident.impact")} required>
                            {(id) => (
                                <Select
                                    id={id}
                                    value={values.impact}
                                    onValueChange={(impact) => setValues((current) => ({ ...current, impact }))}
                                    options={INCIDENT_IMPACTS.map((impact) => ({ value: impact, label: t(`impact.${impact}`) }))}
                                />
                            )}
                        </Field>
                        <Field label={t("incident.state")} required>
                            {(id) => (
                                <Select
                                    id={id}
                                    value={values.state}
                                    onValueChange={(state) => setValues((current) => ({ ...current, state }))}
                                    options={INCIDENT_STATES.map((state) => ({ value: state, label: t(`incidentState.${state}`) }))}
                                />
                            )}
                        </Field>
                    </div>
                    <ComponentPicker
                        components={components}
                        selected={values.componentIds}
                        onChange={(componentIds) => setValues((current) => ({ ...current, componentIds }))}
                    />
                    <Field label={t("incident.message")} required error={errors.body}>
                        {(id) => (
                            <Textarea
                                id={id}
                                rows={4}
                                maxLength={2000}
                                value={values.body}
                                placeholder={t("incident.messagePlaceholder")}
                                onChange={(event) => setValues((current) => ({ ...current, body: event.target.value }))}
                            />
                        )}
                    </Field>
                </>
            )}
        </FormDialog>
    );
}

export function UpdateDialog({
    open,
    onOpenChange,
    incident,
    onSaved
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    incident: { id: string; title: string; state: string } | null;
    onSaved: () => void;
}) {
    const t = useStatusT();
    const [values, setValues] = useState({ state: "identified", body: "" });
    useEffect(() => {
        if (open && incident) {
            setValues({ state: incident.state === "resolved" ? "investigating" : incident.state, body: "" });
        }
    }, [open, incident]);
    if (!incident) return null;
    const allowed = incident.state === "resolved" ? (["investigating"] as const) : INCIDENT_STATES;
    const payload = { ...values, incidentId: incident.id };
    return (
        <FormDialog
            open={open}
            onOpenChange={onOpenChange}
            title={t("incident.updateTitle", { title: incident.title })}
            schema={incidentUpdateInput}
            values={payload}
            submitLabel={t("incident.post")}
            onSubmit={async () => {
                await unwrap(() => postIncidentUpdateAction(payload), t("errors.generic"));
                onSaved();
            }}
        >
            {(errors) => (
                <>
                    <Field label={t("incident.state")} required>
                        {(id) => (
                            <Select
                                id={id}
                                value={values.state}
                                onValueChange={(state) => setValues((current) => ({ ...current, state }))}
                                options={allowed.map((state) => ({ value: state, label: t(`incidentState.${state}`) }))}
                            />
                        )}
                    </Field>
                    <Field label={t("incident.message")} required error={errors.body}>
                        {(id) => (
                            <Textarea
                                id={id}
                                rows={4}
                                maxLength={2000}
                                value={values.body}
                                onChange={(event) => setValues((current) => ({ ...current, body: event.target.value }))}
                            />
                        )}
                    </Field>
                </>
            )}
        </FormDialog>
    );
}

/** A `datetime-local` value for an instant, in the browser's zone. */
function localInput(at: Date): string {
    const shifted = new Date(at.getTime() - at.getTimezoneOffset() * 60_000);
    return shifted.toISOString().slice(0, 16);
}

export function MaintenanceDialog({
    open,
    onOpenChange,
    pageId,
    components,
    onSaved
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    pageId: string;
    components: readonly { id: string; name: string }[];
    onSaved: () => void;
}) {
    const t = useStatusT();
    const fresh = () => {
        const start = new Date(Date.now() + 60 * 60_000);
        start.setMinutes(0, 0, 0);
        return {
            title: "",
            body: "",
            componentIds: [] as string[],
            startsAt: localInput(start),
            endsAt: localInput(new Date(start.getTime() + 60 * 60_000))
        };
    };
    const [values, setValues] = useState(fresh);
    useEffect(() => {
        if (open) setValues(fresh());
    }, [open]);
    const payload = {
        ...values,
        pageId,
        startsAt: values.startsAt ? new Date(values.startsAt).toISOString() : "",
        endsAt: values.endsAt ? new Date(values.endsAt).toISOString() : ""
    };
    return (
        <FormDialog
            open={open}
            onOpenChange={onOpenChange}
            title={t("maintenance.newTitle")}
            schema={maintenanceInput}
            values={payload}
            submitLabel={t("maintenance.schedule")}
            onSubmit={async () => {
                await unwrap(() => saveMaintenanceAction(payload), t("errors.generic"));
                onSaved();
            }}
        >
            {(errors) => (
                <>
                    <Field label={t("maintenance.title")} required error={errors.title}>
                        {(id) => (
                            <Input
                                id={id}
                                value={values.title}
                                maxLength={120}
                                onChange={(event) => setValues((current) => ({ ...current, title: event.target.value }))}
                            />
                        )}
                    </Field>
                    <div className="grid gap-3 sm:grid-cols-2">
                        <Field label={t("maintenance.starts")} required>
                            {(id) => (
                                <Input
                                    id={id}
                                    type="datetime-local"
                                    value={values.startsAt}
                                    onChange={(event) => setValues((current) => ({ ...current, startsAt: event.target.value }))}
                                />
                            )}
                        </Field>
                        <Field label={t("maintenance.ends")} required error={errors.endsAt ? t("errors.endsBeforeStart") : null}>
                            {(id) => (
                                <Input
                                    id={id}
                                    type="datetime-local"
                                    value={values.endsAt}
                                    onChange={(event) => setValues((current) => ({ ...current, endsAt: event.target.value }))}
                                />
                            )}
                        </Field>
                    </div>
                    <ComponentPicker
                        components={components}
                        selected={values.componentIds}
                        onChange={(componentIds) => setValues((current) => ({ ...current, componentIds }))}
                    />
                    <Field label={t("maintenance.details")} error={errors.body}>
                        {(id) => (
                            <Textarea
                                id={id}
                                rows={3}
                                maxLength={2000}
                                value={values.body}
                                onChange={(event) => setValues((current) => ({ ...current, body: event.target.value }))}
                            />
                        )}
                    </Field>
                </>
            )}
        </FormDialog>
    );
}
