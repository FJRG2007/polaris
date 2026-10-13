/**
 * Query parameters a link's callback hands back to the screen it lands on.
 * Shared by the server that writes them and the client that reads them.
 */

/** Set when this very attempt recorded the provider's reason for refusing, so
 *  the screen never presents an older or somebody else's reason as this one's. */
export const FAILURE_RECORDED = "failureRecorded";
