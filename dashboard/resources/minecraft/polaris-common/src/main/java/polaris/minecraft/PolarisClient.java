package polaris.minecraft;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.concurrent.CompletableFuture;

/**
 * Polaris login's only way to Polaris, in the mod and the plugin alike: one POST
 * per question, answered asynchronously.
 *
 * Every failure to get an answer - a refused connection, a timeout, a certificate
 * the JVM does not trust, a proxy's HTML error page - comes back as an unreachable
 * reply rather than an exception, because the caller's answer to all of them is
 * the same: nobody is let in on it.
 */
final class PolarisClient {
    private static final Duration CONNECT_TIMEOUT = Duration.ofSeconds(5);
    private static final Duration REQUEST_TIMEOUT = Duration.ofSeconds(10);

    private final PolarisConfig config;
    private final String userAgent;
    private final HttpClient http;

    PolarisClient(PolarisConfig config, String modVersion) {
        this.config = config;
        this.userAgent = "Polaris-Minecraft/" + modVersion;
        this.http = HttpClient.newBuilder()
                .connectTimeout(CONNECT_TIMEOUT)
                .followRedirects(HttpClient.Redirect.NEVER)
                .build();
    }

    /** What Polaris answered, or why there is no answer. */
    record Reply(int status, JsonObject body, String unreachable) {
        static Reply unreachable(String why) {
            return new Reply(0, new JsonObject(), why);
        }

        boolean reached() {
            return unreachable == null;
        }

        String text(String field) {
            JsonElement value = body.get(field);
            return value != null && value.isJsonPrimitive() ? value.getAsString() : "";
        }

        boolean flag(String field) {
            JsonElement value = body.get(field);
            return value != null && value.isJsonPrimitive() && value.getAsBoolean();
        }

        long number(String field) {
            JsonElement value = body.get(field);
            return value != null && value.isJsonPrimitive() ? value.getAsLong() : 0;
        }
    }

    CompletableFuture<Reply> call(String action, JsonObject body) {
        HttpRequest request;
        try {
            request = HttpRequest.newBuilder(URI.create(
                            config.baseUrl() + "/api/minecraft/login/" + config.serverId() + "/" + action))
                    .timeout(REQUEST_TIMEOUT)
                    .header("Authorization", "Bearer " + config.token())
                    .header("Content-Type", "application/json")
                    .header("Accept", "application/json")
                    .header("User-Agent", userAgent)
                    .POST(HttpRequest.BodyPublishers.ofString(body.toString(), StandardCharsets.UTF_8))
                    .build();
        } catch (IllegalArgumentException invalid) {
            return CompletableFuture.completedFuture(Reply.unreachable("the address is not valid"));
        }
        return http.sendAsync(request, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8))
                .thenApply(PolarisClient::parse)
                .exceptionally(failure -> Reply.unreachable(describe(failure)));
    }

    private static Reply parse(HttpResponse<String> response) {
        try {
            JsonElement parsed = JsonParser.parseString(response.body());
            if (parsed.isJsonObject()) return new Reply(response.statusCode(), parsed.getAsJsonObject(), null);
        } catch (RuntimeException notJson) {
            // Falls through: something between here and Polaris answered instead.
        }
        return Reply.unreachable("the address answered HTTP " + response.statusCode() + " without Polaris behind it");
    }

    private static String describe(Throwable failure) {
        Throwable cause = failure;
        while (cause.getCause() != null && cause.getCause() != cause) cause = cause.getCause();
        String message = cause.getMessage();
        return cause.getClass().getSimpleName() + (message == null ? "" : ": " + message);
    }
}
