"use client";

/**
 * The tag a person wears, as this viewer may see it - nothing otherwise. Every
 * drawn name carries it (`PersonName`, mentions, `ProfileNameExtras`), asked for
 * in one batch with every other name on screen.
 *
 * Its own file rather than inside `profile-name-extras`, because a name is drawn
 * on every screen and must not bring the badges dialog and its strings with it.
 */

import { useNameTag } from "./name-tag-store";
import { NameTagButton } from "./name-tag-chip";

export function PersonNameTag({ id }: { id: string | null | undefined }) {
    const tag = useNameTag(id);
    if (!id || !tag) return null;
    return <NameTagButton tag={tag} personId={id} />;
}
