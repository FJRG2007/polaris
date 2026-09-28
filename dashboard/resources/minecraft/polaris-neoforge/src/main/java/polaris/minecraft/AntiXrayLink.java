package polaris.minecraft;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import it.unimi.dsi.fastutil.longs.LongOpenHashSet;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayDeque;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import net.minecraft.core.BlockPos;
import net.minecraft.world.level.Level;

/**
 * The anti-xray's line to the Polaris that runs this server: where Polaris buried
 * its X-Ray honeypots (fetched every minute, so they are never hidden), and who
 * dug at ore they could not have seen (sent every few seconds, to the same list
 * the anti-cheat fills on plugin servers).
 *
 * Needs the address, id and token Polaris writes for its login; without them the
 * anti-xray still hides ore, there are just no honeypots to spare and nobody to
 * tell. Nothing here runs on the game thread but queueing a report.
 */
final class AntiXrayLink {
    private static final Duration TIMEOUT = Duration.ofSeconds(10);
    private static final long TRAPS_EVERY_MS = 60_000;
    private static final long FLUSH_EVERY_MS = 5_000;
    /** More than Polaris ever places; a longer list is not from Polaris. */
    private static final int MAX_TRAPS = 4096;
    private static final int QUEUE_MAX = 500;
    /** One report per this many probes, as the plugin's alerts do. */
    private static final int PROBES_PER_REPORT = 3;

    private static volatile LongOpenHashSet[] traps = {new LongOpenHashSet(), new LongOpenHashSet()};
    private static volatile AntiXrayLink instance;

    private final String endpoint;
    private final String token;
    private final HttpClient http = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(5))
            .followRedirects(HttpClient.Redirect.NEVER)
            .build();
    private final ArrayDeque<JsonObject> queue = new ArrayDeque<>();
    private final Map<UUID, Integer> probes = new HashMap<>();

    private AntiXrayLink(PolarisConfig config) {
        this.endpoint = config.baseUrl() + "/api/minecraft/anticheat/" + config.serverId();
        this.token = config.token();
        ScheduledExecutorService worker = Executors.newSingleThreadScheduledExecutor(runnable -> {
            Thread thread = new Thread(runnable, "polaris-antixray");
            thread.setDaemon(true);
            return thread;
        });
        worker.scheduleWithFixedDelay(this::fetchTraps, 3_000, TRAPS_EVERY_MS, TimeUnit.MILLISECONDS);
        worker.scheduleWithFixedDelay(this::flush, FLUSH_EVERY_MS, FLUSH_EVERY_MS, TimeUnit.MILLISECONDS);
    }

    static void start(PolarisConfig config) {
        if (config.state() == PolarisConfig.State.ON) instance = new AntiXrayLink(config);
    }

    static boolean isTrap(Level level, int x, int y, int z) {
        int dimension = AntiXray.trapDimension(level);
        if (dimension < 0) return false;
        LongOpenHashSet set = traps[dimension];
        return !set.isEmpty() && set.contains(BlockPos.asLong(x, y, z));
    }

    /** Somebody dug at buried ore; every few of those is one report. */
    static void probed(String player, UUID uuid, BlockPos pos) {
        AntiXrayLink link = instance;
        if (link == null) return;
        synchronized (link.queue) {
            int count = link.probes.merge(uuid, 1, Integer::sum);
            if (count % PROBES_PER_REPORT != 0) return;
            JsonObject flag = new JsonObject();
            flag.addProperty("player", player);
            flag.addProperty("uuid", uuid.toString());
            flag.addProperty("check", "XRayProbe");
            flag.addProperty("vl", count);
            flag.addProperty("verbose", "x=" + pos.getX() + " y=" + pos.getY() + " z=" + pos.getZ());
            flag.addProperty("at", System.currentTimeMillis());
            if (link.queue.size() >= QUEUE_MAX) link.queue.pollFirst();
            link.queue.addLast(flag);
        }
    }

    private HttpRequest.Builder request() {
        return HttpRequest.newBuilder(URI.create(endpoint))
                .timeout(TIMEOUT)
                .header("Authorization", "Bearer " + token);
    }

    private void fetchTraps() {
        try {
            HttpResponse<String> answer = http.send(request().GET().build(),
                    HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
            if (answer.statusCode() == 200) traps = parse(answer.body());
        } catch (Exception ignored) {
            // The last list stays until Polaris answers again.
        }
    }

    static LongOpenHashSet[] parse(String body) {
        LongOpenHashSet[] next = {new LongOpenHashSet(), new LongOpenHashSet()};
        JsonElement parsed = JsonParser.parseString(body);
        if (!parsed.isJsonObject() || !parsed.getAsJsonObject().has("traps")) return next;
        JsonArray list = parsed.getAsJsonObject().getAsJsonArray("traps");
        for (int i = 0; i < list.size() && i < MAX_TRAPS; i++) {
            JsonArray trap = list.get(i).getAsJsonArray();
            int dimension = trap.get(0).getAsInt();
            if (dimension < 0 || dimension > 1) continue;
            next[dimension].add(BlockPos.asLong(trap.get(1).getAsInt(), trap.get(2).getAsInt(), trap.get(3).getAsInt()));
        }
        return next;
    }

    private void flush() {
        JsonArray flags = new JsonArray();
        synchronized (queue) {
            while (!queue.isEmpty() && flags.size() < 200) flags.add(queue.pollFirst());
        }
        if (flags.isEmpty()) return;
        JsonObject body = new JsonObject();
        body.add("flags", flags);
        try {
            http.send(request()
                            .header("Content-Type", "application/json")
                            .POST(HttpRequest.BodyPublishers.ofString(body.toString(), StandardCharsets.UTF_8))
                            .build(),
                    HttpResponse.BodyHandlers.discarding());
        } catch (Exception unreachable) {
            // A report that did not go is dropped: the next probe says the same.
        }
    }
}
