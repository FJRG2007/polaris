/**
 * Stands in for the chat's server actions in sealed-browser.test.ts. In the
 * dashboard a "use server" module reaches the page as references that call the
 * server; bundled as is it would pull the whole server side into the page. The
 * test's messages carry no link, so no card is ever asked for.
 */

export async function sealedLinkCardAction(): Promise<{ preview: null }> {
    return { preview: null };
}
