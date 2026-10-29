/**
 * A file from the public folder, as an address the page can load.
 *
 * The dashboard serves its public folder at the root, but the public site is a
 * static export under a base path (`/polaris` on GitHub Pages), where a bare
 * `/logos/x.svg` is a 404 - which is how the downloads cards drew empty tiles
 * there. The site builds with `NEXT_PUBLIC_BASE_PATH`; the dashboard has none.
 */
export function publicAsset(path: string): string {
    return `${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}${path}`;
}
