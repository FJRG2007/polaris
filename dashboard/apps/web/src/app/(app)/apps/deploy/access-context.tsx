"use client";

/**
 * What the person looking at this project may do in it, for the screens under it.
 *
 * The server decides access and enforces it at every write; this is the same
 * answer carried into the tree so a control nobody can use is not drawn at all.
 * A button that exists and then refuses is a worse screen than a button that was
 * never there, and hiding one here is a courtesy rather than a defence - the
 * action re-resolves the same access on its own.
 *
 * Seeded from the server per project rather than fetched, so the first paint
 * already knows. Anything rendered outside a project - the Deploy landing, the
 * Containers app reusing a panel - gets the full set, because it is showing
 * things the reader reached some other way and this has nothing to say about it.
 */

import { createContext, useContext, type ReactNode } from "react";
import { ALL_PROJECT_CAPABILITIES, type ProjectCapability } from "@polaris/core";

const ProjectAccessContext = createContext<readonly ProjectCapability[]>(ALL_PROJECT_CAPABILITIES);

export function ProjectAccessProvider({
    capabilities,
    children
}: {
    capabilities: readonly ProjectCapability[];
    children: ReactNode;
}) {
    return (
        <ProjectAccessContext.Provider value={capabilities}>
            {children}
        </ProjectAccessContext.Provider>
    );
}

/** Ask whether the reader holds one capability here. */
export function useProjectCan(): (capability: ProjectCapability) => boolean {
    const held = useContext(ProjectAccessContext);
    return (capability) => held.includes(capability);
}
