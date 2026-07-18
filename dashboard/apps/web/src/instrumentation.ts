/**
 * Server instrumentation. Installs last-resort guards so a faulty connector (an
 * SMB client that throws an async socket/crypto error, say) can never take the
 * whole dashboard down with an uncaught exception - the failing request errors,
 * the server stays up. Node runtime only; the edge runtime has no process events.
 */

export async function register(): Promise<void> {
    if (process.env.NEXT_RUNTIME !== "nodejs") return;
    process.on("uncaughtException", (error) => {
        console.error("polaris: uncaught exception (server kept alive):", error);
    });
    process.on("unhandledRejection", (reason) => {
        console.error("polaris: unhandled rejection (server kept alive):", reason);
    });
}
