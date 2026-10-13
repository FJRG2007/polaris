/**
 * Opening a song somebody scrobbled to Last.fm in Spotify.
 *
 * Last.fm says what a track is called and who made it, never which Spotify track
 * it was, so the only honest way to "listen along" with such a song is a search
 * for it - which starts it from the beginning, not where they are. Shared by the
 * poll that stores the song and the card that offers the button, so the two
 * agree on which songs came from where.
 */

/** Activity keys written for a Last.fm song start with this. A Spotify track's
 *  key is its bare id, which never contains a colon. */
export const LASTFM_KEY_PREFIX = "lastfm:";

export function isLastfmKey(key: string): boolean {
    return key.startsWith(LASTFM_KEY_PREFIX);
}

/** Spotify's own search page for a song and its artist. */
export function spotifySearchUrl(name: string, artists: string): string {
    const query = `${name} ${artists}`.replace(/\s+/g, " ").trim();
    return `https://open.spotify.com/search/${encodeURIComponent(query)}`;
}
