"use client";

/**
 * The saved views of a list and the menu that switches between them. Every
 * kind of record has its default view ("All companies"); somebody who may
 * change records can save the way the list is drawn now as a new named view,
 * and rename or delete the named ones.
 */

import { useCrmT } from "./i18n";
import { messageOf } from "./call";
import { useState, type FormEvent } from "react";
import type { CrmObject } from "../model/objects";
import { Check, ChevronDown, Kanban, Pencil, Plus, Table2, Trash2 } from "lucide-react";
import {
    groupFields,
    normalizeViewName,
    VIEW_NAME_MAX,
    type ViewKind,
    type ViewSummary
} from "../model/views";
import {
    Button,
    Dialog,
    DialogContent,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
    Input,
    SegmentedControl
} from "@polaris/ui";

const KIND_ICON = { table: Table2, kanban: Kanban } as const;

/** The name a view is shown by: its own, or the default view's. */
export function useViewName() {
    const t = useCrmT();
    return (view: ViewSummary) => view.name || t("views.default");
}

export function ViewPicker({
    object,
    views,
    current,
    canEdit,
    onPick,
    onCreate,
    onRename,
    onDelete,
    disabled
}: {
    object: CrmObject;
    views: readonly ViewSummary[];
    current: ViewSummary | null;
    canEdit: boolean;
    onPick: (view: ViewSummary) => void;
    /** Resolves once the view is kept; throws the sentence to show if not. */
    onCreate: (name: string, kind: ViewKind) => Promise<void>;
    onRename: (view: ViewSummary, name: string) => Promise<void>;
    onDelete: (view: ViewSummary) => void;
    disabled?: boolean;
}) {
    const t = useCrmT();
    const viewName = useViewName();
    const [naming, setNaming] = useState<{ mode: "create" } | { mode: "rename"; view: ViewSummary } | null>(
        null
    );
    const CurrentIcon = KIND_ICON[current?.kind ?? "table"];
    const taken = (name: string, except?: string) =>
        views.some(
            (view) =>
                view.id !== except &&
                viewName(view).toLocaleLowerCase() === name.toLocaleLowerCase()
        );

    return (
        <>
            <DropdownMenu>
                <DropdownMenuTrigger asChild>
                    <Button
                        variant="ghost"
                        size="sm"
                        disabled={disabled || !current}
                        className="min-w-0 max-w-full gap-1.5 px-2"
                        aria-label={t("views.picker")}
                    >
                        <CurrentIcon className="size-4 shrink-0 text-muted-foreground" />
                        <span className="truncate" title={current ? viewName(current) : undefined}>
                            {current ? viewName(current) : t("list.loading")}
                        </span>
                        <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
                    </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-64">
                    <DropdownMenuLabel>{t("views.title")}</DropdownMenuLabel>
                    {views.map((view) => {
                        const Icon = KIND_ICON[view.kind];
                        return (
                            <DropdownMenuItem
                                key={view.id}
                                onSelect={() => onPick(view)}
                                className="gap-2"
                            >
                                <Icon className="size-3.5 shrink-0 text-muted-foreground" />
                                <span className="min-w-0 flex-1 truncate" title={viewName(view)}>
                                    {viewName(view)}
                                </span>
                                {view.id === current?.id ? (
                                    <Check className="size-3.5 shrink-0" />
                                ) : null}
                            </DropdownMenuItem>
                        );
                    })}
                    {canEdit ? (
                        <>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem onSelect={() => setNaming({ mode: "create" })}>
                                <Plus className="size-3.5" />
                                {t("views.create")}
                            </DropdownMenuItem>
                            {current && current.name ? (
                                <>
                                    <DropdownMenuItem
                                        onSelect={() => setNaming({ mode: "rename", view: current })}
                                    >
                                        <Pencil className="size-3.5" />
                                        {t("views.rename")}
                                    </DropdownMenuItem>
                                    <DropdownMenuItem
                                        className="text-danger"
                                        onSelect={() => onDelete(current)}
                                    >
                                        <Trash2 className="size-3.5" />
                                        {t("views.delete")}
                                    </DropdownMenuItem>
                                </>
                            ) : null}
                        </>
                    ) : null}
                </DropdownMenuContent>
            </DropdownMenu>
            {naming ? (
                <ViewNameDialog
                    object={object}
                    initialName={naming.mode === "rename" ? naming.view.name : ""}
                    initialKind={naming.mode === "rename" ? null : (current?.kind ?? "table")}
                    taken={(name) =>
                        taken(name, naming.mode === "rename" ? naming.view.id : undefined)
                    }
                    onSubmit={(name, kind) =>
                        naming.mode === "rename"
                            ? onRename(naming.view, name)
                            : onCreate(name, kind ?? "table")
                    }
                    onClose={() => setNaming(null)}
                />
            ) : null}
        </>
    );
}

/** Naming a new view (and choosing table or board), or renaming one. */
function ViewNameDialog({
    object,
    initialName,
    initialKind,
    taken,
    onSubmit,
    onClose
}: {
    object: CrmObject;
    initialName: string;
    /** Null when renaming: the kind is not asked. */
    initialKind: ViewKind | null;
    taken: (name: string) => boolean;
    onSubmit: (name: string, kind: ViewKind | null) => Promise<void>;
    onClose: () => void;
}) {
    const t = useCrmT();
    const [name, setName] = useState(initialName);
    const [kind, setKind] = useState<ViewKind | null>(initialKind);
    const [busy, setBusy] = useState(false);
    const [failure, setFailure] = useState<string | null>(null);
    const clean = normalizeViewName(name);
    const duplicate = clean !== "" && taken(clean);
    const unchanged = initialKind === null && clean === normalizeViewName(initialName);
    const blocked = clean === "" || duplicate || unchanged || busy;
    const boardable = groupFields(object).length > 0;

    const submit = (event: FormEvent) => {
        event.preventDefault();
        if (blocked) return;
        setBusy(true);
        setFailure(null);
        onSubmit(clean, kind)
            .then(onClose)
            .catch((caught) => {
                setFailure(messageOf(caught));
                setBusy(false);
            });
    };

    return (
        <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
            <DialogContent className="max-w-md">
                <form onSubmit={submit} className="flex flex-col gap-4">
                    <DialogHeader className="mb-0">
                        <DialogTitle>
                            {initialKind === null ? t("views.renameTitle") : t("views.createTitle")}
                        </DialogTitle>
                    </DialogHeader>
                    <label className="flex flex-col gap-1.5 text-[0.8125rem]">
                        <span className="font-medium">
                            {t("views.name")}
                            <span aria-hidden className="text-danger">
                                {" "}
                                *
                            </span>
                        </span>
                        <Input
                            autoFocus
                            value={name}
                            maxLength={VIEW_NAME_MAX}
                            required
                            aria-invalid={duplicate}
                            placeholder={t("views.namePlaceholder")}
                            onChange={(event) => setName(event.target.value)}
                        />
                        {duplicate ? (
                            <span className="text-[0.75rem] text-danger">{t("views.nameTaken")}</span>
                        ) : null}
                    </label>
                    {kind !== null ? (
                        <div className="flex flex-col gap-1.5 text-[0.8125rem]">
                            <span className="font-medium">{t("views.layout")}</span>
                            <SegmentedControl
                                value={kind}
                                onValueChange={setKind}
                                aria-label={t("views.layout")}
                                options={[
                                    { value: "table", label: t("views.kinds.table") },
                                    {
                                        value: "kanban",
                                        label: t("views.kinds.kanban"),
                                        disabled: !boardable,
                                        title: boardable ? undefined : t("views.noBoard")
                                    }
                                ]}
                            />
                        </div>
                    ) : null}
                    {failure ? <p className="text-[0.75rem] text-danger">{failure}</p> : null}
                    <DialogFooter className="mt-0">
                        <Button type="button" variant="ghost" onClick={onClose}>
                            {t("actions.cancel")}
                        </Button>
                        <Button type="submit" aria-disabled={blocked} className={blocked ? "opacity-60" : undefined}>
                            {initialKind === null ? t("views.save") : t("views.createButton")}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
