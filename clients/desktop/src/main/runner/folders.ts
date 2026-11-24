/**
 * The folders on this computer a `path` session may work in: only ones the
 * person chose in the native folder dialog, kept encrypted with `safeStorage`
 * in `<userData>/runner-folders.bin`, per Polaris server, beside the runner's
 * credential. A session asking for any other folder is refused
 * (`launch.planWorkspace`).
 *
 * The storage is injected so the list's rules are tested without Electron.
 */

import { z } from "zod";
import { isAbsolute, normalize } from "node:path";

/** Most folders kept per server. */
export const FOLDERS_MOST = 20;

const storedSchema = z.record(z.string().max(500), z.array(z.string().min(1).max(1000)).max(FOLDERS_MOST));
export type StoredFolders = z.infer<typeof storedSchema>;

export interface FolderStore {
    readonly read: () => Promise<string | null>;
    readonly write: (json: string) => Promise<void>;
}

/** Read what is stored; anything unreadable is an empty list, never an error. */
export function parseFolders(json: string | null): StoredFolders {
    if (!json) return {};
    try {
        const parsed = storedSchema.safeParse(JSON.parse(json));
        return parsed.success ? parsed.data : {};
    } catch {
        return {};
    }
}

/** `folder` added to `list`: absolute, normalised, once, newest first, at most
 *  `FOLDERS_MOST`. A relative path is not added. Pure. */
export function addFolder(list: readonly string[], folder: string): string[] {
    if (!isAbsolute(folder) || folder.length > 1000) return [...list];
    const clean = normalize(folder);
    return [clean, ...list.filter((entry) => entry !== clean)].slice(0, FOLDERS_MOST);
}

export function removeFolder(list: readonly string[], folder: string): string[] {
    const clean = normalize(folder);
    return list.filter((entry) => entry !== clean);
}

export class Folders {
    #all: StoredFolders = {};
    #loaded: Promise<void> | null = null;

    constructor(private readonly store: FolderStore) {}

    load(): Promise<void> {
        this.#loaded ??= this.store
            .read()
            .then((json) => void (this.#all = parseFolders(json)))
            .catch(() => undefined);
        return this.#loaded;
    }

    /** What a session for `server` may use now, without waiting. */
    list(server: string | null): readonly string[] {
        return server ? (this.#all[server] ?? []) : [];
    }

    async add(server: string, folder: string): Promise<readonly string[]> {
        await this.load();
        const next = addFolder(this.list(server), folder);
        this.#all = { ...this.#all, [server]: next };
        await this.store.write(JSON.stringify(this.#all));
        return next;
    }

    async remove(server: string, folder: string): Promise<readonly string[]> {
        await this.load();
        const next = removeFolder(this.list(server), folder);
        this.#all = { ...this.#all, [server]: next };
        await this.store.write(JSON.stringify(this.#all));
        return next;
    }
}
