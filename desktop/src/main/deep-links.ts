/**
 * What becomes of a polaris:// link once it reaches this app. Free of Electron,
 * for the tests: `index.ts` hands it the steps that touch windows and settings.
 *
 * A link that arrives before the app has opened waits for that moment; after it,
 * a link opens straight away, whatever windows happen to be open: macOS keeps the
 * app running with none. Going to another Polaris takes a yes from whoever is at
 * the computer, since any website can start a link and switching closes every
 * window of the one in use.
 */

import type { DeepLink } from "@/shared/deep-link";

export type DeepLinkRoute = "here" | "switch" | "browser";

/** Where a link goes: the Polaris open here, another one kept here, or the browser
 *  for one this app does not know. */
export function deepLinkRoute(link: DeepLink, current: string | null, saved: readonly string[]): DeepLinkRoute {
    if (link.server === current) return "here";
    return saved.includes(link.server) ? "switch" : "browser";
}

export interface DeepLinkSteps {
    readonly current: () => string | null;
    readonly saved: () => readonly string[];
    /** Bring the app to the front, at a page of the Polaris in use when one is given. */
    readonly show: (path?: string) => void;
    readonly confirmSwitch: (server: string) => Promise<boolean>;
    /** Go to a kept server; false when that failed, which the step has already said. */
    readonly switchTo: (server: string) => Promise<boolean>;
    readonly openInBrowser: (url: string) => void;
}

export class DeepLinks {
    #waiting: DeepLink | null;
    #opened = false;
    #asking = false;

    constructor(
        private readonly steps: DeepLinkSteps,
        startedFor: DeepLink | null
    ) {
        this.#waiting = startedFor;
    }

    /** A link has reached the app. The newest one wins while the app is opening. */
    arrive(link: DeepLink): void {
        if (this.#opened) void this.#open(link);
        else this.#waiting = link;
    }

    /** The app is past its start: the link that waited opens, and later ones will. */
    opened(): void {
        this.#opened = true;
        const link = this.#waiting;
        this.#waiting = null;
        if (link) void this.#open(link);
    }

    /** Everything up to the question happens at once, so a caller sees its window. */
    async #open(link: DeepLink): Promise<void> {
        const route = deepLinkRoute(link, this.steps.current(), this.steps.saved());
        if (route === "browser") {
            this.steps.openInBrowser(`${link.server}${link.path}`);
            return;
        }
        if (route === "here") {
            this.steps.show(link.path);
            return;
        }
        this.steps.show();
        if (this.#asking) return;
        this.#asking = true;
        try {
            if (!(await this.steps.confirmSwitch(link.server))) return;
        } finally {
            this.#asking = false;
        }
        if (await this.steps.switchTo(link.server)) this.steps.show(link.path);
    }
}
