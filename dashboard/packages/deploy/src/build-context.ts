/**
 * The shape a build context arrives in.
 *
 * A tar of the source, plus the one thing that can only be known after the source
 * is on disk: where the auto-detecting builder should actually be pointed. For a
 * workspace that is the repository root rather than the service's own directory,
 * because the lockfile and the shared packages the app builds against live above
 * it - so the answer has to travel back out of the clone to the runtime that is
 * about to ask for the build.
 */

import type { Readable } from "node:stream";

export interface BuildContext {
    /** A tar stream of the source, as the build port takes it. */
    readonly tar: Readable;
    /** Where to point a builder that finds its own way around, when detection
     *  moved it. Absent leaves the service's configured root directory in force. */
    readonly root?: string;
    /**
     * A Dockerfile Polaris wrote into the context, relative to its root.
     *
     * Present means the project was recognized well enough to say exactly how to
     * build it, and the ordinary Dockerfile path takes over - which is what puts
     * the runtime version under Polaris's control instead of the build machine's.
     * Absent leaves the auto-detecting builder in charge, as before.
     */
    readonly dockerfile?: string;
}
