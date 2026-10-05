/**
 * Load a .env file into process.env for the tests, if there is one. Node's own
 * loader: a missing file is not an error, and a variable already set in the
 * environment keeps its value - what dotenv's `config()` did here.
 */
export function loadDotEnv(path: string): void {
    try {
        process.loadEnvFile(path);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
}
