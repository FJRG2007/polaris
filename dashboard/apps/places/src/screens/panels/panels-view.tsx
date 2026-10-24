"use client";

/**
 * A place's wall panels: pick one, arrange its cards, hand it to a wall
 * tablet as a link, or open it full screen. Arranging is `home.manage`; the
 * rest of the house sees the panels and opens them.
 *
 * Every change to the cards is saved as it is made - the card moves at once
 * and moves back if the save is refused - so there is no unsaved state to
 * lose by closing the tab.
 */

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Clock, ExternalLink, LayoutGrid, Pencil, Plus, Share2, Trash2 } from "lucide-react";
import {
    Button,
    ConfirmDeleteDialog,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    EmptyState,
    Input,
    cn
} from "@polaris/ui";
import * as actions from "./actions";
import { usePlacesT } from "../use-places-t";
import { hostUi } from "@polaris/app-host/client";
import { DeviceIcon } from "../devices/device-panel";
import { PanelBoard, type BoardRoom } from "./panel-board";
import {
    PANEL_NAME_MAX,
    addCard,
    normalizePanelName,
    panelNameSchema,
    type NewCard,
    type PanelCard,
    type PanelView
} from "../../lib/panel-layout";
import type { DeviceView } from "../../lib/device-kinds";

const { runAction } = hostUi.runAction;
const { ShareDialog } = hostUi.accessShareDialog;

/** A card's id: short, unique on its panel, made in the browser. */
function cardId(): string {
    return Math.random().toString(36).slice(2, 10);
}

/** The name dialog, for a new panel and a rename. Checked as it is typed. */
function NameDialog({
    open,
    title,
    initial,
    confirm,
    onClose,
    onSubmit
}: {
    open: boolean;
    title: string;
    initial: string;
    confirm: string;
    onClose: () => void;
    onSubmit: (name: string) => Promise<string | null>;
}) {
    const t = usePlacesT();
    const [name, setName] = useState(initial);
    const [error, setError] = useState("");
    const [busy, setBusy] = useState(false);
    const normalized = normalizePanelName(name);
    const check = panelNameSchema.safeParse(normalized);
    const issue = normalized.length > 0 && !check.success ? check.error.issues[0]?.message : "";
    const unchanged = normalized === normalizePanelName(initial);
    const submit = async () => {
        if (!check.success || unchanged) return;
        setBusy(true);
        const refused = await onSubmit(check.data);
        setBusy(false);
        if (refused) setError(refused);
        else onClose();
    };
    return (
        <Dialog open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>{title}</DialogTitle>
                </DialogHeader>
                <form
                    className="flex flex-col gap-2"
                    onSubmit={(event) => {
                        event.preventDefault();
                        void submit();
                    }}
                >
                    <label className="flex flex-col gap-1 text-sm">
                        <span>
                            {t("panels.name")} <span aria-hidden>*</span>
                        </span>
                        <Input
                            autoFocus
                            value={name}
                            maxLength={PANEL_NAME_MAX + 20}
                            placeholder={t("panels.namePlaceholder")}
                            aria-invalid={Boolean(issue)}
                            onChange={(event) => {
                                setName(event.target.value);
                                setError("");
                            }}
                        />
                    </label>
                    {issue || error ? (
                        <p role="alert" className="text-sm text-danger">
                            {error ||
                                (issue === "That name is too long"
                                    ? t("refusals.panelNameLong")
                                    : t("refusals.panelName"))}
                        </p>
                    ) : null}
                    <DialogFooter>
                        <Button type="button" variant="outline" onClick={onClose}>
                            {t("panels.cancel")}
                        </Button>
                        <Button
                            type="submit"
                            aria-disabled={!check.success || unchanged || busy}
                            disabled={busy}
                        >
                            {confirm}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}

/** What can be put on a panel: a clock, a device, a room. */
function AddCardDialog({
    open,
    devices,
    rooms,
    onClose,
    onPick
}: {
    open: boolean;
    devices: readonly DeviceView[];
    rooms: readonly BoardRoom[];
    onClose: () => void;
    onPick: (card: NewCard) => void;
}) {
    const t = usePlacesT();
    const row =
        "flex min-h-11 w-full min-w-0 items-center gap-2 rounded-md px-3 py-2 text-left text-sm hover:bg-muted";
    return (
        <Dialog open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
            <DialogContent className="flex max-h-[85dvh] flex-col">
                <DialogHeader>
                    <DialogTitle>{t("panels.addCard")}</DialogTitle>
                    <DialogDescription>{t("panels.arrangeHint")}</DialogDescription>
                </DialogHeader>
                <div className="flex min-h-0 flex-col gap-4 overflow-y-auto overscroll-contain">
                    <button type="button" className={row} onClick={() => onPick({ type: "clock" })}>
                        <Clock className="size-4 shrink-0 text-muted-foreground" />
                        {t("panels.addClock")}
                    </button>
                    <section className="flex flex-col gap-1">
                        <h3 className="px-3 text-xs font-medium text-muted-foreground">
                            {t("panels.pickRoom")}
                        </h3>
                        {rooms.length === 0 ? (
                            <p className="px-3 text-sm text-muted-foreground">
                                {t("panels.noRooms")}
                            </p>
                        ) : (
                            rooms.map((room) => (
                                <button
                                    key={room.id}
                                    type="button"
                                    className={row}
                                    onClick={() => onPick({ type: "room", roomId: room.id })}
                                >
                                    <LayoutGrid className="size-4 shrink-0 text-muted-foreground" />
                                    <span className="truncate" title={room.name}>
                                        {room.name}
                                    </span>
                                </button>
                            ))
                        )}
                    </section>
                    <section className="flex flex-col gap-1">
                        <h3 className="px-3 text-xs font-medium text-muted-foreground">
                            {t("panels.pickDevice")}
                        </h3>
                        {devices.length === 0 ? (
                            <p className="px-3 text-sm text-muted-foreground">
                                {t("panels.noDevices")}
                            </p>
                        ) : (
                            devices.map((device) => (
                                <button
                                    key={device.id}
                                    type="button"
                                    className={row}
                                    onClick={() => onPick({ type: "device", deviceId: device.id })}
                                >
                                    <DeviceIcon
                                        kind={device.kind}
                                        className="size-4 shrink-0 text-muted-foreground"
                                    />
                                    <span className="truncate" title={device.name}>
                                        {device.name}
                                    </span>
                                </button>
                            ))
                        )}
                    </section>
                </div>
            </DialogContent>
        </Dialog>
    );
}

export function PanelsView({
    placeId,
    panels: initial,
    devices,
    rooms,
    canControl,
    canManage
}: {
    placeId: string;
    panels: readonly PanelView[];
    devices: readonly DeviceView[];
    rooms: readonly BoardRoom[];
    canControl: boolean;
    canManage: boolean;
}) {
    const t = usePlacesT();
    const router = useRouter();
    const [panels, setPanels] = useState<PanelView[]>([...initial]);
    const [selectedId, setSelectedId] = useState<string | null>(initial[0]?.id ?? null);
    const [editing, setEditing] = useState(false);
    const [naming, setNaming] = useState<"new" | "rename" | null>(null);
    const [adding, setAdding] = useState(false);
    const [sharing, setSharing] = useState(false);
    const [removing, setRemoving] = useState(false);
    const [error, setError] = useState("");
    const selected = panels.find((panel) => panel.id === selectedId) ?? null;

    const replace = (next: PanelView) =>
        setPanels((list) => list.map((panel) => (panel.id === next.id ? next : panel)));

    /** Save cards at once on the screen, and put the old ones back if refused. */
    const saveCards = async (cards: PanelCard[]) => {
        if (!selected) return;
        const before = selected;
        const pressed = { ...selected, cards };
        replace(pressed);
        setError("");
        const result = await runAction(
            () => actions.savePanelCardsAction(before.id, cards),
            setError
        );
        if (!result || result.error || !result.panel) {
            setPanels((list) => list.map((panel) => (panel === pressed ? before : panel)));
            if (result?.error) setError(result.error);
            return;
        }
        router.refresh();
    };

    const create = async (name: string): Promise<string | null> => {
        const result = await runAction(() => actions.createPanelAction(name), setError);
        if (!result || result.error || !result.panel) return result?.error ?? t("panels.notSaved");
        setPanels((list) => [...list, result.panel!].sort((a, b) => a.name.localeCompare(b.name)));
        setSelectedId(result.panel.id);
        setEditing(true);
        return null;
    };
    const rename = async (name: string): Promise<string | null> => {
        if (!selected) return null;
        const result = await runAction(
            () => actions.renamePanelAction(selected.id, name),
            setError
        );
        if (!result || result.error || !result.panel) return result?.error ?? t("panels.notSaved");
        replace(result.panel);
        return null;
    };
    const remove = async () => {
        if (!selected) return;
        const gone = selected;
        setRemoving(false);
        setPanels((list) => list.filter((panel) => panel.id !== gone.id));
        setSelectedId(panels.find((panel) => panel.id !== gone.id)?.id ?? null);
        const result = await runAction(() => actions.deletePanelAction(gone.id), setError);
        if (!result || result.error) {
            setPanels((list) => [...list, gone].sort((a, b) => a.name.localeCompare(b.name)));
            setSelectedId(gone.id);
            if (result?.error) setError(result.error);
        }
    };

    const access = useMemo(() => ({ kind: "session" as const, canControl }), [canControl]);

    return (
        <div className="flex flex-col gap-4">
            {panels.length === 0 ? (
                <EmptyState
                    icon={<LayoutGrid />}
                    title={t("panels.empty")}
                    description={t("panels.emptyHint")}
                    action={
                        canManage ? (
                            <Button onClick={() => setNaming("new")}>
                                <Plus className="size-4" />
                                {t("panels.add")}
                            </Button>
                        ) : undefined
                    }
                />
            ) : (
                <div
                    className="flex min-w-0 flex-wrap items-center gap-2"
                    aria-label={t("panels.panelsAt")}
                >
                    {panels.map((panel) => (
                        <Button
                            key={panel.id}
                            variant={panel.id === selectedId ? "primary" : "outline"}
                            size="sm"
                            aria-pressed={panel.id === selectedId}
                            onClick={() => {
                                setSelectedId(panel.id);
                                setEditing(false);
                            }}
                            className="max-w-[16rem]"
                        >
                            <span className="truncate" title={panel.name}>
                                {panel.name}
                            </span>
                        </Button>
                    ))}
                    {canManage ? (
                        <Button variant="ghost" size="sm" onClick={() => setNaming("new")}>
                            <Plus className="size-4" />
                            {t("panels.add")}
                        </Button>
                    ) : null}
                </div>
            )}

            {selected ? (
                <section className="flex flex-col gap-3">
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                        <h2
                            className="min-w-0 flex-1 truncate text-base font-medium"
                            title={selected.name}
                        >
                            {selected.name}
                            <span className="ml-2 text-sm font-normal text-muted-foreground">
                                {t("panels.cards", { count: selected.cards.length })}
                            </span>
                        </h2>
                        {canManage ? (
                            <>
                                <Button
                                    size="sm"
                                    variant={editing ? "primary" : "outline"}
                                    onClick={() => setEditing(!editing)}
                                >
                                    {editing ? t("panels.done") : t("panels.edit")}
                                </Button>
                                {editing ? (
                                    <Button
                                        size="sm"
                                        variant="outline"
                                        onClick={() => setAdding(true)}
                                    >
                                        <Plus className="size-4" />
                                        {t("panels.addCard")}
                                    </Button>
                                ) : null}
                                <Button
                                    size="sm"
                                    variant="ghost"
                                    className="size-9 p-0"
                                    aria-label={t("panels.rename", { name: selected.name })}
                                    title={t("panels.rename", { name: selected.name })}
                                    onClick={() => setNaming("rename")}
                                >
                                    <Pencil className="size-4" />
                                </Button>
                                <Button
                                    size="sm"
                                    variant="ghost"
                                    className="size-9 p-0"
                                    aria-label={t("panels.share", { name: selected.name })}
                                    title={t("panels.share", { name: selected.name })}
                                    onClick={() => setSharing(true)}
                                >
                                    <Share2 className="size-4" />
                                </Button>
                                <Button
                                    size="sm"
                                    variant="ghost"
                                    className="size-9 p-0"
                                    aria-label={t("panels.remove", { name: selected.name })}
                                    title={t("panels.remove", { name: selected.name })}
                                    onClick={() => setRemoving(true)}
                                >
                                    <Trash2 className="size-4" />
                                </Button>
                            </>
                        ) : null}
                        <Button asChild size="sm" variant="outline">
                            <a href={`/wall/${selected.id}`} target="_blank" rel="noopener">
                                <ExternalLink className="size-4" />
                                {t("panels.open")}
                            </a>
                        </Button>
                    </div>
                    {editing ? (
                        <p className="text-xs text-muted-foreground">{t("panels.arrangeHint")}</p>
                    ) : null}
                    {error ? (
                        <p
                            role="alert"
                            className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger-ink"
                        >
                            {error}
                        </p>
                    ) : null}
                    {selected.cards.length === 0 ? (
                        <EmptyState
                            icon={<LayoutGrid />}
                            title={t("panels.noCards")}
                            description={canManage ? t("panels.noCardsHint") : undefined}
                            action={
                                canManage ? (
                                    <Button
                                        onClick={() => {
                                            setEditing(true);
                                            setAdding(true);
                                        }}
                                    >
                                        <Plus className="size-4" />
                                        {t("panels.addCard")}
                                    </Button>
                                ) : undefined
                            }
                        />
                    ) : (
                        <div className={cn(editing && "rounded-xl bg-muted/40 p-2")}>
                            <PanelBoard
                                placeId={placeId}
                                cards={selected.cards}
                                devices={devices}
                                rooms={rooms}
                                access={access}
                                editing={editing}
                                onCardsChange={(cards) => void saveCards(cards)}
                                onError={setError}
                            />
                        </div>
                    )}
                </section>
            ) : null}

            {naming ? (
                <NameDialog
                    open
                    title={naming === "new" ? t("panels.add") : t("panels.renameTitle")}
                    initial={naming === "rename" ? (selected?.name ?? "") : ""}
                    confirm={naming === "new" ? t("panels.create") : t("panels.save")}
                    onClose={() => setNaming(null)}
                    onSubmit={naming === "new" ? create : rename}
                />
            ) : null}
            <AddCardDialog
                open={adding}
                devices={devices}
                rooms={rooms}
                onClose={() => setAdding(false)}
                onPick={(card) => {
                    setAdding(false);
                    if (!selected) return;
                    const next = addCard(selected.cards, card, cardId());
                    if (next.length === selected.cards.length) setError(t("panels.full"));
                    else void saveCards(next);
                }}
            />
            {selected && sharing ? (
                <ShareDialog
                    open
                    onOpenChange={(next: boolean) => (next ? undefined : setSharing(false))}
                    subject="place.panel"
                    subjectId={selected.id}
                    name={selected.name}
                    bounded
                />
            ) : null}
            <ConfirmDeleteDialog
                open={removing}
                onOpenChange={(next) => (next ? undefined : setRemoving(false))}
                name={selected?.name ?? ""}
                kind="panel"
                requireTyping={false}
                title={t("panels.removeTitle")}
                question={t("panels.removeQuestion", { name: selected?.name ?? "" })}
                description={t("panels.removeBody")}
                confirmLabel={t("panels.removeConfirm")}
                onConfirm={() => void remove()}
            />
        </div>
    );
}
