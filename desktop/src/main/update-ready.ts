/**
 * The update waiting for a restart, held for the pages that offer it. Pure, for
 * the tests: `index.ts` feeds it what `updates.ts` finds and hands each change
 * to the Polaris windows; `ipc.ts` answers the page's questions from it.
 *
 * Only an update with a way to restart into it is held - one that is installed
 * already. An update that can only be downloaded from its page is the menu's and
 * the notice's to offer, not a button that would have to open a browser.
 *
 * The page's version and this app's are independent - one app opens Polaris
 * servers of any version - so a page says it draws the button (it listens with
 * `onUpdateReady`), and only then is the app's own notice left out. A page that
 * never says so, an older dashboard, gets the notice and the tray as before.
 */

import type { Outcome } from "@/shared/bridge";
import { readUpdateReady, type UpdateReady } from "@/shared/update-ready";

export interface FoundUpdate {
    readonly version: string;
    readonly restart?: () => void;
}

export class UpdateReadyState {
    private ready: { readonly state: NonNullable<UpdateReady>; readonly restart: () => void; } | null = null;
    private installing = false;
    /** The pages, by their web contents, that draw the button now. */
    private readonly offering = new Set<number>();

    constructor(private readonly changed: (state: UpdateReady) => void) {}

    /**
     * What `updates.ts` found. Tells the pages only when what they show changes.
     * A newer release that could only be downloaded from its page leaves an
     * installed one in place: that one still opens on a restart.
     */
    found(update: FoundUpdate): void {
        const state = readUpdateReady({ version: update.version });
        if (!update.restart || !state) return;
        if (state.version === this.ready?.state.version && update.restart === this.ready.restart) return;
        this.ready = { state, restart: update.restart };
        this.installing = false;
        this.changed(this.current());
    }

    /** A page saying it draws the button, or that it stopped. */
    offer(page: number, on: boolean): void {
        if (on) this.offering.add(page);
        else this.offering.delete(page);
    }

    /** Whether this page draws the button: the app's notice is then not needed. */
    offeredBy(page: number | null): boolean {
        return page !== null && this.offering.has(page);
    }

    /** Whether the app announces this update with a notice of its own: always
     *  for one that can only be downloaded, and for an installed one unless the
     *  page in front draws the button. */
    needsNotice(update: FoundUpdate, front: number | null): boolean {
        return !update.restart || !this.offeredBy(front);
    }

    current(): UpdateReady {
        return this.ready ? this.ready.state : null;
    }

    /** Restart into the waiting update, once however often it is asked. */
    install(): Outcome {
        if (!this.ready) return { ok: false, error: "There is no update waiting to be installed." };
        if (this.installing) return { ok: true };
        this.installing = true;
        try {
            this.ready.restart();
            return { ok: true };
        } catch (caught) {
            this.installing = false;
            console.error("[update]", caught);
            return { ok: false, error: "The update could not be installed. Polaris installs it the next time it starts." };
        }
    }
}
