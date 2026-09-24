/**
 * What core may ask of an installable app.
 *
 * Core never imports an app's modules. Everything it needs from one - a job to
 * run, a backup source, a panel to draw, the ports a router must forward - it
 * asks the app extension registry, and an app that is not there answers
 * nothing. That is what lets an app's code be absent from a server that has not
 * installed it (docs/installable-apps-plan.md).
 *
 * Every hook is optional: an app implements the ones it has something to say
 * about. Everything here is a type, so this module is shared by core and apps.
 */

import type { PendingAppLink } from "@polaris/core";
import type { BackupSource } from "@/lib/backups/sources/types";
import type { GamePortRow, GamePortsReading } from "@/lib/apps/port-advice";

/** A scheduled job an app runs. Keyed like core's own; the key names the lease. */
export interface AppJob {
    readonly key: string;
    readonly everyMs: number;
    readonly leaseMs: number | null;
    readonly run: () => Promise<unknown>;
}

/**
 * Something an app draws inside a core screen.
 *
 * Built on the server, where the app reads what it needs, and drawn on the
 * client by the app's own component, looked up by `app` and `kind`. `props` is
 * whatever that component takes; core only carries it.
 */
export interface AppSlot {
    readonly app: string;
    readonly kind: string;
    readonly props: unknown;
    /** Where the component that draws it is, when the app came as a bundle. */
    readonly bundle?: { readonly src: string; readonly name: string };
}

/** One game server, as the overview card needs it. */
export interface GameServerSummary {
    readonly id: string;
    readonly name: string;
    readonly game: string | null;
    readonly catalogName: string;
    readonly serverName: string | null;
    readonly running: boolean;
    readonly slots: number | null;
}

/** The install a panel is drawn for. */
export interface ExtensionInstall {
    readonly id: string;
    readonly catalogId: string;
    readonly applicationId: string | null;
    readonly ownerId: string;
}

export interface AppExtension {
    /** The catalog id of the app, the one its install row carries. */
    readonly id: string;

    /** The scheduled jobs it runs. They only run while it is installed. */
    readonly jobs?: () => readonly AppJob[];

    /** The backup sources it provides, by resource kind. */
    readonly backupSources?: () => Readonly<Partial<Record<BackupSource["kind"], BackupSource>>>;

    /** The image a release of one of its services runs, when the app decides it
     *  rather than the stored one. Undefined leaves the stored image alone. */
    readonly releaseImage?: (
        storedImage: string | undefined,
        env: Readonly<Record<string, string>>
    ) => string | undefined;

    /** Whether an install's settings describe a server that loads plugins, which
     *  decides whether plugin-only settings are kept when it is installed. Null
     *  for a catalog app this extension does not know. */
    readonly pluginServer?: (catalogId: string, env: ReadonlyMap<string, string>) => boolean | null;

    /** Before one of its installs is stopped or redeployed: write out what only
     *  lives in memory. */
    readonly beforeStop?: (ownerId: string, installedAppId: string) => Promise<void>;

    /** When one of its installs is started by hand. */
    readonly afterStart?: (installedAppId: string) => Promise<void>;

    /** Fold older install rows into the app's own, when a screen that lists
     *  installs is opened. */
    readonly adopt?: (ownerId: string) => Promise<unknown>;

    /** Its servers, for the overview card. */
    readonly gameServerSummaries?: (userId: string) => Promise<readonly GameServerSummary[]>;

    /** The ports the router has to forward for it. */
    readonly forwardedPorts?: () => Promise<readonly GamePortRow[]>;

    /** The same, with the advice the Domains card shows, knocking when asked. */
    readonly readForwardedPorts?: (probe: boolean) => Promise<GamePortsReading>;

    /** What the firewall shows above the web rules for a service it runs. */
    readonly firewallSlot?: (ownerId: string, applicationId: string) => Promise<AppSlot | null>;

    /** The panel an installed-app page draws for one of its installs. */
    readonly installedPanelSlot?: (install: ExtensionInstall) => Promise<AppSlot | null>;

    /** Work started once when the dashboard boots. Must not wait on anything:
     *  the server is still starting. */
    readonly onBoot?: () => void;

    /** Whether this account reaches the app without holding its permission -
     *  somebody lent one item of it. */
    readonly reaches?: (userId: string) => Promise<boolean>;

    /** An invite that carried a link to one of its things was claimed. The
     *  inviter has already been re-checked; an app that does not know the kind
     *  leaves it. */
    readonly claimLink?: (claim: {
        readonly userId: string;
        readonly installedAppId: string;
        readonly grantedById: string;
        readonly link: PendingAppLink;
    }) => Promise<void>;
}
