"use client";

/**
 * The menu: categories and products of the shared menu, as the chosen venue
 * sells them. A waiter sees it and can mark a product sold out; a manager also
 * adds, edits, imports, exports and changes prices in bulk.
 *
 * Two densities from one flag (`useHospitalityMode`): the standard Polaris
 * look, and a basic one with big targets for a tablet at the bar. Same data
 * and the same actions in both.
 */

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Ban, Check, Download, Pencil, Percent, Plus, Upload } from "lucide-react";
import {
    Button,
    Dialog,
    DialogContent,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    EmptyState,
    Input,
    PageHeader,
    Select,
    Skeleton,
    Textarea,
    cn,
    useToast
} from "@polaris/ui";
import {
    bulkPriceAction,
    exportCatalogAction,
    importCatalogAction,
    readMenuAction,
    saveCategoryAction,
    saveProductAction,
    seedSampleAction,
    setAvailabilityAction
} from "../actions/catalog";
import { PictureField } from "./picture-field";
import { hostUi } from "@polaris/app-host/client";
import { parsePrice } from "../model/catalog-csv";
import { csvToXlsx, xlsxToCsv } from "../model/catalog-xlsx";
import { CATEGORY_COLORS } from "../model/schemas";
import { ALLERGEN_KEYS, type Allergen } from "../model/allergens";
import { useHospitalityLive, useHospitalityMode } from "./live-client";
import type { CategoryView, MenuView, ProductView } from "../lib/catalog";
import { readCache, unwrap, useHospitalityLocale, useHospitalityT, writeCache } from "./i18n";

/** Tailwind classes per category colour; listed whole so the build keeps them. */
const SWATCH: Record<string, string> = {
    slate: "bg-slate-500",
    red: "bg-red-500",
    orange: "bg-orange-500",
    amber: "bg-amber-500",
    lime: "bg-lime-500",
    green: "bg-green-600",
    teal: "bg-teal-500",
    sky: "bg-sky-500",
    blue: "bg-blue-600",
    violet: "bg-violet-500",
    pink: "bg-pink-500"
};

const TAX_RATES = [0, 400, 1000, 2100];

export function useMoney(currency: string) {
    const locale = useHospitalityLocale();
    return useMemo(() => {
        const format = new Intl.NumberFormat(locale, { style: "currency", currency });
        return (cents: number) => format.format(cents / 100);
    }, [locale, currency]);
}

function download(name: string, content: string | Uint8Array) {
    const type = typeof content === "string" ? "text/csv;charset=utf-8" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    const url = URL.createObjectURL(new Blob([content as BlobPart], { type }));
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function HospitalityScreen({ manager }: { manager: boolean }) {
    const t = useHospitalityT();
    const toast = useToast();
    const [mode, setMode] = useHospitalityMode();
    const [venueId, setVenueId] = useState<string | null>(() => readCache<string>("venue"));
    const [menu, setMenu] = useState<MenuView | null>(() => readCache<MenuView>("menu"));
    const [failed, setFailed] = useState<string | null>(null);
    const [category, setCategory] = useState<string | null>(null);
    const [editing, setEditing] = useState<ProductView | "new" | null>(null);
    const [editingCategory, setEditingCategory] = useState<CategoryView | "new" | null>(null);
    const [pricing, setPricing] = useState(false);
    const [importing, setImporting] = useState(false);
    const [seeding, setSeeding] = useState(false);

    const load = useCallback(() => {
        unwrap(() => readMenuAction({ venueId }), t("errors.loadFailed"))
            .then((answer) => {
                setMenu(answer.menu);
                setFailed(null);
                writeCache("menu", answer.menu);
            })
            .catch((caught: Error) => setFailed(caught.message));
    }, [venueId, t]);
    useEffect(load, [load]);
    useHospitalityLive(menu?.venueId ?? null, load);

    const venue = menu?.venues.find((v) => v.id === menu.venueId) ?? null;
    const money = useMoney(venue?.currency ?? "EUR");
    const basic = mode === "basic";
    const shown = (menu?.products ?? []).filter((p) => !category || p.categoryId === category);
    const colorOf = new Map((menu?.categories ?? []).map((c) => [c.id, c.color]));

    const toggleAvailable = (product: ProductView) => {
        if (!menu?.venueId) return;
        const next = !product.available;
        // Optimistic: the card flips now and flips back if the server refuses.
        const flip = (available: boolean) =>
            setMenu((m) => m && { ...m, products: m.products.map((p) => (p.id === product.id ? { ...p, available } : p)) });
        flip(next);
        unwrap(() => setAvailabilityAction({ productId: product.id, venueId: menu.venueId, available: next }), t("errors.saveFailed"))
            .catch((caught: Error) => {
                flip(!next);
                toast.show({ title: t("errors.saveFailed"), body: caught.message });
            });
    };

    const seed = () => {
        setSeeding(true);
        unwrap(() => seedSampleAction(), t("errors.saveFailed"))
            .then(load)
            .catch((caught: Error) => toast.show({ title: t("errors.saveFailed"), body: caught.message }))
            .finally(() => setSeeding(false));
    };

    const exportCatalog = (format: "csv" | "xlsx") =>
        unwrap(() => exportCatalogAction(), t("errors.loadFailed"))
            .then(async (answer) =>
                format === "csv"
                    ? download(t("menu.exportFile"), answer.csv)
                    : download(t("menu.exportXlsx"), await csvToXlsx(answer.csv, t("tabs.menu")))
            )
            .catch((caught: Error) => toast.show({ title: t("errors.loadFailed"), body: caught.message }));

    return (
        <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6">
            <PageHeader
                title={t("menu.title")}
                description={venue?.name}
                actions={
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                        {menu && menu.venues.length > 1 ? (
                            <Select
                                aria-label={t("venue.pick")}
                                value={menu.venueId ?? ""}
                                onValueChange={(id) => {
                                    setVenueId(id);
                                    writeCache("venue", id);
                                }}
                                options={menu.venues.map((v) => ({ value: v.id, label: v.name }))}
                            />
                        ) : null}
                        <Button variant="outline" onClick={() => setMode(basic ? "standard" : "basic")}>
                            {basic ? t("mode.standard") : t("mode.basic")}
                        </Button>
                        {manager && menu && menu.venues.length > 0 ? (
                            <>
                                <Button variant="outline" onClick={() => setImporting(true)}>
                                    <Upload aria-hidden /> {t("menu.import")}
                                </Button>
                                <Button variant="outline" onClick={() => exportCatalog("xlsx")}>
                                    <Download aria-hidden /> {t("menu.export")}
                                </Button>
                                <Button variant="ghost" onClick={() => exportCatalog("csv")}>
                                    {t("menu.exportCsv")}
                                </Button>
                                <Button variant="outline" onClick={() => setPricing(true)}>
                                    <Percent aria-hidden /> {t("menu.prices")}
                                </Button>
                                <Button onClick={() => setEditing("new")} disabled={!menu.categories.length}>
                                    <Plus aria-hidden /> {t("menu.newProduct")}
                                </Button>
                            </>
                        ) : null}
                    </div>
                }
            />

            {failed && !menu ? (
                <EmptyState
                    title={t("errors.loadFailed")}
                    description={failed}
                    action={<Button variant="outline" onClick={load}>{t("actions.retry")}</Button>}
                />
            ) : menu === null ? (
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4" aria-busy>
                    {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => <Skeleton key={i} className="h-24 w-full" />)}
                </div>
            ) : menu.venues.length === 0 ? (
                <EmptyState
                    title={t("setup.title")}
                    description={manager ? t("setup.description") : t("setup.askManager")}
                    action={manager ? <Button size="lg" onClick={seed} disabled={seeding}>{t("setup.start")}</Button> : undefined}
                />
            ) : (
                <>
                    <div className="mb-4 flex min-w-0 gap-2 overflow-x-auto pb-1">
                        <CategoryChip label={t("menu.all")} active={category === null} basic={basic} onClick={() => setCategory(null)} />
                        {menu.categories.map((c) => (
                            <CategoryChip
                                key={c.id}
                                label={c.name}
                                color={c.color}
                                active={category === c.id}
                                basic={basic}
                                onClick={() => setCategory(c.id)}
                                onEdit={manager ? () => setEditingCategory(c) : undefined}
                            />
                        ))}
                        {manager ? (
                            <Button variant="ghost" onClick={() => setEditingCategory("new")} aria-label={t("menu.newCategory")}>
                                <Plus aria-hidden /> {basic ? null : t("menu.newCategory")}
                            </Button>
                        ) : null}
                    </div>
                    {shown.length === 0 ? (
                        <EmptyState title={t("menu.empty")} description={manager ? t("menu.emptyManager") : undefined} />
                    ) : (
                        <div className={cn("grid gap-3", basic ? "grid-cols-2 sm:grid-cols-3 lg:grid-cols-4" : "grid-cols-2 sm:grid-cols-4 lg:grid-cols-6")}>
                            {shown.map((p) => (
                                <div
                                    key={p.id}
                                    className={cn(
                                        "flex min-w-0 flex-col overflow-hidden rounded-lg border bg-background",
                                        !p.available && "opacity-60"
                                    )}
                                >
                                    <div className={cn("h-1.5", SWATCH[colorOf.get(p.categoryId) ?? "slate"])} />
                                    {p.imageUrl ? (
                                        // eslint-disable-next-line @next/next/no-img-element
                                        <img src={p.imageUrl} alt="" loading="lazy" className="aspect-square w-full object-cover" />
                                    ) : null}
                                    <div className={cn("flex min-w-0 flex-1 flex-col gap-1", basic ? "p-3" : "p-2")}>
                                        <span className={cn("truncate font-medium", basic && "text-lg")} title={p.name}>{p.name}</span>
                                        <span className={cn("tabular-nums text-muted-foreground", basic && "text-lg")}>{money(p.price)}</span>
                                        {p.allergens.length ? (
                                            <span className="truncate text-xs text-muted-foreground" title={p.allergens.map((a) => t(`allergens.${a}`)).join(", ")}>
                                                {p.allergens.map((a) => t(`allergens.${a}`)).join(", ")}
                                            </span>
                                        ) : null}
                                        <div className="mt-auto flex gap-1 pt-1">
                                            <Button
                                                size={basic ? "lg" : "sm"}
                                                variant={p.available ? "outline" : "primary"}
                                                className="min-w-0 flex-1"
                                                onClick={() => toggleAvailable(p)}
                                            >
                                                {p.available ? <Ban aria-hidden /> : <Check aria-hidden />}
                                                <span className="truncate">{p.available ? t("menu.soldOut") : t("menu.backOn")}</span>
                                            </Button>
                                            {manager ? (
                                                <Button size={basic ? "lg" : "sm"} variant="ghost" aria-label={t("menu.edit")} onClick={() => setEditing(p)}>
                                                    <Pencil aria-hidden />
                                                </Button>
                                            ) : null}
                                        </div>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </>
            )}

            {editing && menu ? (
                <ProductDialog
                    product={editing === "new" ? null : editing}
                    categories={menu.categories}
                    defaultCategory={category ?? menu.categories[0]?.id ?? ""}
                    onClose={() => setEditing(null)}
                    onSaved={load}
                />
            ) : null}
            {editingCategory ? (
                <CategoryDialog category={editingCategory === "new" ? null : editingCategory} onClose={() => setEditingCategory(null)} onSaved={load} />
            ) : null}
            {pricing && menu ? <BulkPriceDialog categories={menu.categories} onClose={() => setPricing(false)} onSaved={load} /> : null}
            {importing ? <ImportDialog onClose={() => setImporting(false)} onSaved={load} /> : null}
        </div>
    );
}

function CategoryChip(props: {
    label: string;
    color?: string;
    active: boolean;
    basic: boolean;
    onClick: () => void;
    onEdit?: () => void;
}) {
    return (
        <div className="flex shrink-0 items-center">
            <button
                type="button"
                onClick={props.onClick}
                onDoubleClick={props.onEdit}
                aria-pressed={props.active}
                className={cn(
                    "flex max-w-56 min-w-0 items-center gap-2 rounded-full border px-3",
                    props.basic ? "h-12 text-base" : "h-8 text-sm",
                    props.active ? "border-primary bg-primary/10" : "bg-background"
                )}
            >
                {props.color ? <span className={cn("size-3 shrink-0 rounded-full", SWATCH[props.color])} /> : null}
                <span className="truncate" title={props.label}>{props.label}</span>
            </button>
        </div>
    );
}

/** The common frame of every form here: a title, the fields, Cancel and Save. */
function FormDialog(props: {
    title: string;
    ready: boolean;
    submit: () => Promise<unknown>;
    onClose: () => void;
    children: ReactNode;
    submitLabel?: string;
}) {
    const t = useHospitalityT();
    const toast = useToast();
    const [pending, setPending] = useState(false);
    return (
        <Dialog open onOpenChange={(open) => !open && props.onClose()}>
            <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
                <DialogHeader>
                    <DialogTitle>{props.title}</DialogTitle>
                </DialogHeader>
                <form
                    className="flex flex-col gap-3"
                    onSubmit={(event) => {
                        event.preventDefault();
                        if (!props.ready || pending) return;
                        setPending(true);
                        props
                            .submit()
                            .then(props.onClose)
                            .catch((caught: Error) => toast.show({ title: t("errors.saveFailed"), body: caught.message }))
                            .finally(() => setPending(false));
                    }}
                >
                    {props.children}
                    <DialogFooter>
                        <Button type="button" variant="ghost" onClick={props.onClose}>{t("actions.cancel")}</Button>
                        <Button type="submit" aria-disabled={!props.ready || pending} className={props.ready ? undefined : "opacity-60"}>
                            {props.submitLabel ?? t("actions.save")}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
    return (
        <label className="flex min-w-0 flex-col gap-1 text-sm">
            <span className="font-medium">{label}</span>
            {children}
        </label>
    );
}

function ProductDialog(props: {
    product: ProductView | null;
    categories: CategoryView[];
    defaultCategory: string;
    onClose: () => void;
    onSaved: () => void;
}) {
    const t = useHospitalityT();
    const p = props.product;
    const [name, setName] = useState(p?.name ?? "");
    const [categoryId, setCategoryId] = useState(p?.categoryId ?? props.defaultCategory);
    const [price, setPrice] = useState(p ? (p.menuPrice / 100).toFixed(2) : "");
    const [tax, setTax] = useState(String(p?.taxRateBp ?? 1000));
    const [description, setDescription] = useState(p?.description ?? "");
    const [sku, setSku] = useState(p?.sku ?? "");
    const [imageUrl, setImageUrl] = useState(p?.imageUrl ?? "");
    const [allergens, setAllergens] = useState<Allergen[]>(p?.allergens ?? []);
    const cents = parsePrice(price);
    const ready = name.trim() !== "" && cents !== null && categoryId !== "";
    return (
        <FormDialog
            title={p ? t("product.edit") : t("product.new")}
            ready={ready}
            onClose={props.onClose}
            submit={() =>
                unwrap(
                    () =>
                        saveProductAction({
                            id: p?.id ?? null,
                            categoryId,
                            name,
                            description,
                            price: cents ?? 0,
                            taxRateBp: Number(tax),
                            allergens,
                            sku: sku || null,
                            station: p?.station ?? null,
                            imageUrl: imageUrl || null,
                            modifiers: p?.modifiers ?? [],
                            available: p?.available ?? true
                        }),
                    t("errors.saveFailed")
                ).then(props.onSaved)
            }
        >
            <Field label={`${t("product.name")} *`}>
                <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} autoFocus />
            </Field>
            <div className="grid grid-cols-2 gap-3">
                <Field label={`${t("product.price")} *`}>
                    <Input value={price} onChange={(e) => setPrice(e.target.value)} inputMode="decimal" placeholder="0,00" />
                </Field>
                <Field label={t("product.tax")}>
                    <Select value={tax} onValueChange={setTax} options={TAX_RATES.map((r) => ({ value: String(r), label: `${r / 100} %` }))} />
                </Field>
            </div>
            <Field label={`${t("product.category")} *`}>
                <Select value={categoryId} onValueChange={setCategoryId} options={props.categories.map((c) => ({ value: c.id, label: c.name }))} />
            </Field>
            <Field label={t("product.description")}>
                <Textarea value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} rows={2} />
            </Field>
            <div className="grid grid-cols-2 gap-3">
                <Field label={t("product.sku")}>
                    <Input value={sku} onChange={(e) => setSku(e.target.value)} maxLength={64} />
                </Field>
            </div>
            <div className="flex flex-col gap-1.5">
                <span className="text-sm font-medium">{t("product.image")}</span>
                <PictureField value={imageUrl} onChange={setImageUrl} />
            </div>
            <fieldset className="flex flex-col gap-2">
                <legend className="text-sm font-medium">{t("product.allergens")}</legend>
                <div className="flex flex-wrap gap-1.5">
                    {ALLERGEN_KEYS.map((a) => {
                        const on = allergens.includes(a);
                        return (
                            <button
                                key={a}
                                type="button"
                                aria-pressed={on}
                                onClick={() => setAllergens(on ? allergens.filter((x) => x !== a) : [...allergens, a])}
                                className={cn("rounded-full border px-2.5 py-1 text-xs", on ? "border-primary bg-primary/10" : "bg-background")}
                            >
                                {t(`allergens.${a}`)}
                            </button>
                        );
                    })}
                </div>
            </fieldset>
        </FormDialog>
    );
}

function CategoryDialog(props: { category: CategoryView | null; onClose: () => void; onSaved: () => void }) {
    const t = useHospitalityT();
    const c = props.category;
    const [name, setName] = useState(c?.name ?? "");
    const [color, setColor] = useState(c?.color ?? "slate");
    const [station, setStation] = useState(c?.station ?? "kitchen");
    return (
        <FormDialog
            title={c ? t("category.edit") : t("category.new")}
            ready={name.trim() !== ""}
            onClose={props.onClose}
            submit={() =>
                unwrap(() => saveCategoryAction({ id: c?.id ?? null, name, color, station }), t("errors.saveFailed")).then(props.onSaved)
            }
        >
            <Field label={`${t("category.name")} *`}>
                <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoFocus />
            </Field>
            <Field label={t("category.station")}>
                <Select
                    value={station}
                    onValueChange={setStation}
                    options={[
                        { value: "kitchen", label: t("stations.kitchen") },
                        { value: "bar", label: t("stations.bar") }
                    ]}
                />
            </Field>
            <fieldset className="flex flex-wrap gap-2">
                <legend className="mb-1 text-sm font-medium">{t("category.color")}</legend>
                {CATEGORY_COLORS.map((k) => (
                    <button
                        key={k}
                        type="button"
                        aria-label={k}
                        aria-pressed={color === k}
                        onClick={() => setColor(k)}
                        className={cn("size-8 rounded-full ring-offset-2", SWATCH[k], color === k && "ring-2 ring-primary")}
                    />
                ))}
            </fieldset>
        </FormDialog>
    );
}

function BulkPriceDialog(props: { categories: CategoryView[]; onClose: () => void; onSaved: () => void }) {
    const t = useHospitalityT();
    const toast = useToast();
    const [categoryId, setCategoryId] = useState("all");
    const [kind, setKind] = useState<"percent" | "amount">("percent");
    const [value, setValue] = useState("");
    const number = Number(value.replace(",", "."));
    const ready = value.trim() !== "" && Number.isFinite(number) && number !== 0;
    return (
        <FormDialog
            title={t("prices.title")}
            ready={ready}
            submitLabel={t("prices.apply")}
            onClose={props.onClose}
            submit={() =>
                unwrap(
                    () =>
                        bulkPriceAction({
                            categoryId: categoryId === "all" ? null : categoryId,
                            kind,
                            value: Math.round(number * 100),
                            roundTo: kind === "percent" ? 5 : 1
                        }),
                    t("errors.saveFailed")
                ).then((answer) => {
                    toast.show({ title: t("prices.done", { count: answer.changed }) });
                    props.onSaved();
                })
            }
        >
            <Field label={t("prices.which")}>
                <Select
                    value={categoryId}
                    onValueChange={setCategoryId}
                    options={[{ value: "all", label: t("menu.all") }, ...props.categories.map((c) => ({ value: c.id, label: c.name }))]}
                />
            </Field>
            <div className="grid grid-cols-2 gap-3">
                <Field label={t("prices.how")}>
                    <Select
                        value={kind}
                        onValueChange={(k) => setKind(k as "percent" | "amount")}
                        options={[
                            { value: "percent", label: t("prices.percent") },
                            { value: "amount", label: t("prices.amount") }
                        ]}
                    />
                </Field>
                <Field label={`${t("prices.value")} *`}>
                    <Input value={value} onChange={(e) => setValue(e.target.value)} inputMode="decimal" placeholder={kind === "percent" ? "5" : "0,50"} />
                </Field>
            </div>
            <p className="text-sm text-muted-foreground">{t("prices.hint")}</p>
        </FormDialog>
    );
}

const IMPORT_ACCEPT = ".csv,text/csv,.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const { useChooseFiles } = hostUi.filePicker;

function ImportDialog(props: { onClose: () => void; onSaved: () => void }) {
    const t = useHospitalityT();
    const toast = useToast();
    const [csv, setCsv] = useState<string | null>(null);
    const [file, setFile] = useState("");
    const [choose, picker] = useChooseFiles();
    return (
        <FormDialog
            title={t("import.title")}
            ready={csv !== null}
            submitLabel={t("import.run")}
            onClose={props.onClose}
            submit={() =>
                unwrap(() => importCatalogAction({ csv: csv ?? "" }), t("errors.saveFailed")).then((answer) => {
                    toast.show({
                        title: t("import.done", { created: answer.created, updated: answer.updated }),
                        body: answer.skipped.length
                            ? t("import.skipped", { rows: answer.skipped.map((s) => s.row).join(", ") })
                            : undefined
                    });
                    props.onSaved();
                })
            }
        >
            <p className="text-sm text-muted-foreground">{t("import.hint")}</p>
            <Button
                variant="outline"
                className="self-start"
                onClick={() =>
                    void choose({ accept: IMPORT_ACCEPT, title: t("import.title") }).then(([picked]) => {
                        if (!picked) return;
                        setFile(picked.name);
                        setCsv(null);
                        const read = /\.xlsx$/i.test(picked.name) ? picked.arrayBuffer().then((bytes) => xlsxToCsv(bytes)) : picked.text();
                        read.then(setCsv).catch(() => toast.show({ title: t("import.unreadable") }));
                    })
                }
            >
                <Upload aria-hidden /> {t("import.choose")}
            </Button>
            {picker}
            {file ? <p className="truncate text-sm" title={file}>{file}</p> : null}
        </FormDialog>
    );
}
