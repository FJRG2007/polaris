/** Redirect errors only exist on a server. */
export const isRedirectError = () => false;
export const getRedirectError = () => new Error("redirect");
