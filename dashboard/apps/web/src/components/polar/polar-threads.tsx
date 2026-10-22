"use client";

/**
 * Polar's sidebar, laid out the way ChatGPT lays its own out: the name with
 * search and a button that puts the sidebar away; "New chat"; Pinned (only
 * when something is pinned); Projects, folders of chats whose instructions
 * reach the model; and Recents under a header that folds (remembered), grouped
 * by when each chat was last touched. A row is its title; hovering, focusing or
 * opening it draws the pill with its pin and its "..." menu: Rename, Pin,
 * Share, Archive, Delete, Move to project.
 *
 * Used twice - as the /polar page's sidebar (and its drawer on a phone), and as
 * the side panel's history view - so the two never drift apart. The state and
 * the actions are `usePolarSidebar`'s.
 */

import { useEffect, useRef, useState, type ComponentType, type ReactNode } from "react";
import {
    FileDown,
    FileJson,
    Archive,
    ArchiveRestore,
    ChevronDown,
    ChevronRight,
    Folder,
    FolderInput,
    FolderMinus,
    FolderOpen,
    FolderPlus,
    Link2,
    Loader2,
    MoreHorizontal,
    Pencil,
    Pin,
    PinOff,
    Search,
    Share2,
    SquarePen,
    Trash2,
    Code2,
    ExternalLink
} from "lucide-react";
import {
    Button,
    cn,
    ConfirmDeleteDialog,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuSub,
    DropdownMenuSubContent,
    DropdownMenuSubTrigger,
    DropdownMenuTrigger,
    Input,
    keepFocusOnClose,
    Textarea,
    useDeferredFocus
} from "@polaris/ui";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { projectList, type PolarSidebar } from "@/components/polar/use-polar-sidebar";
import type { PolarRunMarks } from "@/components/polar/polar-runs";
import type { PolarRunView } from "@/lib/polar/runs";
import * as polarShared from "@/lib/polar/shared";
import {
    PolarShareDialog,
    SharedLinksDialog,
    SharedWithYou
} from "@/components/polar/polar-sharing";
import type { PolarProjectRow, PolarThreadRow } from "@/lib/polar/shared";
import { StateDot, type PolarCodeHistory } from "@/components/polar/polar-code";

/** The Code sessions listed beside the chats, for somebody who can open Agents. */
export interface PolarThreadsCode {
    readonly history: PolarCodeHistory;
    /** The session on screen, or null when Code is not. */
    readonly activeId: string | null;
    readonly onOpen: (id: string) => void;
    /** Whether Code is on screen: its sessions lead the list, and say when
     *  there are none. */
    readonly first: boolean;
}

export type ThreadRow = PolarThreadRow;

const RECENTS_KEY = "polar.recents";

function readFolded(): boolean {
    try {
        return window.localStorage.getItem(RECENTS_KEY) === "folded";
    } catch {
        return false;
    }
}

function writeFolded(folded: boolean): void {
    try {
        window.localStorage.setItem(RECENTS_KEY, folded ? "folded" : "open");
    } catch {
        // Not remembered.
    }
}

/** What a row's menu does, shared by every section. */
type RowActions = {
    projects: PolarProjectRow[];
    onOpen: (row: PolarThreadRow) => void;
    onRename: (row: PolarThreadRow, title: string) => void;
    onPin: (row: PolarThreadRow, pinned: boolean) => void;
    onShare: (row: PolarThreadRow) => void;
    onArchive: (row: PolarThreadRow) => void;
    onDelete: (row: PolarThreadRow) => void;
    onMove: (row: PolarThreadRow, projectId: string | null) => void;
    onMoveToNew: (row: PolarThreadRow) => void;
};

export function PolarThreads({
    sidebar,
    activeId,
    runs = {},
    onOpen,
    onNew,
    hide,
    code,
    newLabel
}: {
    sidebar: PolarSidebar;
    activeId: string;
    /** The chats answering, waiting for an approval, or finished unseen. */
    runs?: PolarRunMarks;
    onOpen: (id: string) => void;
    /** A new chat, filed under the project when one is given. */
    onNew: (projectId: string | null) => void;
    /** The button beside the search that puts the list away. */
    hide: { label: string; icon: ComponentType<{ className?: string }>; onClick: () => void };
    /** The person's Code sessions, when Code is open to them. */
    code?: PolarThreadsCode | null;
    /** The first row's words, when it starts something other than a chat. */
    newLabel?: string;
}) {
    const t = useTranslations("polar");
    const [deleting, setDeleting] = useState<PolarThreadRow | null>(null);
    const [sharing, setSharing] = useState<PolarThreadRow | null>(null);
    const [searching, setSearching] = useState(false);
    const [managingShares, setManagingShares] = useState(false);
    /** The project dialog: a new one (optionally for a chat to move into it),
     *  or an existing one to edit. */
    const [projectForm, setProjectForm] = useState<{
        project: PolarProjectRow | null;
        moving: PolarThreadRow | null;
    } | null>(null);
    const [deletingProject, setDeletingProject] = useState<PolarProjectRow | null>(null);
    const [folded, setFolded] = useState(false);
    useEffect(() => setFolded(readFolded()), []);
    const HideIcon = hide.icon;
    const { rows, projects } = sidebar;
    const sections = polarShared.threadSections(rows ?? []);

    const actions: RowActions = {
        projects: projects ?? [],
        onOpen: (row) => onOpen(row.id),
        onRename: (row, title) => void sidebar.rename(row.id, title),
        onPin: (row, pinned) => void sidebar.setPinned(row.id, pinned),
        onShare: setSharing,
        onArchive: (row) => void sidebar.setArchived(row.id, true),
        onDelete: setDeleting,
        onMove: (row, projectId) => void sidebar.move(row.id, projectId),
        onMoveToNew: (row) => setProjectForm({ project: null, moving: row })
    };
    const item = (row: PolarThreadRow) => (
        <ThreadItem
            key={row.id}
            row={row}
            active={row.id === activeId}
            run={runs[row.id] ?? null}
            actions={actions}
        />
    );
    const codeSection = code ? <CodeSection code={code} /> : null;

    return (
        <nav aria-label={t("history.title")} className="flex min-h-0 min-w-0 flex-1 flex-col">
            <div className="flex h-11 shrink-0 items-center gap-1 pl-4 pr-2">
                <span className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">
                    {t("page.title")}
                </span>
                <IconButton label={t("history.search")} onClick={() => setSearching(true)}>
                    <Search className="size-4" />
                </IconButton>
                <IconButton label={hide.label} onClick={hide.onClick}>
                    <HideIcon className="size-4" />
                </IconButton>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-2">
                <NavRow icon={SquarePen} onClick={() => onNew(null)}>
                    {newLabel ?? t("actions.new")}
                </NavRow>
                <NavRow icon={Link2} onClick={() => setManagingShares(true)}>
                    {t("sharing.links")}
                </NavRow>
                {rows === null ? (
                    <div className="space-y-2 p-2">
                        {[0, 1, 2].map((key) => (
                            <div
                                key={key}
                                className="h-6 rounded bg-muted motion-safe:animate-pulse"
                            />
                        ))}
                    </div>
                ) : (
                    <>
                        {code?.first ? codeSection : null}
                        {sections.pinned.length > 0 ? (
                            <Section id="polar-pinned" label={t("history.pinned")}>
                                {sections.pinned.map(item)}
                                <MoreButton sidebar={sidebar} list="pinned" />
                            </Section>
                        ) : null}
                        {code && !code.first ? codeSection : null}
                        <Section id="polar-projects" label={t("history.projects")}>
                            <NavRow
                                icon={FolderPlus}
                                onClick={() => setProjectForm({ project: null, moving: null })}
                            >
                                {t("history.newProject")}
                            </NavRow>
                            {(projects ?? []).map((project) => (
                                <ProjectItem
                                    key={project.id}
                                    project={project}
                                    open={sidebar.openProjects.has(project.id)}
                                    onToggle={() => sidebar.toggleProject(project.id)}
                                    onNew={() => onNew(project.id)}
                                    onEdit={() => setProjectForm({ project, moving: null })}
                                    onDelete={() => setDeletingProject(project)}
                                >
                                    {(sections.projects.get(project.id) ?? []).length > 0 ? (
                                        <>
                                            {(sections.projects.get(project.id) ?? []).map(item)}
                                            <MoreButton
                                                sidebar={sidebar}
                                                list={projectList(project.id)}
                                            />
                                        </>
                                    ) : (
                                        <p className="py-1.5 pl-9 pr-2 text-xs text-muted-foreground">
                                            {t("history.projectEmpty")}
                                        </p>
                                    )}
                                </ProjectItem>
                            ))}
                        </Section>
                        <SharedWithYou rowClass={SHARED_ROW} />
                        <div className="pt-4">
                            <button
                                type="button"
                                aria-expanded={!folded}
                                aria-controls="polar-recents"
                                onClick={() => {
                                    setFolded(!folded);
                                    writeFolded(!folded);
                                }}
                                className={cn(
                                    "flex w-full items-center gap-1 rounded-md px-2 pb-1 text-left hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                                    HEADING
                                )}
                            >
                                <span className="truncate">{t("history.recents")}</span>
                                {folded ? (
                                    <ChevronRight className="size-3.5 shrink-0" />
                                ) : (
                                    <ChevronDown className="size-3.5 shrink-0" />
                                )}
                            </button>
                            {folded ? null : (
                                <div id="polar-recents">
                                    {sections.recents.length === 0 ? (
                                        <p className="px-2 py-1.5 text-[0.8125rem] leading-5 text-muted-foreground">
                                            {t("history.empty")}
                                        </p>
                                    ) : (
                                        polarShared
                                            .groupThreads(sections.recents)
                                            .map(({ group, rows: list }) => (
                                                <div
                                                    key={group}
                                                    role="group"
                                                    aria-labelledby={`polar-group-${group}`}
                                                >
                                                    <p
                                                        id={`polar-group-${group}`}
                                                        className="px-2 pb-1 pt-2 text-[0.6875rem] text-foreground-subtle"
                                                    >
                                                        {t(`history.groups.${group}`)}
                                                    </p>
                                                    {list.map(item)}
                                                </div>
                                            ))
                                    )}
                                    <MoreButton sidebar={sidebar} list="recent" />
                                </div>
                            )}
                        </div>
                    </>
                )}
            </div>
            {searching ? (
                <SearchDialog
                    sidebar={sidebar}
                    onClose={() => setSearching(false)}
                    onOpen={(row) => {
                        sidebar.know(row);
                        setSearching(false);
                        onOpen(row.id);
                    }}
                />
            ) : null}
            {sharing ? <PolarShareDialog row={sharing} onClose={() => setSharing(null)} /> : null}
            {managingShares ? (
                <SharedLinksDialog
                    onClose={() => setManagingShares(false)}
                    onOpen={(id) => {
                        setManagingShares(false);
                        onOpen(id);
                    }}
                />
            ) : null}
            {projectForm ? (
                <ProjectDialog
                    project={projectForm.project}
                    onClose={() => setProjectForm(null)}
                    onSave={async (input) => {
                        if (projectForm.project) {
                            return sidebar.updateProject(projectForm.project.id, input);
                        }
                        const made = await sidebar.createProject(input);
                        if (made && projectForm.moving)
                            void sidebar.move(projectForm.moving.id, made.id);
                        return made !== null;
                    }}
                />
            ) : null}
            {deleting ? (
                <ConfirmDeleteDialog
                    open
                    onOpenChange={(open) => (open ? undefined : setDeleting(null))}
                    name={deleting.title}
                    requireTyping={false}
                    kind={t("history.kind")}
                    title={t("history.deleteTitle")}
                    question={t("history.deleteQuestion", { title: deleting.title })}
                    confirmLabel={t("history.deleteConfirm")}
                    onConfirm={() => {
                        void sidebar.remove(deleting.id);
                        setDeleting(null);
                    }}
                />
            ) : null}
            {deletingProject ? (
                <ConfirmDeleteDialog
                    open
                    onOpenChange={(open) => (open ? undefined : setDeletingProject(null))}
                    name={deletingProject.name}
                    requireTyping={false}
                    kind={t("history.projectKind")}
                    title={t("history.projectDeleteTitle")}
                    question={t("history.projectDeleteQuestion", { name: deletingProject.name })}
                    confirmLabel={t("history.deleteConfirm")}
                    onConfirm={() => {
                        void sidebar.deleteProject(deletingProject.id);
                        setDeletingProject(null);
                    }}
                />
            ) : null}
        </nav>
    );
}

function IconButton({
    label,
    onClick,
    children
}: {
    label: string;
    onClick: () => void;
    children: ReactNode;
}) {
    return (
        <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={label}
            title={label}
            onClick={onClick}
        >
            {children}
        </Button>
    );
}

/** A "shared with you" row: drawn like a chat's own row. */
const SHARED_ROW =
    "flex w-full min-w-0 items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-[0.8125rem] leading-5 text-muted-foreground transition-colors hover:bg-card-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

function NavRow({
    icon: Icon,
    onClick,
    children
}: {
    icon: ComponentType<{ className?: string }>;
    onClick: () => void;
    children: ReactNode;
}) {
    return (
        <button
            type="button"
            onClick={onClick}
            className="flex w-full min-w-0 items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-[0.8125rem] leading-5 text-muted-foreground transition-colors hover:bg-card-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
            <Icon className="size-4 shrink-0 text-foreground-subtle" />
            <span className="min-w-0 truncate">{children}</span>
        </button>
    );
}

function Section({ id, label, children }: { id: string; label: string; children: ReactNode }) {
    return (
        <div role="group" aria-labelledby={id} className="pt-4">
            <p id={id} className={cn("truncate px-2 pb-1", HEADING)}>
                {label}
            </p>
            {children}
        </div>
    );
}

/** The person's Code sessions, in the rows chats are drawn in, each marked as
 *  code. Hidden beside the chats until there is one; with Code on screen it
 *  says when there are none. */
function CodeSection({ code }: { code: PolarThreadsCode }) {
    const t = useTranslations("polar");
    const { rows, more, loadingMore, loadMore } = code.history;
    if (rows === null) return null;
    if (rows.length === 0 && !code.first) return null;
    return (
        <Section id="polar-code" label={t("code.history")}>
            {rows.length === 0 ? (
                <p className="px-2 py-1.5 text-[0.8125rem] leading-5 text-muted-foreground">
                    {t("code.empty")}
                </p>
            ) : (
                rows.map((row) => {
                    const active = row.id === code.activeId;
                    return (
                        <button
                            key={row.id}
                            type="button"
                            onClick={() => code.onOpen(row.id)}
                            aria-current={active ? "page" : undefined}
                            title={`${row.title} (${row.stateLabel}, ${row.repo || t("code.workspace")})`}
                            className={cn(
                                "flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-[0.8125rem] leading-5 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                                active
                                    ? "bg-primary/15 font-medium text-foreground"
                                    : "hover:bg-card-hover"
                            )}
                        >
                            <Code2
                                className="size-3.5 shrink-0 text-foreground-subtle"
                                aria-hidden
                            />
                            <span className="sr-only">{t("code.session")}</span>
                            <span className="min-w-0 flex-1 truncate">{row.title}</span>
                            <StateDot state={row.state} />
                            <span className="sr-only">{row.stateLabel}</span>
                        </button>
                    );
                })
            )}
            {more ? (
                <button
                    type="button"
                    onClick={loadMore}
                    disabled={loadingMore}
                    className="mt-1 w-full rounded-md px-2 py-1.5 text-left text-[0.8125rem] leading-5 text-muted-foreground hover:bg-card-hover hover:text-foreground disabled:opacity-50"
                >
                    {t("history.more")}
                </button>
            ) : null}
            <a
                href="/apps/agents/sessions"
                className="mt-1 flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-[0.8125rem] leading-5 text-muted-foreground hover:bg-card-hover hover:text-foreground"
            >
                <ExternalLink className="size-3.5 shrink-0 text-foreground-subtle" />
                <span className="min-w-0 truncate">{t("code.allSessions")}</span>
            </a>
        </Section>
    );
}

/** "Show more" under a list the server has another page of. */
function MoreButton({ sidebar, list }: { sidebar: PolarSidebar; list: string }) {
    const t = useTranslations("polar");
    if (!sidebar.hasMore(list)) return null;
    return (
        <button
            type="button"
            onClick={() => sidebar.loadMore(list)}
            disabled={sidebar.isLoading(list)}
            className="mt-1 w-full rounded-md px-2 py-1.5 text-left text-[0.8125rem] leading-5 text-muted-foreground hover:bg-card-hover hover:text-foreground disabled:opacity-50"
        >
            {t("history.more")}
        </button>
    );
}

/** A section's heading, as the app rail draws one (`AppSidebar`). */
const HEADING = "text-[0.6875rem] font-medium uppercase tracking-wider text-foreground-subtle";

/** The classes of the "..." and pin buttons: hidden until the row is hovered,
 *  focused or open, always there on a touch screen. */
const ROW_ACTION =
    "inline-flex size-6 shrink-0 [@media(pointer:coarse)]:size-11 items-center justify-center rounded text-muted-foreground opacity-0 transition-opacity duration-fast hover:bg-muted hover:text-foreground focus-visible:opacity-100 group-hover/row:opacity-100 group-focus-within/row:opacity-100 data-[state=open]:opacity-100 [@media(hover:none)]:opacity-100";

function ProjectItem({
    project,
    open,
    onToggle,
    onNew,
    onEdit,
    onDelete,
    children
}: {
    project: PolarProjectRow;
    open: boolean;
    onToggle: () => void;
    onNew: () => void;
    onEdit: () => void;
    onDelete: () => void;
    children: ReactNode;
}) {
    const t = useTranslations("polar");
    const chose = useRef(false);
    const Icon = open ? FolderOpen : Folder;
    return (
        <div>
            <div className="group/row flex min-w-0 items-center rounded-md hover:bg-card-hover">
                <button
                    type="button"
                    aria-expanded={open}
                    onClick={onToggle}
                    title={project.name}
                    className="flex min-w-0 flex-1 items-center gap-2.5 px-2 py-1.5 text-left text-[0.8125rem] leading-5 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none"
                >
                    <Icon className="size-4 shrink-0 text-foreground-subtle" />
                    <span className="min-w-0 truncate">{project.name}</span>
                </button>
                <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                        <button
                            type="button"
                            aria-label={t("history.projectOptions")}
                            title={t("history.projectOptions")}
                            className={cn(ROW_ACTION, "mr-1")}
                        >
                            <MoreHorizontal className="size-4" />
                        </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent
                        align="end"
                        onCloseAutoFocus={(event) => {
                            if (chose.current) keepFocusOnClose(event);
                            chose.current = false;
                        }}
                    >
                        <DropdownMenuItem onSelect={onNew}>
                            <SquarePen />
                            {t("history.projectNewChat", { name: project.name })}
                        </DropdownMenuItem>
                        <DropdownMenuItem
                            onSelect={() => {
                                chose.current = true;
                                onEdit();
                            }}
                        >
                            <Pencil />
                            {t("history.editProject")}
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                            variant="danger"
                            onSelect={() => {
                                chose.current = true;
                                onDelete();
                            }}
                        >
                            <Trash2 />
                            {t("history.projectDelete")}
                        </DropdownMenuItem>
                    </DropdownMenuContent>
                </DropdownMenu>
            </div>
            {open ? <div className="pl-4">{children}</div> : null}
        </div>
    );
}

/** A chat's run as a mark beside its name; nothing for one at rest. */
function RunMark({ run, active }: { run: PolarRunView | null; active: boolean }) {
    const t = useTranslations("polar");
    if (!run) return null;
    const label =
        run.state === "running"
            ? t("history.running")
            : run.state === "approval"
              ? t("history.waiting")
              : // The open chat is being read: an unread mark there says nothing.
                run.unread && !active
                ? t("history.unread")
                : null;
    if (!label) return null;
    return (
        <span
            role="img"
            aria-label={label}
            title={label}
            className="flex shrink-0 items-center px-1"
        >
            {run.state === "running" ? (
                <Loader2 aria-hidden className="size-3.5 text-primary motion-safe:animate-spin" />
            ) : (
                <span
                    aria-hidden
                    className={cn(
                        "size-2 rounded-full",
                        run.state === "approval"
                            ? "bg-warning"
                            : run.state === "failed"
                              ? "bg-danger"
                              : "bg-primary"
                    )}
                />
            )}
        </span>
    );
}

function ThreadItem({
    row,
    active,
    run,
    actions
}: {
    row: PolarThreadRow;
    active: boolean;
    run: PolarRunView | null;
    actions: RowActions;
}) {
    const t = useTranslations("polar");
    const [renaming, setRenaming] = useState(false);
    const [draft, setDraft] = useState(row.title);
    // Whether the menu closed because an option was taken: then the focus goes
    // to what the option opened, not back to the "..." button.
    const chose = useRef(false);
    const field = useDeferredFocus<HTMLInputElement>(renaming);
    const pinned = row.pinnedAt !== null;
    const PinIcon = pinned ? PinOff : Pin;
    const pinLabel = t(pinned ? "history.unpin" : "history.pin");
    const take = (action: () => void) => () => {
        chose.current = true;
        action();
    };

    const finish = (save: boolean) => {
        setRenaming(false);
        if (!save) return;
        const title = polarShared.threadTitleSchema.safeParse(draft);
        if (title.success && title.data !== row.title) actions.onRename(row, title.data);
    };

    return (
        <div
            className={cn(
                "group/row flex min-w-0 items-center rounded-md",
                active ? "bg-primary/15" : "hover:bg-card-hover focus-within:bg-card-hover"
            )}
        >
            {renaming ? (
                <Input
                    ref={field}
                    value={draft}
                    maxLength={polarShared.POLAR_TITLE_MAX}
                    aria-label={t("history.name")}
                    onChange={(event) => setDraft(event.target.value)}
                    onBlur={() => finish(true)}
                    onKeyDown={(event) => {
                        if (event.key === "Enter") {
                            event.preventDefault();
                            finish(true);
                        } else if (event.key === "Escape") {
                            event.preventDefault();
                            event.stopPropagation();
                            finish(false);
                        }
                    }}
                    className="h-8 min-w-0 flex-1"
                />
            ) : (
                <button
                    type="button"
                    onClick={() => actions.onOpen(row)}
                    aria-current={active ? "page" : undefined}
                    title={row.title}
                    className={cn(
                        "min-w-0 flex-1 truncate px-2 py-1.5 text-left text-[0.8125rem] leading-5 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none",
                        active && "font-medium text-foreground"
                    )}
                >
                    {row.title}
                </button>
            )}
            {renaming ? null : <RunMark run={run} active={active} />}
            {renaming ? null : (
                <span className="mr-1 flex shrink-0 items-center">
                    <button
                        type="button"
                        aria-label={pinLabel}
                        title={pinLabel}
                        aria-pressed={pinned}
                        onClick={() => actions.onPin(row, !pinned)}
                        className={cn(ROW_ACTION, active && "opacity-100")}
                    >
                        <PinIcon className="size-3.5" />
                    </button>
                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <button
                                type="button"
                                aria-label={t("history.options")}
                                title={t("history.options")}
                                className={cn(ROW_ACTION, active && "opacity-100")}
                            >
                                <MoreHorizontal className="size-4" />
                            </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent
                            align="end"
                            onCloseAutoFocus={(event) => {
                                if (chose.current) keepFocusOnClose(event);
                                chose.current = false;
                            }}
                        >
                            <DropdownMenuItem
                                onSelect={take(() => {
                                    setDraft(row.title);
                                    setRenaming(true);
                                })}
                            >
                                <Pencil />
                                {t("history.rename")}
                            </DropdownMenuItem>
                            <DropdownMenuItem onSelect={() => actions.onPin(row, !pinned)}>
                                <PinIcon />
                                {pinLabel}
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem onSelect={take(() => actions.onShare(row))}>
                                <Share2 />
                                {t("history.share")}
                            </DropdownMenuItem>
                            <DropdownMenuItem asChild>
                                <a
                                    href={`/api/polar/threads/${row.id}/export?format=markdown`}
                                    download
                                >
                                    <FileDown />
                                    {t("export.markdown")}
                                </a>
                            </DropdownMenuItem>
                            <DropdownMenuItem asChild>
                                <a
                                    href={`/api/polar/threads/${row.id}/export?format=json`}
                                    download
                                >
                                    <FileJson />
                                    {t("export.json")}
                                </a>
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem onSelect={() => actions.onArchive(row)}>
                                <Archive />
                                {t("history.archive")}
                            </DropdownMenuItem>
                            <DropdownMenuItem
                                variant="danger"
                                onSelect={take(() => actions.onDelete(row))}
                            >
                                <Trash2 />
                                {t("history.delete")}
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuSub>
                                <DropdownMenuSubTrigger>
                                    <FolderInput />
                                    {t("history.move")}
                                </DropdownMenuSubTrigger>
                                <DropdownMenuSubContent className="max-h-[min(20rem,var(--radix-dropdown-menu-content-available-height))] overflow-y-auto overscroll-contain">
                                    {actions.projects.map((project) => (
                                        <DropdownMenuItem
                                            key={project.id}
                                            disabled={project.id === row.projectId}
                                            onSelect={() => actions.onMove(row, project.id)}
                                        >
                                            <Folder />
                                            <span className="min-w-0 truncate" title={project.name}>
                                                {project.name}
                                            </span>
                                        </DropdownMenuItem>
                                    ))}
                                    <DropdownMenuItem
                                        onSelect={take(() => actions.onMoveToNew(row))}
                                    >
                                        <FolderPlus />
                                        {t("history.newProject")}
                                    </DropdownMenuItem>
                                    {row.projectId ? (
                                        <>
                                            <DropdownMenuSeparator />
                                            <DropdownMenuItem
                                                onSelect={() => actions.onMove(row, null)}
                                            >
                                                <FolderMinus />
                                                {t("history.removeFromProject")}
                                            </DropdownMenuItem>
                                        </>
                                    ) : null}
                                </DropdownMenuSubContent>
                            </DropdownMenuSub>
                        </DropdownMenuContent>
                    </DropdownMenu>
                </span>
            )}
        </div>
    );
}

/**
 * Search over every chat's title and message text, on the server, twenty at a
 * time. With nothing typed it offers the archived chats, which is where an
 * archived chat is found again and restored.
 */
function SearchDialog({
    sidebar,
    onClose,
    onOpen
}: {
    sidebar: PolarSidebar;
    onClose: () => void;
    onOpen: (row: PolarThreadRow) => void;
}) {
    const t = useTranslations("polar");
    const [text, setText] = useState("");
    const [archived, setArchived] = useState(false);
    const [results, setResults] = useState<PolarThreadRow[] | null>(null);
    const [more, setMore] = useState(false);
    const [page, setPage] = useState(0);
    const [failed, setFailed] = useState(false);
    /** The last archived chat the server sent: the next page starts after it. */
    const archivedCursor = useRef<string | null>(null);
    const query = polarShared.searchTextSchema.safeParse(text);
    const words = query.success ? query.data : "";

    useEffect(() => {
        if (!archived && !words) {
            setResults(null);
            return;
        }
        const controller = new AbortController();
        const timer = window.setTimeout(
            () => {
                const after = page > 0 ? archivedCursor.current : null;
                const url = archived
                    ? `/api/polar/threads?view=archived${after ? `&cursor=${encodeURIComponent(after)}` : ""}`
                    : `/api/polar/search?q=${encodeURIComponent(words)}&page=${page}`;
                setFailed(false);
                fetch(url, { signal: controller.signal })
                    .then((response) => (response.ok ? response.json() : Promise.reject()))
                    .then(
                        (data: {
                            threads?: PolarThreadRow[];
                            results?: PolarThreadRow[];
                            more?: boolean;
                        }) => {
                            const found = data.results ?? data.threads ?? [];
                            if (archived)
                                archivedCursor.current = found.at(-1)?.id ?? archivedCursor.current;
                            setResults((current) =>
                                page > 0 ? [...(current ?? []), ...found] : found
                            );
                            setMore(Boolean(data.more));
                        }
                    )
                    .catch(() => {
                        if (!controller.signal.aborted) setFailed(true);
                    });
            },
            archived ? 0 : 250
        );
        return () => {
            controller.abort();
            window.clearTimeout(timer);
        };
    }, [archived, words, page]);

    const restore = (row: PolarThreadRow) => {
        sidebar.know(row);
        setResults((current) => current?.filter((entry) => entry.id !== row.id) ?? null);
        void sidebar.setArchived(row.id, false);
    };

    return (
        <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
            <DialogContent className="flex max-h-[min(36rem,85dvh)] max-w-lg flex-col gap-3">
                <DialogHeader>
                    <DialogTitle>{t(archived ? "history.archived" : "history.search")}</DialogTitle>
                    <DialogDescription className={archived ? "sr-only" : undefined}>
                        {t("history.searchHint")}
                    </DialogDescription>
                </DialogHeader>
                {archived ? null : (
                    <Input
                        autoFocus
                        type="search"
                        value={text}
                        aria-label={t("history.searchLabel")}
                        placeholder={t("history.search")}
                        onChange={(event) => {
                            setText(event.target.value);
                            setPage(0);
                        }}
                    />
                )}
                <div className="-mx-2 min-h-0 flex-1 overflow-y-auto overscroll-contain">
                    {failed ? (
                        <p className="px-2 py-1.5 text-sm text-danger">
                            {t("history.searchFailed")}
                        </p>
                    ) : results === null ? null : results.length === 0 ? (
                        <p className="px-2 py-1.5 text-sm text-muted-foreground">
                            {t(archived ? "history.archivedEmpty" : "history.searchEmpty")}
                        </p>
                    ) : (
                        <ul>
                            {results.map((row) => (
                                <li
                                    key={row.id}
                                    className="group/row flex min-w-0 items-center gap-1 rounded-md hover:bg-card-hover"
                                >
                                    <button
                                        type="button"
                                        title={row.title}
                                        onClick={() => onOpen(row)}
                                        className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left text-sm text-foreground"
                                    >
                                        <span className="min-w-0 truncate">{row.title}</span>
                                        {row.archivedAt && !archived ? (
                                            <span className="shrink-0 rounded bg-muted px-1.5 text-xs text-muted-foreground">
                                                {t("history.archivedBadge")}
                                            </span>
                                        ) : null}
                                    </button>
                                    {row.archivedAt ? (
                                        <IconButton
                                            label={t("history.unarchive")}
                                            onClick={() => restore(row)}
                                        >
                                            <ArchiveRestore className="size-4" />
                                        </IconButton>
                                    ) : null}
                                </li>
                            ))}
                        </ul>
                    )}
                    {more ? (
                        <button
                            type="button"
                            onClick={() => setPage(page + 1)}
                            className="mt-1 w-full rounded-md px-2 py-1.5 text-left text-sm text-muted-foreground hover:bg-card-hover hover:text-foreground"
                        >
                            {t("history.more")}
                        </button>
                    ) : null}
                </div>
                <DialogFooter>
                    <Button
                        type="button"
                        variant="ghost"
                        onClick={() => {
                            setArchived(!archived);
                            setResults(null);
                            setPage(0);
                        }}
                    >
                        {archived ? <Search className="size-4" /> : <Archive className="size-4" />}
                        {t(archived ? "history.search" : "history.archived")}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

/** A new project, or an existing one's name and instructions. */
function ProjectDialog({
    project,
    onClose,
    onSave
}: {
    project: PolarProjectRow | null;
    onClose: () => void;
    onSave: (input: { name: string; instructions: string }) => Promise<boolean>;
}) {
    const t = useTranslations("polar");
    const [name, setName] = useState(project?.name ?? "");
    const [instructions, setInstructions] = useState(project?.instructions ?? "");
    const [saving, setSaving] = useState(false);
    const parsedName = polarShared.projectNameSchema.safeParse(name);
    const parsedInstructions = polarShared.projectInstructionsSchema.safeParse(instructions);
    const unchanged =
        project !== null &&
        parsedName.success &&
        parsedName.data === project.name &&
        parsedInstructions.success &&
        parsedInstructions.data === project.instructions;
    const ready = parsedName.success && parsedInstructions.success && !unchanged && !saving;

    const submit = async () => {
        if (!ready || !parsedName.success || !parsedInstructions.success) return;
        setSaving(true);
        const saved = await onSave({
            name: parsedName.data,
            instructions: parsedInstructions.data
        });
        setSaving(false);
        if (saved) onClose();
    };

    return (
        <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
            <DialogContent className="max-w-lg">
                <form
                    className="flex flex-col gap-4"
                    onSubmit={(event) => {
                        event.preventDefault();
                        void submit();
                    }}
                >
                    <DialogHeader>
                        <DialogTitle>
                            {t(project ? "history.editProject" : "history.newProject")}
                        </DialogTitle>
                        <DialogDescription>{t("history.projectHint")}</DialogDescription>
                    </DialogHeader>
                    <div className="space-y-1">
                        <label
                            htmlFor="polar-project-name"
                            className="text-xs text-muted-foreground"
                        >
                            {t("history.projectName")} *
                        </label>
                        <Input
                            id="polar-project-name"
                            autoFocus
                            required
                            value={name}
                            maxLength={polarShared.POLAR_PROJECT_NAME_MAX}
                            onChange={(event) => setName(event.target.value)}
                        />
                    </div>
                    <div className="space-y-1">
                        <label
                            htmlFor="polar-project-instructions"
                            className="text-xs text-muted-foreground"
                        >
                            {t("history.projectInstructions")}
                        </label>
                        <Textarea
                            id="polar-project-instructions"
                            rows={6}
                            value={instructions}
                            maxLength={polarShared.POLAR_PROJECT_INSTRUCTIONS_MAX}
                            onChange={(event) => setInstructions(event.target.value)}
                        />
                    </div>
                    <DialogFooter>
                        <Button type="button" variant="ghost" onClick={onClose}>
                            {t("history.cancel")}
                        </Button>
                        <Button type="submit" aria-disabled={!ready} disabled={saving}>
                            {t(project ? "history.projectSave" : "history.projectCreate")}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
