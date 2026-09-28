package polaris.anticheat.bridge;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.logging.Logger;
import java.util.regex.Pattern;

/**
 * Hands what the anti-cheat catches to the Polaris that runs this server, so it is
 * listed on the server's Anti-cheat tab beside everything else Polaris watches.
 *
 * Polaris writes the address, this server's id and its token into the
 * environment when it switches the anti-cheat on. Without all three this does
 * nothing at all, so the plugin behaves exactly like upstream anywhere else.
 *
 * Nothing here runs on the network or game threads: a flag is put on a bounded
 * queue and returns, and one daemon thread sends what has gathered every few
 * seconds in one request. When Polaris cannot be reached the batch is kept for
 * the next try, and the oldest flags are dropped first once the queue is full,
 * so a Polaris that is down costs memory that is capped and nothing else.
 */
public final class PolarisReporter {
    private static final Logger LOG = Logger.getLogger("PolarisAntiCheat");
    private static final Pattern SERVER_ID =
            Pattern.compile("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$");

    /** Flags waiting to be sent. A burst from one cheater is hundreds; beyond this
     *  the oldest go, since the newest say the same and more recently. */
    static final int QUEUE_MAX = 2000;
    /** Flags in one request, which the Polaris route also caps. */
    static final int BATCH_MAX = 200;
    private static final long FLUSH_EVERY_MS = 5_000;
    /** How often the honeypot list is fetched again (see PolarisTraps). */
    private static final long TRAPS_EVERY_MS = 60_000;
    /** The longest honeypot list read: far more than Polaris ever places. */
    private static final int TRAPS_BODY_MAX = 256 * 1024;
    /** The longest a verbose line is kept: the route refuses longer ones. */
    static final int VERBOSE_MAX = 300;

    private static volatile PolarisReporter instance;

    private final String endpoint;
    private final String token;
    private final HttpClient client;
    private final ArrayDeque<String> queue = new ArrayDeque<>();
    private final ScheduledExecutorService sender;
    /** Whether the last failure was already logged, so a Polaris that is down
     *  writes one line, not one every five seconds. */
    private boolean saidDown;

    private PolarisReporter(String endpoint, String token) {
        this.endpoint = endpoint;
        this.token = token;
        this.client = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build();
        this.sender = Executors.newSingleThreadScheduledExecutor(runnable -> {
            Thread thread = new Thread(runnable, "polaris-anticheat-reporter");
            thread.setDaemon(true);
            return thread;
        });
        this.sender.scheduleWithFixedDelay(this::flush, FLUSH_EVERY_MS, FLUSH_EVERY_MS, TimeUnit.MILLISECONDS);
        this.sender.scheduleWithFixedDelay(this::fetchTraps, 3_000, TRAPS_EVERY_MS, TimeUnit.MILLISECONDS);
    }

    /** The reporter for this server, or null when Polaris has not set one up. */
    public static PolarisReporter get() {
        PolarisReporter current = instance;
        if (current != null) return current;
        synchronized (PolarisReporter.class) {
            if (instance == null) instance = fromEnvironment(System.getenv());
            return instance;
        }
    }

    static PolarisReporter fromEnvironment(Map<String, String> env) {
        String flag = env.getOrDefault("POLARIS_ANTICHEAT", "").trim().toLowerCase(Locale.ROOT);
        String url = env.getOrDefault("POLARIS_URL", "").trim().replaceAll("/+$", "");
        String id = env.getOrDefault("POLARIS_SERVER_ID", "").trim();
        String token = env.getOrDefault("POLARIS_SERVER_TOKEN", "").trim();
        if (!flag.equals("on") || token.isEmpty() || !SERVER_ID.matcher(id).matches() || !isHttpUrl(url)) {
            return null;
        }
        LOG.info("Reporting to Polaris at " + url);
        return new PolarisReporter(url + "/api/minecraft/anticheat/" + id, token);
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

    /** Queue one flag. Returns at once; never throws. */
    public void report(String player, UUID uuid, String check, double violations, String verbose) {
        String line = flagJson(player, uuid, check, violations, verbose, System.currentTimeMillis());
        synchronized (queue) {
            if (queue.size() >= QUEUE_MAX) queue.pollFirst();
            queue.addLast(line);
        }
    }

    static String flagJson(String player, UUID uuid, String check, double violations, String verbose, long at) {
        String trimmed = verbose == null ? "" : verbose.strip();
        if (trimmed.length() > VERBOSE_MAX) trimmed = trimmed.substring(0, VERBOSE_MAX);
        return "{\"player\":" + quote(player)
                + ",\"uuid\":" + quote(uuid == null ? "" : uuid.toString())
                + ",\"check\":" + quote(check)
                + ",\"vl\":" + (long) Math.max(0, Math.min(violations, 1_000_000))
                + ",\"verbose\":" + quote(trimmed)
                + ",\"at\":" + at + "}";
    }

    /** A JSON string, with everything a string may not carry raw escaped. */
    static String quote(String value) {
        StringBuilder out = new StringBuilder(value.length() + 2).append('"');
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            switch (c) {
                case '"' -> out.append("\\\"");
                case '\\' -> out.append("\\\\");
                case '\n' -> out.append("\\n");
                case '\r' -> out.append("\\r");
                case '\t' -> out.append("\\t");
                default -> {
                    if (c < 0x20 || c == 0x2028 || c == 0x2029) out.append(String.format("\\u%04x", (int) c));
                    else out.append(c);
                }
            }
        }
        return out.append('"').toString();
    }

    private void flush() {
        List<String> batch = new ArrayList<>(BATCH_MAX);
        synchronized (queue) {
            while (batch.size() < BATCH_MAX && !queue.isEmpty()) batch.add(queue.pollFirst());
        }
        if (batch.isEmpty()) return;
        String body = "{\"flags\":[" + String.join(",", batch) + "]}";
        try {
            HttpRequest request = HttpRequest.newBuilder(URI.create(endpoint))
                    .timeout(Duration.ofSeconds(10))
                    .header("content-type", "application/json")
                    .header("authorization", "Bearer " + token)
                    .POST(HttpRequest.BodyPublishers.ofString(body))
                    .build();
            HttpResponse<Void> answer = client.send(request, HttpResponse.BodyHandlers.discarding());
            int status = answer.statusCode();
            if (status >= 200 && status < 300) {
                saidDown = false;
                return;
            }
            // Refused for what it is, not for where Polaris is: a batch Polaris
            // will never take is dropped rather than retried forever.
            if (status >= 400 && status < 500 && status != 429) {
                LOG.warning("Polaris refused " + batch.size() + " anti-cheat flags (HTTP " + status + ")");
                return;
            }
            keep(batch, "HTTP " + status);
        } catch (Exception failed) {
            keep(batch, failed.getClass().getSimpleName());
        }
    }

    /** Fetch where Polaris's X-Ray honeypots are, so the anti-xray leaves them visible. */
    private void fetchTraps() {
        try {
            HttpRequest request = HttpRequest.newBuilder(URI.create(endpoint))
                    .timeout(Duration.ofSeconds(10))
                    .header("authorization", "Bearer " + token)
                    .GET()
                    .build();
            HttpResponse<String> answer = client.send(request, HttpResponse.BodyHandlers.ofString());
            String body = answer.body();
            if (answer.statusCode() == 200 && body != null && body.length() <= TRAPS_BODY_MAX) {
                PolarisTraps.accept(body);
            }
        } catch (Exception ignored) {
            // The last list stays; a Polaris that is down is already logged by flush.
        }
    }

    /** Put a batch that did not go back at the front, for the next try. */
    private void keep(List<String> batch, String why) {
        if (!saidDown) {
            LOG.warning("Could not reach Polaris to report anti-cheat flags (" + why + "); will keep trying");
            saidDown = true;
        }
        synchronized (queue) {
            for (int i = batch.size() - 1; i >= 0; i--) {
                if (queue.size() >= QUEUE_MAX) break;
                queue.addFirst(batch.get(i));
            }
        }
    }
}
