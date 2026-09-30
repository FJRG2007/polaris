package polaris.minecraft.chat;

import com.google.gson.Gson;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.function.Consumer;
import java.util.regex.Pattern;

/**
 * Chat moderation's line to the Polaris that runs this server.
 *
 * It fetches the rules every half minute (which is also how the Moderation tab
 * knows the server is being moderated at all), and tells Polaris about each line
 * it stopped, one request each, off the game thread. Polaris keeps the line for
 * the tab, decides whether the player has done it often enough to be timed out,
 * and answers with the warning in that player's own language, which is what the
 * player is shown. When Polaris cannot be reached the player is warned in the
 * server's language from the rules, and the line is not kept anywhere.
 *
 * A player flooding the chat is told once every few seconds, not once a line.
 */
public final class ChatLink {
    private static final Pattern SERVER_ID =
            Pattern.compile("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$");
    private static final Duration TIMEOUT = Duration.ofSeconds(10);
    private static final long RULES_EVERY_MS = 30_000;
    /** Between two reports (and two warnings) for the same player. */
    private static final long QUIET_MS = 3_000;
    /** The longest line sent: the game's own chat limit. */
    private static final int TEXT_MAX = 256;

    private final String endpoint;
    private final String token;
    private final String userAgent;
    private final ChatGuard guard;
    private final Consumer<String> log;
    private final HttpClient http = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(5))
            .followRedirects(HttpClient.Redirect.NEVER)
            .build();
    private final Map<UUID, Long> lastReport = new ConcurrentHashMap<>();
    private volatile boolean saidDown;

    private ChatLink(String endpoint, String token, String version, ChatGuard guard, Consumer<String> log) {
        this.endpoint = endpoint;
        this.token = token;
        this.userAgent = "Polaris-Minecraft/" + version;
        this.guard = guard;
        this.log = log;
        ScheduledExecutorService worker = Executors.newSingleThreadScheduledExecutor(runnable -> {
            Thread thread = new Thread(runnable, "polaris-chat");
            thread.setDaemon(true);
            return thread;
        });
        worker.scheduleWithFixedDelay(this::fetchRules, 2_000, RULES_EVERY_MS, TimeUnit.MILLISECONDS);
    }

    /**
     * The link for this server, or null when the environment does not say where
     * Polaris is: without the address, this server's id and its token there is
     * nobody to ask for rules, and nothing is moderated.
     */
    public static ChatLink start(Map<String, String> env, String version, ChatGuard guard, Consumer<String> log) {
        String url = env.getOrDefault("POLARIS_URL", "").trim().replaceAll("/+$", "");
        String id = env.getOrDefault("POLARIS_SERVER_ID", "").trim();
        String token = env.getOrDefault("POLARIS_SERVER_TOKEN", "").trim();
        if (token.isEmpty() || !SERVER_ID.matcher(id).matches() || !isHttpUrl(url)) return null;
        log.accept("Chat moderation takes its rules from " + url);
        return new ChatLink(url + "/api/minecraft/chat/" + id, token, version, guard, log);
    }

    private static boolean isHttpUrl(String value) {
        try {
            URI uri = URI.create(value);
            String scheme = uri.getScheme();
            return uri.getHost() != null && ("http".equalsIgnoreCase(scheme) || "https".equalsIgnoreCase(scheme));
        } catch (IllegalArgumentException invalid) {
            return false;
        }
    }

    private HttpRequest.Builder request() {
        return HttpRequest.newBuilder(URI.create(endpoint))
                .timeout(TIMEOUT)
                .header("Authorization", "Bearer " + token)
                .header("Accept", "application/json")
                .header("User-Agent", userAgent);
    }

    private static JsonObject object(String body) {
        try {
            JsonElement parsed = new Gson().fromJson(body, JsonElement.class);
            return parsed != null && parsed.isJsonObject() ? parsed.getAsJsonObject() : null;
        } catch (RuntimeException notJson) {
            return null;
        }
    }

    private void fetchRules() {
        try {
            HttpResponse<String> answer = http.send(request().GET().build(),
                    HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
            if (answer.statusCode() == 401 || answer.statusCode() == 404) {
                // This server is not Polaris's to moderate any more.
                guard.update(ChatRules.OFF);
                return;
            }
            JsonObject body = answer.statusCode() == 200 ? object(answer.body()) : null;
            if (body == null) return;
            boolean was = guard.rules().enabled();
            ChatRules next = ChatRules.parse(body);
            guard.update(next);
            if (was != next.enabled()) log.accept(next.enabled() ? "Chat moderation is on." : "Chat moderation is off.");
            saidDown = false;
        } catch (Exception unreachable) {
            // The last rules stay until Polaris answers again.
            if (!saidDown) log.accept("Chat moderation could not reach Polaris; keeping the last rules.");
            saidDown = true;
        }
    }

    /**
     * Tell Polaris a line was stopped, and hand {@code warn} what to say to the
     * player - on the HTTP client's thread, so the caller moves it to its own.
     * Nothing at all happens for a player reported a moment ago.
     */
    public void report(String player, UUID uuid, ChatGuard.Verdict verdict, String line, boolean command,
            Consumer<String> warn) {
        long now = System.currentTimeMillis();
        Long last = lastReport.get(uuid);
        if (last != null && now - last < QUIET_MS) return;
        lastReport.put(uuid, now);
        String fallback = guard.rules().fallback(verdict.reason());
        String text = line.length() > TEXT_MAX ? line.substring(0, TEXT_MAX) : line;
        JsonObject body = new JsonObject();
        body.addProperty("player", player);
        body.addProperty("uuid", uuid.toString());
        body.addProperty("reason", verdict.reason());
        body.addProperty("detail", verdict.detail().length() > 120 ? verdict.detail().substring(0, 120) : verdict.detail());
        body.addProperty("text", text);
        body.addProperty("command", command);
        body.addProperty("at", now);
        HttpRequest request;
        try {
            request = request()
                    .header("Content-Type", "application/json")
                    .POST(HttpRequest.BodyPublishers.ofString(body.toString(), StandardCharsets.UTF_8))
                    .build();
        } catch (IllegalArgumentException invalid) {
            if (!fallback.isEmpty()) warn.accept(fallback);
            return;
        }
        http.sendAsync(request, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8))
                .thenAccept(answer -> {
                    JsonObject reply = answer.statusCode() == 200 ? object(answer.body()) : null;
                    JsonElement said = reply == null ? null : reply.get("warn");
                    String message = said != null && said.isJsonPrimitive() ? said.getAsString() : fallback;
                    if (!message.isEmpty()) warn.accept(message);
                })
                .exceptionally(failure -> {
                    if (!fallback.isEmpty()) warn.accept(fallback);
                    return null;
                });
    }

    /** A player who left is reported afresh next time. */
    public void forget(UUID uuid) {
        lastReport.remove(uuid);
    }
}
