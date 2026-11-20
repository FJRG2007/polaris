"use client";

/**
 * The deployment's own AI providers: any OpenAI- or Anthropic-compatible
 * endpoint an administrator adds, offered beside the catalogue's in every key
 * picker.
 *
 * The form is checked on every keystroke against the schema the server parses
 * (`custom-provider-schema.ts`), so a field the server would refuse is marked
 * while it is typed. Adding and removing both show at once and are put back if
 * the server refuses; a refused add reopens the form with what was typed.
 */

import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { runAction } from "@/lib/run-action";
import { IntegrationLogo } from "@/components/logos";
import { useConfirm } from "@/components/confirm-dialog";
import { useTranslations } from "@/components/i18n/i18n-provider";
import type { CustomProviderView } from "@/lib/integrations/provider-catalog";
import {
    customProviderSchema,
    slugifyProviderName,
    type CustomProviderInput
} from "@/lib/integrations/custom-provider-schema";
import {
    Button,
    Card,
    CardBody,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    Input,
    Select
} from "@polaris/ui";
import { addCustomProviderAction, removeCustomProviderAction } from "./actions";

type Form = { [K in keyof Required<CustomProviderInput>]: string };
type Field = keyof Form;

type ErrorCode =
    | "taken"
    | "envTaken"
    | "invalid"
    | "name"
    | "publicHttps"
    | "envVar"
    | "envVarReserved"
    | "model"
    | "failed";

const EMPTY: Form = {
    name: "",
    baseUrl: "",
    wire: "openai",
    envVar: "",
    defaultModel: "",
    probe: "",
    docsUrl: ""
};

const ALL_TOUCHED: Record<Field, boolean> = {
    name: true,
    baseUrl: true,
    wire: true,
    envVar: true,
    defaultModel: true,
    probe: true,
    docsUrl: true
};

/** The schema's message codes that have words of their own. */
const CODES = new Set(["name", "publicHttps", "envVar", "envVarReserved", "model"]);

/** Each field's refusal, as the code the dialog words it by. Pure. */
export function formErrors(form: Form): Partial<Record<Field, string>> {
    const parsed = customProviderSchema.safeParse(form);
    if (parsed.success) return {};
    const errors: Partial<Record<Field, string>> = {};
    for (const issue of parsed.error.issues) {
        const field = issue.path[0] as Field | undefined;
        if (!field || errors[field]) continue;
        errors[field] = CODES.has(issue.message) ? issue.message : "invalid";
    }
    return errors;
}

export function CustomProvidersCard({ initial }: { initial: CustomProviderView[] }) {
    const t = useTranslations("polar");
    const [confirm, confirmElement] = useConfirm();
    const [rows, setRows] = useState(initial);
    const [served, setServed] = useState(initial);
    if (served !== initial) {
        setServed(initial);
        setRows(initial);
    }
    const [open, setOpen] = useState(false);
    const [form, setForm] = useState<Form>(EMPTY);
    const [refusal, setRefusal] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    const words = (code: string) => t(`admin.providers.custom.errors.${code as ErrorCode}`);

    const add = (values: Form) => {
        const slug = slugifyProviderName(values.name);
        const optimistic: CustomProviderView = {
            slug,
            name: values.name.trim(),
            baseUrl: values.baseUrl.trim(),
            wire: values.wire === "anthropic" ? "anthropic" : "openai",
            envVar: values.envVar.trim().toUpperCase(),
            defaultModel: values.defaultModel.trim(),
            keys: 0
        };
        const previous = rows;
        setRows([...rows, optimistic]);
        setOpen(false);
        setRefusal(null);
        setError(null);
        void (async () => {
            const result = await runAction(() => addCustomProviderAction(values), setError);
            if (result?.ok) {
                setRows((now) => now.map((row) => (row.slug === slug ? result.provider : row)));
                setForm(EMPTY);
                return;
            }
            // Put it back, and the form with it, saying why.
            setRows(previous);
            if (result) {
                setRefusal(words(result.reason));
                setOpen(true);
            }
        })();
    };

    const remove = async (row: CustomProviderView) => {
        const ok = await confirm({
            title: t("admin.providers.custom.removeTitle", { name: row.name }),
            description:
                row.keys > 0
                    ? t("admin.providers.custom.removeKeys", { count: row.keys })
                    : t("admin.providers.custom.removeBody"),
            confirmLabel: t("admin.providers.custom.remove"),
            danger: true
        });
        if (!ok) return;
        const previous = rows;
        setRows(rows.filter((one) => one.slug !== row.slug));
        setError(null);
        const result = await runAction(() => removeCustomProviderAction({ slug: row.slug }), setError);
        if (!result?.ok) {
            setRows(previous);
            if (result) setError(words(result.reason));
        }
    };

    return (
        <Card>
            <CardBody className="flex flex-col gap-3">
                <div className="flex min-w-0 items-start gap-3">
                    <div className="min-w-0 flex-1">
                        <h2 className="text-sm font-medium">{t("admin.providers.custom.title")}</h2>
                        <p className="text-muted-foreground text-xs">
                            {t("admin.providers.custom.hint")}
                        </p>
                    </div>
                    <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => {
                            setRefusal(null);
                            setOpen(true);
                        }}
                    >
                        <Plus className="size-4 shrink-0" />
                        {t("admin.providers.custom.add")}
                    </Button>
                </div>
                {rows.length === 0 ? (
                    <p className="text-muted-foreground text-sm">
                        {t("admin.providers.custom.empty")}
                    </p>
                ) : (
                    <ul className="divide-border flex flex-col divide-y">
                        {rows.map((row) => (
                            <li key={row.slug} className="flex min-w-0 items-center gap-3 py-2">
                                <IntegrationLogo
                                    slug={row.slug}
                                    name={row.name}
                                    className="size-4 shrink-0"
                                />
                                <div className="min-w-0 flex-1">
                                    <p className="truncate text-sm" title={row.name}>
                                        {row.name}
                                    </p>
                                    <p
                                        className="text-muted-foreground truncate text-xs"
                                        title={row.baseUrl}
                                    >
                                        {row.baseUrl} - {row.envVar}
                                        {row.keys > 0
                                            ? ` - ${t("admin.providers.custom.keys", { count: row.keys })}`
                                            : ""}
                                    </p>
                                </div>
                                <Button
                                    size="sm"
                                    variant="ghost"
                                    aria-label={t("admin.providers.custom.removeTitle", {
                                        name: row.name
                                    })}
                                    title={t("admin.providers.custom.remove")}
                                    onClick={() => void remove(row)}
                                >
                                    <Trash2 className="size-4 shrink-0" />
                                </Button>
                            </li>
                        ))}
                    </ul>
                )}
                {error ? <p className="text-danger text-xs">{error}</p> : null}
            </CardBody>
            {open ? (
                <AddProviderDialog
                    form={form}
                    onChange={setForm}
                    refusal={refusal}
                    taken={new Set(rows.map((row) => row.slug))}
                    onClose={() => setOpen(false)}
                    onSave={add}
                />
            ) : null}
            {confirmElement}
        </Card>
    );
}

function AddProviderDialog({
    form,
    onChange,
    refusal,
    taken,
    onClose,
    onSave
}: {
    form: Form;
    onChange: (form: Form) => void;
    refusal: string | null;
    taken: ReadonlySet<string>;
    onClose: () => void;
    onSave: (form: Form) => void;
}) {
    const t = useTranslations("polar");
    const [touched, setTouched] = useState<Partial<Record<Field, boolean>>>({});
    const errors = formErrors(form);
    if (!errors.name && taken.has(slugifyProviderName(form.name))) errors.name = "taken";
    const ready = Object.keys(errors).length === 0;
    const set = (name: Field) => (value: string) => {
        onChange({ ...form, [name]: value });
        setTouched((now) => ({ ...now, [name]: true }));
    };
    // An empty field is unfinished, not wrong: it is marked required and the
    // button waits, but no refusal is drawn under it.
    const shown = (name: Field): string | null => {
        const code = errors[name];
        return touched[name] && form[name].trim() !== "" && code
            ? t(`admin.providers.custom.errors.${code as ErrorCode}`)
            : null;
    };

    const field = (name: Field, required: boolean, placeholder: string) => {
        const message = shown(name);
        return (
            <label className="flex min-w-0 flex-col gap-1 text-sm">
                <span>
                    {t(`admin.providers.custom.dialog.${name}`)}
                    {required ? (
                        <span aria-hidden="true"> *</span>
                    ) : (
                        <span className="text-muted-foreground">
                            {" "}
                            {t("admin.providers.custom.dialog.optional")}
                        </span>
                    )}
                </span>
                <Input
                    value={form[name]}
                    placeholder={placeholder}
                    autoComplete="off"
                    spellCheck={false}
                    required={required}
                    aria-invalid={message !== null}
                    onChange={(event) => set(name)(event.target.value)}
                />
                {message ? <span className="text-danger text-xs">{message}</span> : null}
            </label>
        );
    };

    return (
        <Dialog open onOpenChange={(next) => !next && onClose()}>
            <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto overscroll-contain">
                <DialogHeader>
                    <DialogTitle>{t("admin.providers.custom.dialog.title")}</DialogTitle>
                    <DialogDescription>
                        {t("admin.providers.custom.dialog.intro")}
                    </DialogDescription>
                </DialogHeader>
                <form
                    className="flex flex-col gap-3"
                    onSubmit={(event) => {
                        event.preventDefault();
                        setTouched(ALL_TOUCHED);
                        if (ready) onSave(form);
                    }}
                >
                    {field("name", true, "Acme AI")}
                    {field("baseUrl", true, "https://api.example.com/v1")}
                    <label className="flex min-w-0 flex-col gap-1 text-sm">
                        <span>{t("admin.providers.custom.dialog.wire")}</span>
                        <Select
                            value={form.wire}
                            onValueChange={set("wire")}
                            options={[
                                {
                                    value: "openai",
                                    label: t("admin.providers.custom.dialog.wireOpenai")
                                },
                                {
                                    value: "anthropic",
                                    label: t("admin.providers.custom.dialog.wireAnthropic")
                                }
                            ]}
                            aria-label={t("admin.providers.custom.dialog.wire")}
                        />
                    </label>
                    {field("envVar", true, "ACME_API_KEY")}
                    {field("defaultModel", true, "acme-large")}
                    {field("probe", false, "https://api.example.com/v1/models")}
                    {field("docsUrl", false, "https://docs.example.com")}
                    {refusal ? <p className="text-danger text-sm">{refusal}</p> : null}
                    <div className="flex justify-end gap-2">
                        <Button type="button" variant="ghost" onClick={onClose}>
                            {t("admin.providers.custom.dialog.cancel")}
                        </Button>
                        <Button type="submit" aria-disabled={!ready}>
                            {t("admin.providers.custom.dialog.save")}
                        </Button>
                    </div>
                </form>
            </DialogContent>
        </Dialog>
    );
}
