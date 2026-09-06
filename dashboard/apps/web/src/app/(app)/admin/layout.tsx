/**
 * Everything under Administration.
 *
 * One job: people are rows of data here, not people. An account list is read by
 * scanning two hundred names for the one that matches, and a gradient across the
 * letters or a plate behind the row is the thing that stops that working - see
 * `PlainNames`. Doing it here rather than per table means the screen added under
 * /admin next week inherits it without anybody remembering to.
 *
 * The permission is not here. Every screen under this already requires its own,
 * and a layout that looked allowed would be a layout somebody trusted.
 */

import { PlainNames } from "@/components/person-name";

export default function AdminLayout({ children }: { children: React.ReactNode }) {
    return <PlainNames>{children}</PlainNames>;
}
