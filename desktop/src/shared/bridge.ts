/**
 * The two bridges this app puts into its pages, and the channels behind them.
 *
 * `window.polarisDesktop` is what the dashboard sees when it runs inside this
 * app (its detection is `dashboard/apps/web/src/lib/desktop-bridge.ts`, which
 * keeps its own copy of this shape - the two projects share no code). Everything
 * on it is a request the main process checks again: the page is the dashboard,
 * but the dashboard renders text other people wrote.
 *
 * `window.polarisLocal` is for the few pages this app draws itself - the first
 * run's address form, the API key form and the push window.
 *
 * Failures come back as values rather than as thrown errors: an error thrown
 * across IPC arrives wrapped in "Error invoking remote method", which is not a
 * sentence anybody should be shown.
 */

export type Outcome = { readonly ok: true } | { readonly ok: false; readonly error: string };

export interface NoticeInput {
    readonly title: string;
    readonly body?: string;
    /** Notices sharing a tag replace each other. */
    readonly tag: string;
    /** A path on the Polaris to open when the notice is pressed. */
    readonly href?: string;
    /** Stays until it is dealt with, where the system allows it. */
    readonly insistent?: boolean;
}

export type PickedFolder =
    | { readonly ok: true; readonly name: string; readonly files: number; readonly zip: Uint8Array }
    | { readonly ok: false; readonly error: string }
    | null;

export interface PolarisDesktop {
    /** This app's version. */
    readonly version: string;
    readonly platform: string;
    /** Show a notice drawn by the operating system. Resolves false when it cannot. */
    notify(input: NoticeInput): Promise<boolean>;
    /** Take back the notice with this tag. */
    closeNotice(tag: string): Promise<void>;
    /** A folder picked with the system's own dialog, zipped for "Upload a folder".
     *  Null when the dialog was dismissed. */
    pickFolder(): Promise<PickedFolder>;
    /** Build a service here with this computer's Docker and deploy the image. */
    pushLocal(input: {
        readonly serviceId: string;
        readonly name: string;
        readonly href?: string;
    }): Promise<Outcome>;
    /** Open a path of the Polaris in a window of its own - a service's logs. */
    openWindow(input: { readonly path: string; readonly title: string }): Promise<Outcome>;
}

/** Where a push is. */
export type PushPhase =
    | "ready"
    | "checking"
    | "building"
    | "saving"
    | "sending"
    | "deploying"
    | "done"
    | "failed"
    | "cancelled";

export interface PushState {
    readonly service: string;
    readonly server: string;
    readonly folder: string;
    readonly platform: string;
    readonly phase: PushPhase;
}

export type PushEvent =
    | { readonly kind: "state"; readonly state: PushState }
    | { readonly kind: "line"; readonly text: string }
    | { readonly kind: "progress"; readonly sent: number; readonly total: number }
    | { readonly kind: "result"; readonly ok: boolean; readonly message: string };

export interface PolarisLocal {
    readonly connect: {
        /** The address in use and why it could not be opened, if it could not. */
        state(): Promise<{ readonly address: string | null; readonly error: string | null }>;
        submit(address: string): Promise<Outcome>;
    };
    readonly apiKey: {
        state(): Promise<{ readonly server: string; readonly canKeep: boolean }>;
        submit(key: string): Promise<Outcome>;
        cancel(): Promise<void>;
        /** Open Account > API keys in the main window. */
        openKeys(): Promise<void>;
    };
    readonly push: {
        state(): Promise<PushState>;
        chooseFolder(): Promise<string | null>;
        start(input: { readonly platform: string }): Promise<Outcome>;
        cancel(): Promise<void>;
        openService(): Promise<void>;
        onEvent(listener: (event: PushEvent) => void): () => void;
    };
}

export const CHANNELS = {
    notify: "desktop:notify",
    closeNotice: "desktop:close-notice",
    pickFolder: "desktop:pick-folder",
    pushLocal: "desktop:push-local",
    openWindow: "desktop:open-window",
    connectState: "local:connect-state",
    connectSubmit: "local:connect-submit",
    keyState: "local:key-state",
    keySubmit: "local:key-submit",
    keyCancel: "local:key-cancel",
    keyOpen: "local:key-open",
    pushState: "local:push-state",
    pushChoose: "local:push-choose",
    pushStart: "local:push-start",
    pushCancel: "local:push-cancel",
    pushOpenService: "local:push-open-service",
    pushEvent: "local:push-event"
} as const;

/** The argument that carries this app's version into the dashboard's preload. */
export const VERSION_ARGUMENT = "--polaris-desktop-version=";
