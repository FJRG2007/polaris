package polaris.anticheat.api;

import java.util.concurrent.CompletableFuture;

public final class PolarisAPIProvider {
    private static PolarisAbstractAPI instance;
    private static final CompletableFuture<PolarisAbstractAPI> futureInstance = new CompletableFuture<>();

    private PolarisAPIProvider() {
        // Private constructor to prevent instantiation
    }

    /**
     * Initializes the PolarisAPI instance during mod loading.
     * This method should only be called once by the mod initializer.
     *
     * @param api The PolarisAbstractAPI instance to initialize.
     * @throws IllegalStateException If the API is already initialized.
     */
    public static void init(PolarisAbstractAPI api) {
        if (instance != null || futureInstance.isDone()) {
            throw new IllegalStateException("PolarisAPI is already initialized");
        }
        instance = api;
        futureInstance.complete(api); // Complete the future with the API instance
    }

    /**
     * Gets the PolarisAPI instance synchronously.
     *
     * @return The PolarisAbstractAPI instance.
     * @throws IllegalStateException If the API is not loaded.
     */
    public static PolarisAbstractAPI get() {
        if (instance == null) {
            throw new IllegalStateException("PolarisAPI is not loaded. Ensure the Polaris mod is installed and initialized.");
        }
        return instance;
    }

    /**
     * Gets the PolarisAPI instance asynchronously.
     * The returned CompletableFuture will complete when the PolarisAPI instance is available.
     * If the API is already loaded, the future will complete immediately.
     * If the API fails to load (e.g., the mod is not installed), the future will complete exceptionally.
     *
     * @return A CompletableFuture that completes with the PolarisAbstractAPI instance.
     */
    public static CompletableFuture<PolarisAbstractAPI> getAsync() {
        if (instance != null) {
            // If the instance is already loaded, return a completed future
            return CompletableFuture.completedFuture(instance);
        }
        return futureInstance;
    }
}