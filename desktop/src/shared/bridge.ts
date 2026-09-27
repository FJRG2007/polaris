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

export type Outcome = { readonly ok: true; } | { readonly ok: false; readonly error: string; };

export interface NoticeInput {
    readonly title: string;
    readonly body?: string;
    /** A field on the notice to answer in, with this placeholder: a message
     *  answered where it arrived. The answer comes back through
     *  `onNoticeReply`. */
    readonly reply?: { readonly placeholder: string; };
    /** Buttons on the notice, by id: "Mark as read". A press comes back through
     *  `onNoticeAction` with the id. */
    readonly actions?: readonly NoticeButton[];
    /** Notices sharing a tag replace each other. */
    readonly tag: string;
    /** A path on the Polaris to open when the notice is pressed. */
    readonly href?: string;
    /** Stays until it is dealt with, where the system allows it. */
    readonly insistent?: boolean;
    /**
     * Whether the notice makes a sound of its own.
     *
     * Off by default: the page chimes for what it announces, and one event with
     * two sounds is worse than either. A call asks for it, because a call is
     * announced out here precisely when the window is not the thing in front of
     * somebody - and a window nobody is looking at is one whose audio may be
     * suspended, so the page's own ring is a sound nobody hears.
     */
    readonly sound?: boolean;
}

export type PickedFolder =
    | { readonly ok: true; readonly name: string; readonly files: number; readonly zip: Uint8Array; }
    | { readonly ok: false; readonly error: string; }
    | null;

export interface PolarisDesktop {
    /** This app's version. */
    readonly version: string;
    readonly platform: string;
    /** Show a notice drawn by the operating system. Resolves false when it cannot. */
    notify(input: NoticeInput): Promise<boolean>;
    /** Take back the notice with this tag. */
    closeNotice(tag: string): Promise<void>;
    /** Hear what is written in a notice's answer field. Answers the way to stop. */
    onNoticeReply(listener: (reply: NoticeReply) => void): () => void;
    /** Hear a press on one of a notice's buttons. Answers the way to stop. */
    onNoticeAction(listener: (action: NoticeAction) => void): () => void;
    /** A folder picked with the system's own dialog, zipped for "Upload a folder".
     *  Null when the dialog was dismissed. */
    pickFolder(): Promise<PickedFolder>;
    /** Build a service here with this computer's Docker and deploy the image. */
    pushLocal(input: { readonly serviceId: string; readonly name: string; readonly href?: string; }): Promise<Outcome>;
    /** Open a path of the Polaris in a window of its own - a service's logs. */
    openWindow(input: { readonly path: string; readonly title: string; }): Promise<Outcome>;
}

/** Where a push is. */
export type PushPhase = "ready" | "checking" | "building" | "saving" | "sending" | "deploying" | "done" | "failed" | "cancelled";

export interface PushState {
    readonly service: string;
    readonly server: string;
    readonly folder: string;
    readonly platform: string;
    readonly phase: PushPhase;
}

export type PushEvent =
    | { readonly kind: "state"; readonly state: PushState; }
    | { readonly kind: "line"; readonly text: string; }
    | { readonly kind: "progress"; readonly sent: number; readonly total: number; }
    | { readonly kind: "result"; readonly ok: boolean; readonly message: string; };

export interface PolarisLocal {
    readonly connect: {
        /** The address in use and why it could not be opened, if it could not. */
        state(): Promise<{ readonly address: string | null; readonly error: string | null; }>;
        submit(address: string): Promise<Outcome>;
    };
    readonly apiKey: {
        state(): Promise<{ readonly server: string; readonly canKeep: boolean; }>;
        submit(key: string): Promise<Outcome>;
        cancel(): Promise<void>;
        /** Open Account > API keys in the main window. */
        openKeys(): Promise<void>;
    };
    readonly push: {
        state(): Promise<PushState>;
        chooseFolder(): Promise<string | null>;
        start(input: { readonly platform: string; }): Promise<Outcome>;
        cancel(): Promise<void>;
        openService(): Promise<void>;
        onEvent(listener: (event: PushEvent) => void): () => void;
    };
}

/** A button on a notice. */
export interface NoticeButton {
    readonly id: string;
    readonly text: string;
}

/** A press on a notice's button, handed back to the page that raised it. */
export interface NoticeAction {
    readonly tag: string;
    readonly action: string;
}

/** An answer written on a notice, handed back to the page that raised it. */
export interface NoticeReply {
    readonly tag: string;
    readonly text: string;
}

export const CHANNELS = {
    notify: "desktop:notify",
    noticeReply: "desktop:notice-reply",
    noticeAction: "desktop:notice-action",
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
