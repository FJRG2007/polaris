/**
 * Where a face is fetched from.
 *
 * One URL per account whatever the picture turns out to be - an upload, a
 * Gravatar, or nothing at all - so no screen has to know which of the three
 * applies, and a 404 is simply "draw the initials".
 *
 * Its own module because the component that renders faces runs in the browser
 * and `avatar-service` reaches for Prisma and node:crypto the moment it is
 * imported.
 */

export function avatarUrl(userId: string): string {
    return `/api/avatar/${userId}`;
}

/** The wide picture across the top of somebody's profile. Answers a transparent
 *  pixel when they have none, like every other picture route here, so what is
 *  drawn underneath - a colour taken from their face - shows through. */
export function bannerUrl(userId: string): string {
    return `/api/banner/${userId}`;
}

/** The same for an organization. A separate path rather than a shared one keyed
 *  by id: the two are different tables, and a URL that could mean either would
 *  serve a person's face for an organization's id the day the ids collide. */
export function orgAvatarUrl(orgId: string): string {
    return `/api/avatar/org/${orgId}`;
}

/** The band across the top of an organization's page. Its own path beside the
 *  mark's, for the same reason a person's banner has one: they are two pictures
 *  of one subject and a single URL could only serve one of them. */
export function orgBannerUrl(orgId: string): string {
    return `/api/banner/org/${orgId}`;
}

/** The picture on a space or a conversation. Answers a transparent pixel when
 *  there is none, and the same pixel when the reader is not in it - so what is
 *  drawn underneath shows through either way. */
export function chatAvatarUrl(kind: "space" | "channel", id: string): string {
    return `/api/avatar/chat/${kind}/${id}`;
}
