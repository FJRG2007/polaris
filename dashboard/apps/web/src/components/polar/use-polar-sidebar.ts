"use client";

/**
 * The state behind Polar's sidebar: every conversation row the screen has
 * loaded (recents, pinned, the chats of each opened project) in one list, the
 * projects, and the menu's actions. Sections are derived from the rows by
 * `threadSections`, so pinning a chat moves it from Recents to Pinned the
 * moment it is chosen.
 *
 * Every action is optimistic: the row changes at once and goes back, with a
 * toast, when the server refuses.
 */

import { useToast } from "@polaris/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "@/components/i18n/i18n-provider";
import {
    POLAR_THREAD_PAGE,
    threadPlace,
    type PolarProjectRow,
    type PolarThreadRow
} from "@/lib/polar/shared";

const CACHE_KEY = "polar.sidebar.v2";
const PROJECT_LIST = "project:";

/** The key of a project's list for `loadMore` and `hasMore`. */
export function projectList(id: string): string {
    return `${PROJECT_LIST}${id}`;
}

type SidebarCache = { rows: PolarThreadRow[]; projects: PolarProjectRow[] };

/** Fresh rows over the known ones: a row the server sent wins, the rest stay. */
export function mergeRows(
    current: readonly PolarThreadRow[] | null,
    fresh: readonly PolarThreadRow[]
): PolarThreadRow[] {
    const ids = new Set(fresh.map((row) => row.id));
    return [...fresh, ...(current ?? []).filter((row) => !ids.has(row.id))];
}

/** Puts a key in a set held in state, or takes it out. */
function setFlag(
    set: (update: (current: ReadonlySet<string>) => ReadonlySet<string>) => void,
    key: string,
    on: boolean
): void {
    set((current) => {
        if (current.has(key) === on) return current;
        const next = new Set(current);
        if (on) next.add(key);
        else next.delete(key);
        return next;
    });
}

async function send(url: string, method: string, body?: unknown): Promise<Response | null> {
    return fetch(url, {
        method,
        ...(body === undefined
            ? {}
            : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
    }).catch(() => null);
}

export type PolarSidebar = ReturnType<typeof usePolarSidebar>;

export function usePolarSidebar({
    enabled,
    onRemoved
}: {
    /** Whether the list is on screen; it is read the first time it is. */
    enabled: boolean;
    /** A conversation was deleted (the open one has to be replaced). */
    onRemoved: (id: string) => void;
}) {
    const t = useTranslations("polar");
    const toast = useToast();
    const [rows, setRows] = useState<PolarThreadRow[] | null>(null);
    const [projects, setProjects] = useState<PolarProjectRow[] | null>(null);
    /** Lists with another page on the server, and the ones being read. */
    const [more, setMore] = useState<ReadonlySet<string>>(new Set());
    const [loading, setLoading] = useState<ReadonlySet<string>>(new Set());
    /** Projects whose chats are shown, and whether each has been read. */
    const [openProjects, setOpenProjects] = useState<ReadonlySet<string>>(new Set());
    const openProjectsRef = useRef(openProjects);
    openProjectsRef.current = openProjects;
    const loadedProjects = useRef(new Set<string>());
    /** The ids each list's pages brought, in the server's order: the next
     *  page starts after the last of them still in that list. */
    const received = useRef(new Map<string, string[]>());
    const rowsRef = useRef(rows);
    rowsRef.current = rows;

    /** Records a page a list read: the first page starts the list over. */
    const tookPage = useCallback(
        (key: string, page: PolarThreadRow[], hasMore: boolean, first: boolean) => {
            const ids = page.map((row) => row.id);
            received.current.set(key, first ? ids : [...(received.current.get(key) ?? []), ...ids]);
            setFlag(setMore, key, hasMore);
        },
        []
    );

    /** Reads a project's first page; `track` false only merges its rows, for a
     *  refresh that keeps the pages already read. */
    const loadProject = useCallback(
        (id: string, track = true) => {
            loadedProjects.current.add(id);
            void fetch(`/api/polar/threads?view=project&project=${encodeURIComponent(id)}`)
                .then((response) => (response.ok ? response.json() : null))
                .then((data: { threads: PolarThreadRow[]; more?: boolean } | null) => {
                    if (!data) return;
                    setRows((current) => mergeRows(current, data.threads));
                    if (track) tookPage(projectList(id), data.threads, Boolean(data.more), true);
                })
                .catch(() => undefined);
        },
        [tookPage]
    );

    // Last known sidebar instantly, refreshed behind it. `keep` leaves the rows
    // already loaded (pages read with "Show more", opened projects) in place.
    const refresh = useCallback(
        (keep = false) => {
            if (!keep) {
                try {
                    const cached = window.sessionStorage.getItem(CACHE_KEY);
                    if (cached) {
                        const parsed = JSON.parse(cached) as SidebarCache;
                        setRows(parsed.rows);
                        setProjects(parsed.projects);
                    }
                } catch {
                    // No cache.
                }
            }
            fetch("/api/polar/threads")
                .then((response) => (response.ok ? response.json() : null))
                .then(
                    (
                        data: {
                            threads: PolarThreadRow[];
                            more?: boolean;
                            pinned?: PolarThreadRow[];
                            morePinned?: boolean;
                            projects?: PolarProjectRow[];
                        } | null
                    ) => {
                        if (!data) return;
                        const pinned = data.pinned ?? [];
                        const fresh = [...pinned, ...data.threads];
                        setRows((current) => (keep ? mergeRows(current, fresh) : fresh));
                        setProjects(data.projects ?? []);
                        if (keep) return;
                        tookPage("recent", data.threads, Boolean(data.more), true);
                        tookPage("pinned", pinned, Boolean(data.morePinned), true);
                        // The rows were replaced: the open projects are read again.
                        loadedProjects.current.clear();
                        for (const id of openProjectsRef.current) loadProject(id);
                    }
                )
                .catch(() => undefined);
            if (keep) for (const id of loadedProjects.current) loadProject(id, false);
        },
        [loadProject, tookPage]
    );

    useEffect(() => {
        if (enabled) refresh();
    }, [enabled, refresh]);

    // The cache follows every change.
    useEffect(() => {
        if (!rows || !projects) return;
        try {
            const cache: SidebarCache = { rows: rows.slice(0, POLAR_THREAD_PAGE * 2), projects };
            window.sessionStorage.setItem(CACHE_KEY, JSON.stringify(cache));
        } catch {
            // No cache.
        }
    }, [rows, projects]);

    /** The next page of one list: "recent", "pinned" or a project's. */
    const loadMore = (key: string) => {
        if (loading.has(key)) return;
        const known = new Map((rowsRef.current ?? []).map((row) => [row.id, row]));
        const ids = [...(received.current.get(key) ?? [])].reverse();
        const inList = (row: PolarThreadRow) =>
            !row.archivedAt &&
            (key === "recent"
                ? threadPlace(row) === "recent"
                : key === "pinned"
                  ? Boolean(row.pinnedAt)
                  : projectList(row.projectId ?? "") === key);
        const cursor =
            ids.find((id) => {
                const row = known.get(id);
                return row !== undefined && inList(row);
            }) ?? ids.find((id) => known.has(id));
        if (!cursor) return;
        const project = key.startsWith(PROJECT_LIST) ? key.slice(PROJECT_LIST.length) : null;
        const view = project
            ? `view=project&project=${encodeURIComponent(project)}`
            : `view=${key}`;
        setFlag(setLoading, key, true);
        fetch(`/api/polar/threads?${view}&cursor=${encodeURIComponent(cursor)}`)
            .then((response) => (response.ok ? response.json() : null))
            .then((data: { threads: PolarThreadRow[]; more?: boolean } | null) => {
                if (!data) return;
                setRows((current) => mergeRows(current, data.threads));
                tookPage(key, data.threads, Boolean(data.more), false);
            })
            .catch(() => undefined)
            .finally(() => setFlag(setLoading, key, false));
    };

    /** A row's fields set at once, and only those fields put back on failure. */
    const patch = async (
        id: string,
        change: Partial<PolarThreadRow>,
        body: Record<string, unknown>,
        failure: string
    ): Promise<boolean> => {
        const before = rowsRef.current?.find((row) => row.id === id);
        const restore = before
            ? (Object.fromEntries(
                  Object.keys(change).map((key) => [key, before[key as keyof PolarThreadRow]])
              ) as Partial<PolarThreadRow>)
            : null;
        setRows(
            (current) =>
                current?.map((row) => (row.id === id ? { ...row, ...change } : row)) ?? null
        );
        const response = await send(`/api/polar/threads/${id}`, "PATCH", body);
        if (response?.ok) return true;
        if (restore) {
            setRows(
                (current) =>
                    current?.map((row) => (row.id === id ? { ...row, ...restore } : row)) ?? null
            );
        }
        toast.show({ title: failure });
        return false;
    };

    const now = () => new Date().toISOString();

    /** Adds a row the screen did not have yet (an archived one opened from the
     *  search, a chat just made), or updates the one it has. */
    const know = useCallback((row: PolarThreadRow) => {
        setRows((current) => mergeRows(current, [row]));
    }, []);

    /** The model named a new thread: its placeholder is swapped in place. */
    const retitle = useCallback((id: string, title: string) => {
        setRows(
            (current) =>
                current?.map((row) =>
                    row.id === id && row.title !== title ? { ...row, title } : row
                ) ?? null
        );
    }, []);

    const remove = async (id: string) => {
        const before = rowsRef.current?.find((row) => row.id === id);
        setRows((current) => current?.filter((row) => row.id !== id) ?? null);
        const response = await send(`/api/polar/threads/${id}`, "DELETE");
        if (!response?.ok) {
            if (before) setRows((current) => mergeRows(current, [before]));
            toast.show({ title: t("history.deleteFailed") });
            return;
        }
        onRemoved(id);
    };

    /** Shows a project's chats, read the first time. */
    const openProject = (id: string) => {
        setOpenProjects((current) => (current.has(id) ? current : new Set(current).add(id)));
        if (!loadedProjects.current.has(id)) loadProject(id);
    };

    const toggleProject = (id: string) => {
        setOpenProjects((current) => {
            const next = new Set(current);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
        if (!loadedProjects.current.has(id)) loadProject(id);
    };

    const createProject = async (input: {
        name: string;
        instructions: string;
    }): Promise<PolarProjectRow | null> => {
        const response = await send("/api/polar/projects", "POST", input);
        if (!response?.ok) {
            toast.show({
                title: t(
                    response?.status === 409 ? "history.projectTooMany" : "history.projectFailed"
                )
            });
            return null;
        }
        const { project } = (await response.json()) as { project: PolarProjectRow };
        setProjects((current) => [project, ...(current ?? [])]);
        loadedProjects.current.add(project.id);
        setOpenProjects((current) => new Set(current).add(project.id));
        return project;
    };

    const updateProject = async (
        id: string,
        input: { name: string; instructions: string }
    ): Promise<boolean> => {
        const before = projects?.find((project) => project.id === id);
        setProjects(
            (current) =>
                current?.map((project) =>
                    project.id === id ? { ...project, ...input } : project
                ) ?? null
        );
        const response = await send(`/api/polar/projects/${id}`, "PATCH", input);
        if (response?.ok) return true;
        if (before) {
            setProjects(
                (current) =>
                    current?.map((project) => (project.id === id ? before : project)) ?? null
            );
        }
        toast.show({ title: t("history.projectFailed") });
        return false;
    };

    const deleteProject = async (id: string) => {
        const before = projects;
        const filed = (rowsRef.current ?? []).filter((row) => row.projectId === id);
        setProjects((current) => current?.filter((project) => project.id !== id) ?? null);
        // Its chats are kept, and go back to Recents.
        setRows(
            (current) =>
                current?.map((row) => (row.projectId === id ? { ...row, projectId: null } : row)) ??
                null
        );
        const response = await send(`/api/polar/projects/${id}`, "DELETE");
        if (response?.ok) return;
        setProjects(before);
        setRows((current) => mergeRows(current, filed));
        toast.show({ title: t("history.projectFailed") });
    };

    return {
        rows,
        projects,
        hasMore: (key: string) => more.has(key),
        isLoading: (key: string) => loading.has(key),
        openProjects,
        refresh,
        loadMore,
        know,
        retitle,
        remove,
        toggleProject,
        openProject,
        createProject,
        updateProject,
        deleteProject,
        rename: (id: string, title: string) =>
            patch(id, { title }, { title }, t("history.renameFailed")),
        setPinned: (id: string, pinned: boolean) =>
            patch(id, { pinnedAt: pinned ? now() : null }, { pinned }, t("history.actionFailed")),
        setArchived: (id: string, archived: boolean) =>
            patch(
                id,
                archived ? { archivedAt: now(), pinnedAt: null } : { archivedAt: null },
                { archived },
                t("history.actionFailed")
            ),
        move: (id: string, projectId: string | null) =>
            patch(id, { projectId }, { projectId }, t("history.actionFailed"))
    };
}
