"use client";

/**
 * A place's wall panels as a table: a search, a row per panel, and the same
 * menu on a row's dots and on a right-click. A row opens the panel's own page,
 * where it is arranged and previewed; "Open full screen" is the wall itself.
 *
 * Building, copying and removing are `home.manage`, so those entries are not
 * offered to anyone else. A removal leaves the table at once and comes back if
 * the server refuses it; a copy shows as a row being made until it is saved.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState, type ComponentType, type MouseEvent, type ReactNode } from "react";
import { Copy, ExternalLink, LayoutGrid, MoreHorizontal, Pencil, Plus, Search, Trash2 } from "lucide-react";
import {
    Button,
    ConfirmDeleteDialog,
    ContextMenu,
    ContextMenuContent,
    ContextMenuItem,
    ContextMenuSeparator,
    ContextMenuTrigger,
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
    EmptyState,
    Input,
    cn,
    rowClickIntent
} from "@polaris/ui";
import * as actions from "./actions";
import { usePlacesT } from "../use-places-t";
import { NameDialog } from "./panel-name-dialog";
import { hostUi } from "@polaris/app-host/client";
import { matchPanels, type PanelView } from "../../lib/panel-layout";

const { runAction } = hostUi.runAction;
const { RelativeTime } = hostUi.relativeTime;

/** Rows drawn before "Show more". */
const PAGE = 25;

/** The page a panel is arranged on. */
export function panelHref(id: string): string {
    return `/places/panels/${encodeURIComponent(id)}`;
}

interface RowActions {
    readonly panel: PanelView;
    readonly canManage: boolean;
    readonly open: () => void;
    readonly duplicate: () => void;
    readonly remove: () => void;
}

interface MenuParts {
    Item: ComponentType<{
        onSelect?: (event: Event) => void;
        className?: string;
        children?: ReactNode;
    }>;
    Separator: ComponentType;
}

const DROPDOWN_PARTS: MenuParts = { Item: DropdownMenuItem, Separator: DropdownMenuSeparator };
const CONTEXT_PARTS: MenuParts = { Item: ContextMenuItem, Separator: ContextMenuSeparator };

function RowMenuItems({ row, parts }: { row: RowActions; parts: MenuParts }) {
    const t = usePlacesT();
    const { Item, Separator } = parts;
    return (
        <>
            <Item
                onSelect={() => window.open(`/wall/${encodeURIComponent(row.panel.id)}`, "_blank", "noopener")}
            >
                <ExternalLink className="size-4 shrink-0" />
                {t("panels.openFull")}
            </Item>
            <Item onSelect={row.open}>
                <Pencil className="size-4 shrink-0" />
                {t("panels.edit")}
            </Item>
            {row.canManage ? (
                <>
                    <Item onSelect={row.duplicate}>
                        <Copy className="size-4 shrink-0" />
                        {t("panels.duplicate")}
                    </Item>
                    <Separator />
                    <Item onSelect={row.remove} className="text-danger">
                        <Trash2 className="size-4 shrink-0" />
                        {t("panels.removeConfirm")}
                    </Item>
                </>
            ) : null}
        </>
    );
}

function PanelRow({ row, placeName }: { row: RowActions; placeName: string }) {
    const t = usePlacesT();
    const { panel } = row;
    const pending = panel.id.startsWith("pending:");
    const href = panelHref(panel.id);
    const actionsLabel = t("panels.actionsFor", { name: panel.name });
    const layout = t("panels.layoutValue", {
        size: t(`panelStyle.cardSizes.${panel.style.cardSize}`),
        orientation: t(`panelStyle.orientations.${panel.style.orientation}`)
    });

    const openFromRow = (event: MouseEvent) => {
        if (pending) return;
        const intent = rowClickIntent({
            target: event.target instanceof Element ? event.target : null,
            button: event.button,
            metaKey: event.metaKey,
            ctrlKey: event.ctrlKey,
            shiftKey: event.shiftKey,
            selection: window.getSelection()?.toString() ?? ""
        });
        if (intent === "open") row.open();
        else if (intent === "new-tab") window.open(href, "_blank", "noopener");
    };

    const tr = (
        <tr
            className={cn(
                "border-t border-border",
                pending ? "opacity-60" : "cursor-pointer hover:bg-card-hover"
            )}
            aria-busy={pending || undefined}
            onClick={openFromRow}
            onAuxClick={openFromRow}
        >
            <td className="max-w-0 px-3 py-2">
                {pending ? (
                    <span className="block truncate font-medium" title={panel.name}>
                        {panel.name}
                    </span>
                ) : (
                    <Link
                        href={href}
                        className="block truncate font-medium hover:underline"
                        title={panel.name}
                    >
                        {panel.name}
                    </Link>
                )}
            </td>
            <td className="hidden max-w-0 px-3 py-2 text-muted-foreground md:table-cell">
                <span className="block truncate" title={placeName}>
                    {placeName}
                </span>
            </td>
            <td className="whitespace-nowrap px-3 py-2 tabular-nums text-muted-foreground">
                {t("panels.cards", { count: panel.cards.length })}
            </td>
            <td className="hidden max-w-0 px-3 py-2 text-muted-foreground lg:table-cell">
                <span className="block truncate" title={layout}>
                    {layout}
                </span>
            </td>
            <td className="hidden whitespace-nowrap px-3 py-2 text-muted-foreground sm:table-cell">
                {panel.openedAt ? <RelativeTime iso={panel.openedAt} /> : t("panels.neverOpened")}
            </td>
            <td className="w-12 px-1 py-1 text-right">
                {pending ? null : (
                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <Button
                                variant="ghost"
                                size="icon"
                                className="shrink-0"
                                aria-label={actionsLabel}
                                title={actionsLabel}
                            >
                                <MoreHorizontal className="size-4 shrink-0" />
                            </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                            <RowMenuItems row={row} parts={DROPDOWN_PARTS} />
                        </DropdownMenuContent>
                    </DropdownMenu>
                )}
            </td>
        </tr>
    );
    if (pending) return tr;
    return (
        <ContextMenu>
            <ContextMenuTrigger asChild>{tr}</ContextMenuTrigger>
            <ContextMenuContent>
                <RowMenuItems row={row} parts={CONTEXT_PARTS} />
            </ContextMenuContent>
        </ContextMenu>
    );
}

export function PanelsTable({
    panels: initial,
    placeName,
    canManage
}: {
    panels: readonly PanelView[];
    placeName: string;
    canManage: boolean;
}) {
    const t = usePlacesT();
    const router = useRouter();
    const [panels, setPanels] = useState<PanelView[]>([...initial]);
    const [query, setQuery] = useState("");
    const [limit, setLimit] = useState(PAGE);
    const [naming, setNaming] = useState(false);
    const [removing, setRemoving] = useState<PanelView | null>(null);
    const [error, setError] = useState("");
    const shown = useMemo(() => matchPanels(panels, query), [panels, query]);
    const byName = (list: PanelView[]) => list.sort((a, b) => a.name.localeCompare(b.name));

    const create = async (name: string): Promise<string | null> => {
        const result = await runAction(() => actions.createPanelAction(name), setError);
        if (!result || result.error || !result.panel) return result?.error ?? t("panels.notSaved");
        router.push(panelHref(result.panel.id));
        return null;
    };

    /** A copy shows at once as a row being made, and leaves if refused. */
    const duplicate = async (panel: PanelView) => {
        const placeholder: PanelView = {
            ...panel,
            id: `pending:${panel.id}:${Date.now()}`,
            name: t("panels.duplicateName", { name: panel.name }),
            openedAt: null
        };
        setError("");
        setPanels((list) => byName([...list, placeholder]));
        const result = await runAction(() => actions.duplicatePanelAction(panel.id), setError);
        setPanels((list) => {
            const rest = list.filter((entry) => entry.id !== placeholder.id);
            return result?.panel ? byName([...rest, result.panel]) : rest;
        });
        if (result?.error) setError(result.error);
    };

    /** A removal leaves the table at once, and comes back if refused. */
    const remove = async (panel: PanelView) => {
        setRemoving(null);
        setError("");
        setPanels((list) => list.filter((entry) => entry.id !== panel.id));
        const result = await runAction(() => actions.deletePanelAction(panel.id), setError);
        if (!result || result.error) {
            setPanels((list) => byName([...list.filter((entry) => entry.id !== panel.id), panel]));
            if (result?.error) setError(result.error);
        }
    };

    const newButton = canManage ? (
        <Button onClick={() => setNaming(true)}>
            <Plus className="size-4" />
            {t("panels.add")}
        </Button>
    ) : null;

    return (
        <div className="flex flex-col gap-4">
            {panels.length === 0 ? (
                <EmptyState
                    icon={<LayoutGrid />}
                    title={t("panels.empty")}
                    description={t("panels.emptyHint")}
                    action={newButton ?? undefined}
                />
            ) : (
                <>
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                        <div className="relative min-w-0 flex-1 sm:max-w-xs">
                            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 shrink-0 text-foreground-subtle" />
                            <Input
                                type="search"
                                value={query}
                                onChange={(event) => {
                                    setQuery(event.target.value);
                                    setLimit(PAGE);
                                }}
                                placeholder={t("panels.search")}
                                aria-label={t("panels.search")}
                                className="pl-8"
                            />
                        </div>
                        <div className="ml-auto">{newButton}</div>
                    </div>
                    {error ? (
                        <p
                            role="alert"
                            className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger-ink"
                        >
                            {error}
                        </p>
                    ) : null}
                    {shown.length === 0 ? (
                        <EmptyState icon={<Search />} title={t("panels.noMatch")} />
                    ) : (
                        <div className="overflow-x-auto overscroll-contain rounded-lg border border-border">
                            <table className="w-full table-fixed text-sm" aria-label={t("panels.panelsAt")}>
                                <thead className="bg-surface/60 text-left text-xs text-muted-foreground">
                                    <tr>
                                        <th className="px-3 py-2 font-medium">{t("panels.tableName")}</th>
                                        <th className="hidden px-3 py-2 font-medium md:table-cell">
                                            {t("panels.tablePlace")}
                                        </th>
                                        <th className="w-28 px-3 py-2 font-medium">{t("panels.tableCards")}</th>
                                        <th className="hidden px-3 py-2 font-medium lg:table-cell">
                                            {t("panels.tableLayout")}
                                        </th>
                                        <th className="hidden w-36 px-3 py-2 font-medium sm:table-cell">
                                            {t("panels.tableOpened")}
                                        </th>
                                        <th className="w-12 px-1 py-2" />
                                    </tr>
                                </thead>
                                <tbody>
                                    {shown.slice(0, limit).map((panel) => (
                                        <PanelRow
                                            key={panel.id}
                                            placeName={placeName}
                                            row={{
                                                panel,
                                                canManage,
                                                open: () => router.push(panelHref(panel.id)),
                                                duplicate: () => void duplicate(panel),
                                                remove: () => setRemoving(panel)
                                            }}
                                        />
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}
                    {shown.length > limit ? (
                        <Button
                            variant="outline"
                            size="sm"
                            className="self-center"
                            onClick={() => setLimit((current) => current + PAGE)}
                        >
                            {t("devicesView.showMore", { count: Math.min(PAGE, shown.length - limit) })}
                        </Button>
                    ) : null}
                </>
            )}
            {naming ? (
                <NameDialog
                    open
                    title={t("panels.add")}
                    initial=""
                    confirm={t("panels.create")}
                    onClose={() => setNaming(false)}
                    onSubmit={create}
                />
            ) : null}
            <ConfirmDeleteDialog
                open={removing !== null}
                onOpenChange={(next) => (next ? undefined : setRemoving(null))}
                name={removing?.name ?? ""}
                kind="panel"
                requireTyping={false}
                title={t("panels.removeTitle")}
                question={t("panels.removeQuestion", { name: removing?.name ?? "" })}
                description={t("panels.removeBody")}
                confirmLabel={t("panels.removeConfirm")}
                onConfirm={() => {
                    if (removing) void remove(removing);
                }}
            />
        </div>
    );
}
