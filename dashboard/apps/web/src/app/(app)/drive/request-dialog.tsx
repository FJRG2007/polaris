"use client";

/**
 * Create-a-drop-point dialog. A drop point is a public link that collects
 * uploads into the chosen folder. Controlled by a `target` so it can be opened
 * from the Files toolbar (the current folder) or a folder's context menu. The
 * essentials (destination, title, instructions) are always visible; every guard -
 * allowed/blocked file types and extensions, per-file min/max size, count,
 * expiry, PIN, sign-in, a per-user allowlist, and IP/location limits - lives in
 * collapsible "advanced" sections so the dialog stays approachable. All of it is
 * re-validated server-side on every upload. The generated link is shown once.
 */

import { tokenList } from "@/lib/token-field";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { Check, Copy, Inbox } from "lucide-react";
import { GeoPicker } from "@/components/geo-picker";
import { AccountInput } from "@/components/account-input";
import { ExpirySelect } from "@/components/expiry-select";
import { createFileRequestAction } from "./request-actions";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { FILE_CATEGORIES, categoryDef, type FileCategory } from "./file-categories";
import {
    cn,
    Input,
    Button,
    Dialog,
    Select,
    Textarea,
    DialogTitle,
    DialogHeader,
    DialogContent,
    DialogDescription
} from "@polaris/ui";

export interface RequestTarget {
    connectionId: string;
    path: string;
    /** Folder name for the dialog heading; "" for the connection root. */
    name: string;
}

/** Prefill for the create form, used when cloning a drop point or applying a template. */
export interface RequestInitial {
    title?: string;
    instructions?: string;
    extensions?: string;
    deniedExtensions?: string;
    maxMb?: number;
    minMb?: number;
    maxFiles?: number;
    requireLogin?: boolean;
    allowedUsers?: string;
    allowedCidrs?: string;
    geoCountries?: string[];
    geoContinents?: string[];
    allowUploaderDelete?: boolean;
    allowOverwrite?: boolean;
    deleteWindowMin?: number;
    startsAt?: string;
}

/** A collapsible group of advanced options, closed by default. */
function Section({
    title,
    defaultOpen = false,
    children
}: {
    title: string;
    defaultOpen?: boolean;
    children: ReactNode;
}) {
    return (
        <details open={defaultOpen} className="rounded-md border border-border">
            <summary className="cursor-pointer select-none px-3 py-2 text-sm font-medium marker:text-muted-foreground">
                {title}
            </summary>
            <div className="flex flex-col gap-3 border-t border-border p-3">{children}</div>
        </details>
    );
}

/** Pill toggles for the file-type category presets, tinted by intent. */
function CategoryToggles({
    selected,
    onToggle,
    tone
}: {
    selected: Set<FileCategory>;
    onToggle: (id: FileCategory) => void;
    tone: "allow" | "deny";
}) {
    const active =
        tone === "deny"
            ? "border-danger bg-danger-soft text-danger-ink"
            : "border-primary bg-primary/10 text-primary";
    return (
        <div className="flex flex-wrap gap-1.5">
            {FILE_CATEGORIES.map((category) => (
                <button
                    key={category.id}
                    type="button"
                    onClick={() => onToggle(category.id)}
                    className={cn(
                        "rounded-full border px-3 py-1 text-xs transition-colors",
                        selected.has(category.id)
                            ? active
                            : "border-border text-muted-foreground hover:bg-muted"
                    )}
                >
                    {category.label}
                </button>
            ))}
        </div>
    );
}

/** Toggle a category id within a Set state setter. */
function toggle(
    setter: (updater: (prev: Set<FileCategory>) => Set<FileCategory>) => void,
    id: FileCategory
) {
    setter((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
    });
}

export function RequestDialog({
    target,
    onOpenChange,
    onCreated,
    connections,
    initial,
    scheduleFocus = false
}: {
    target: RequestTarget | null;
    onOpenChange: (open: boolean) => void;
    /** Told once the drop point exists, while the dialog is still showing its
     *  link, so a list of drop points behind it can pick the new one up. */
    onCreated?: () => void;
    /** When the target has no connectionId, these let the user pick a destination. */
    connections?: { id: string; name: string }[];
    /** Optional values to prefill the form with (clone or template). */
    initial?: RequestInitial;
    /** Open the Schedule section expanded (used by the "Schedule drop point" entry). */
    scheduleFocus?: boolean;
}) {
    const t = useTranslations("drivePoints");
    const [categories, setCategories] = useState<Set<FileCategory>>(new Set());
    const [denyCategories, setDenyCategories] = useState<Set<FileCategory>>(new Set());
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [url, setUrl] = useState<string | null>(null);
    const [copied, setCopied] = useState(false);
    const [pickConnection, setPickConnection] = useState("");
    const [geoCountries, setGeoCountries] = useState<string[]>([]);
    const [geoContinents, setGeoContinents] = useState<string[]>([]);
    const [expiry, setExpiry] = useState("");

    // Picker mode: opened from the Drop points page with no fixed folder, so the
    // user chooses which connection and folder to collect into.
    const needsPicker =
        target !== null && target.connectionId === "" && (connections?.length ?? 0) > 0;

    // Reset the form each time the dialog opens. This runs on `target`, not on the
    // dialog's onOpenChange: that only fires on user interaction, never when the
    // dialog is opened programmatically via the controlled `open` prop - so the
    // connection would otherwise never be selected and submit would fail.
    useEffect(() => {
        if (!target) return;
        setCategories(new Set());
        setDenyCategories(new Set());
        setError(null);
        setUrl(null);
        setCopied(false);
        setPickConnection(connections?.[0]?.id ?? "");
        setGeoCountries(initial?.geoCountries ?? []);
        setGeoContinents(initial?.geoContinents ?? []);
        setExpiry("");
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [target]);

    async function onSubmit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        if (!target) return;
        setPending(true);
        setError(null);
        const form = new FormData(event.currentTarget);

        // Allow/deny gates are expressed as extension lists: category presets
        // contribute their extensions and the manual fields add extras. Empty
        // allow means any type; a denied extension is rejected regardless.
        const allowedExtensions = Array.from(
            new Set([
                ...[...categories].flatMap((id) => categoryDef(id)?.extensions ?? []),
                ...tokenList(String(form.get("extensions") ?? ""), /^\./)
            ])
        );
        const deniedExtensions = Array.from(
            new Set([
                ...[...denyCategories].flatMap((id) => categoryDef(id)?.extensions ?? []),
                ...tokenList(String(form.get("deniedExtensions") ?? ""), /^\./)
            ])
        );

        const allowedCidrs = tokenList(String(form.get("allowedCidrs") ?? ""), /^$/);
        const allowedUsers = tokenList(String(form.get("allowedUsers") ?? ""), /^@+/);
        const maxFiles = form.get("maxFiles");
        const maxMb = Number(form.get("maxMb") ?? 0);
        const minMb = Number(form.get("minMb") ?? 0);
        const deleteWindowMin = Number(form.get("deleteWindowMin") ?? 0);
        const startsRaw = String(form.get("startsAt") ?? "").trim();

        const destinationConnectionId = needsPicker
            ? pickConnection || connections?.[0]?.id || ""
            : target.connectionId;
        // The path is managed by Polaris (a dedicated folder under "Drop Points"); the
        // server derives it from the title, so nothing is collected here.
        const destinationPath = "";
        if (!destinationConnectionId) {
            setPending(false);
            setError(t("create.chooseConnection"));
            return;
        }

        const result = await createFileRequestAction({
            title: String(form.get("title") ?? "").trim(),
            instructions: String(form.get("instructions") ?? "").trim() || undefined,
            destinationConnectionId,
            destinationPath,
            requireLogin: form.get("requireLogin") === "on",
            password: String(form.get("password") ?? "").trim() || undefined,
            maxSizeBytes: maxMb > 0 ? Math.floor(maxMb * 1024 * 1024) : 1024 * 1024 * 1024,
            minSizeBytes: minMb > 0 ? Math.floor(minMb * 1024 * 1024) : undefined,
            maxFiles: maxFiles ? Number(maxFiles) : undefined,
            allowedExtensions,
            deniedExtensions,
            allowedMimeTypes: [],
            allowedCidrs,
            allowedCountries: geoCountries,
            allowedContinents: geoContinents,
            allowedUsers,
            startsAt: startsRaw ? new Date(startsRaw).toISOString() : undefined,
            allowUploaderDelete: form.get("allowUploaderDelete") === "on",
            allowOverwrite: form.get("allowOverwrite") === "on",
            uploaderDeleteWindowSeconds:
                deleteWindowMin > 0 ? Math.floor(deleteWindowMin * 60) : undefined,
            expiresAt: expiry || undefined
        });
        setPending(false);
        if (result.error) {
            setError(result.error);
            return;
        }
        setUrl(result.url ?? null);
        onCreated?.();
    }

    async function onCopy() {
        if (!url) return;
        await navigator.clipboard.writeText(url);
        setCopied(true);
    }

    return (
        <Dialog open={target !== null} onOpenChange={onOpenChange}>
            <DialogContent className="max-h-[85vh] overflow-y-auto overscroll-contain">
                <DialogHeader>
                    <DialogTitle>{t("create.title")}</DialogTitle>
                    <DialogDescription className="truncate">
                        {needsPicker
                            ? t("create.chooseWhere")
                            : target?.name
                              ? t("create.collectInto", { name: target.name })
                              : t("create.collectIntoConnection")}
                    </DialogDescription>
                </DialogHeader>

                {url ? (
                    <div className="flex flex-col gap-3">
                        <p className="text-sm text-muted-foreground">
                            {t("create.shareOnce")}
                        </p>
                        <div className="flex items-center gap-2">
                            <Input readOnly value={url} className="font-mono text-xs" />
                            <Button type="button" size="icon" variant="secondary" onClick={onCopy}>
                                {copied ? (
                                    <Check className="size-4 text-success" />
                                ) : (
                                    <Copy className="size-4" />
                                )}
                            </Button>
                        </div>
                        <div className="flex justify-end">
                            <Button type="button" onClick={() => onOpenChange(false)}>
                                {t("create.done")}
                            </Button>
                        </div>
                    </div>
                ) : (
                    <form onSubmit={onSubmit} className="flex flex-col gap-3">
                        {/* Only ask which connection when there is a real choice; with a
                            single connection it is used automatically. The folder is always
                            managed by Polaris, so there is no destination-folder field. */}
                        {needsPicker && (connections?.length ?? 0) > 1 ? (
                            <label className="flex flex-col gap-1 text-sm">
                                {t("create.connection")}
                                <Select
                                    value={pickConnection}
                                    onValueChange={setPickConnection}
                                    options={(connections ?? []).map((connection) => ({
                                        value: connection.id,
                                        label: connection.name
                                    }))}
                                />
                            </label>
                        ) : null}
                        <label className="flex flex-col gap-1 text-sm">
                            {t("create.titleField")}
                            <Input
                                name="title"
                                defaultValue={initial?.title}
                                placeholder={t("create.titlePlaceholder")}
                                autoComplete="off"
                            />
                            <span className="text-xs text-muted-foreground">
                                {t("create.titleHint")}
                            </span>
                        </label>
                        <label className="flex flex-col gap-1 text-sm">
                            {t("form.instructions")}
                            <Textarea
                                name="instructions"
                                rows={2}
                                defaultValue={initial?.instructions}
                                placeholder={t("create.instructionsPlaceholder")}
                                className="max-h-48 min-h-[2.5rem] resize-y rounded-md border border-border bg-surface px-3 py-2 text-sm"
                            />
                        </label>

                        <Section title={t("create.schedule")} defaultOpen={scheduleFocus}>
                            <label className="flex flex-col gap-1 text-sm">
                                {t("create.starts")}
                                <Input
                                    type="datetime-local"
                                    name="startsAt"
                                    defaultValue={initial?.startsAt}
                                />
                                <span className="text-xs text-muted-foreground">
                                    {t("create.startsHint")}
                                </span>
                            </label>
                        </Section>

                        <Section title={t("create.fileTypes")}>
                            <div className="flex flex-col gap-1.5 text-sm">
                                <span>{t("create.allowedTypes")}</span>
                                <CategoryToggles
                                    selected={categories}
                                    onToggle={(id) => toggle(setCategories, id)}
                                    tone="allow"
                                />
                                <span className="text-xs text-muted-foreground">
                                    {t("create.allowedHint")}
                                </span>
                            </div>
                            <label className="flex flex-col gap-1 text-sm">
                                {t("create.alsoAllow")}
                                <Input
                                    name="extensions"
                                    defaultValue={initial?.extensions}
                                    placeholder={t("form.extensionsPlaceholder")}
                                    autoComplete="off"
                                />
                            </label>
                            <div className="flex flex-col gap-1.5 text-sm">
                                <span>{t("create.blockedTypes")}</span>
                                <CategoryToggles
                                    selected={denyCategories}
                                    onToggle={(id) => toggle(setDenyCategories, id)}
                                    tone="deny"
                                />
                                <span className="text-xs text-muted-foreground">
                                    {t("create.blockedHint")}
                                </span>
                            </div>
                            <label className="flex flex-col gap-1 text-sm">
                                {t("create.alsoBlock")}
                                <Input
                                    name="deniedExtensions"
                                    defaultValue={initial?.deniedExtensions}
                                    placeholder={t("form.deniedPlaceholder")}
                                    autoComplete="off"
                                />
                            </label>
                        </Section>

                        <Section title={t("create.limits")}>
                            <div className="grid grid-cols-3 gap-3">
                                <label className="flex flex-col gap-1 text-sm">
                                    {t("form.minSize")}
                                    <Input
                                        name="minMb"
                                        type="number"
                                        min="0"
                                        defaultValue={initial?.minMb}
                                        placeholder={t("create.none")}
                                    />
                                </label>
                                <label className="flex flex-col gap-1 text-sm">
                                    {t("form.maxSize")}
                                    <Input
                                        name="maxMb"
                                        type="number"
                                        min="1"
                                        defaultValue={initial?.maxMb}
                                        placeholder="1024"
                                    />
                                </label>
                                <label className="flex flex-col gap-1 text-sm">
                                    {t("form.maxFiles")}
                                    <Input
                                        name="maxFiles"
                                        type="number"
                                        min="1"
                                        defaultValue={initial?.maxFiles}
                                        placeholder={t("create.noLimit")}
                                    />
                                </label>
                            </div>
                            <div className="flex flex-col gap-1 text-sm">
                                {t("create.expires")}
                                <ExpirySelect onChange={setExpiry} />
                            </div>
                        </Section>

                        <Section title={t("create.security")}>
                            <label className="flex flex-col gap-1 text-sm">
                                {t("create.pin")}
                                <Input
                                    name="password"
                                    type="password"
                                    placeholder={t("form.noPin")}
                                    autoComplete="off"
                                />
                            </label>
                            <label className="flex items-center gap-2 text-sm">
                                <input
                                    type="checkbox"
                                    name="requireLogin"
                                    defaultChecked={initial?.requireLogin}
                                    className="size-4"
                                />
                                {t("form.requireLogin")}
                            </label>
                            <label className="flex items-center gap-2 text-sm">
                                <input
                                    type="checkbox"
                                    name="allowOverwrite"
                                    defaultChecked={initial?.allowOverwrite}
                                    className="size-4"
                                />
                                {t("form.overwrite")}
                            </label>
                            <div className="flex flex-col gap-1.5 text-sm">
                                <label className="flex items-center gap-2">
                                    <input
                                        type="checkbox"
                                        name="allowUploaderDelete"
                                        defaultChecked={initial?.allowUploaderDelete}
                                        className="size-4"
                                    />
                                    {t("form.uploaderDelete")}
                                </label>
                                <label className="flex items-center gap-2 text-xs text-muted-foreground">
                                    {t.rich("form.deleteWindow", {
                                        field: () => (
                                            <Input
                                                key="window"
                                                name="deleteWindowMin"
                                                type="number"
                                                min="1"
                                                defaultValue={initial?.deleteWindowMin}
                                                placeholder={t("form.anytime")}
                                                className="h-8 w-24"
                                            />
                                        )
                                    })}
                                </label>
                            </div>
                            <label className="flex flex-col gap-1 text-sm">
                                {t("form.users")}
                                <AccountInput
                                    multiple
                                    name="allowedUsers"
                                    defaultValue={initial?.allowedUsers}
                                    placeholder={t("form.usersPlaceholder")}
                                    aria-label={t("form.usersLabel")}
                                />
                                <span className="text-xs text-muted-foreground">
                                    {t("form.usersHint")}
                                </span>
                            </label>
                            <label className="flex flex-col gap-1 text-sm">
                                {t("form.cidrs")}
                                <Input
                                    name="allowedCidrs"
                                    defaultValue={initial?.allowedCidrs}
                                    placeholder={t("form.cidrsPlaceholder")}
                                    autoComplete="off"
                                />
                            </label>
                            <div className="flex flex-col gap-1 text-sm">
                                {t("form.location")}
                                <GeoPicker
                                    countries={geoCountries}
                                    continents={geoContinents}
                                    onCountries={setGeoCountries}
                                    onContinents={setGeoContinents}
                                />
                            </div>
                        </Section>

                        {error ? <p className="text-sm text-danger">{error}</p> : null}
                        <div className="mt-1 flex justify-end gap-2">
                            <Button type="submit" disabled={pending}>
                                <Inbox className="size-4" />
                                {pending ? t("create.creating") : t("create.submit")}
                            </Button>
                        </div>
                    </form>
                )}
            </DialogContent>
        </Dialog>
    );
}
