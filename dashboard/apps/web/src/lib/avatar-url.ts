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
