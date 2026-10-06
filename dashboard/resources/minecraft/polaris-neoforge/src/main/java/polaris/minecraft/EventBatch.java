package polaris.minecraft;

import com.google.gson.JsonObject;
import java.util.ArrayDeque;
import java.util.Deque;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.Map;
import net.minecraft.commands.CommandSource;
import net.minecraft.commands.CommandSourceStack;
import net.minecraft.network.chat.Component;
import net.minecraft.nbt.CompoundTag;
import net.minecraft.nbt.ListTag;
import net.minecraft.nbt.Tag;
import net.minecraft.resources.ResourceLocation;
import net.minecraft.server.MinecraftServer;

/**
 * A list of commands run inside the server, paced so building never freezes it.
 *
 * The dashboard appends each command to command storage
 * ({@code data modify storage polaris:batch <key> append value "..."}) and starts
 * it with {@code polaris batch run <key>}, all in one trip. The commands run in
 * order, as many each tick as fit under two limits: a number of blocks changed
 * (a fill or clone counts its volume, a place a fixed share, a setblock one) and
 * a slice of the tick's time. What does not fit carries on next tick. A fill
 * larger than one tick's blocks is cut into boxes that each fit - only the fills
 * whose meaning survives the cut (replace, keep, destroy; never hollow or
 * outline). The one heavy command a tick always runs, so nothing waits forever.
 * The first commands run at the end of the tick the batch was started in.
 *
 * Runs on the server thread only.
 */
final class EventBatch {
    static final ResourceLocation STORAGE = ResourceLocation.fromNamespaceAndPath("polaris", "batch");
    static final int DEFAULT_BLOCKS_PER_TICK = 8192;
    /** What a {@code place} (a template, a structure, a feature) is counted as. */
    private static final int PLACE_WEIGHT = 4096;
    /** The share of a 50 ms tick the batches may take, all of them together. */
    private static final long TICK_BUDGET_NANOS = 15_000_000L;
    private static final int FINISHED_KEPT = 64;

    private static final class Job {
        final String key;
        final Deque<String> pending;
        final int total;
        final int blocksPerTick;
        int ran;
        int failed;
        int ticks;
        long blocks;
        long longestNanos;
        boolean cancelled;

        Job(String key, Deque<String> pending, int blocksPerTick) {
            this.key = key;
            this.pending = pending;
            this.total = pending.size();
            this.blocksPerTick = blocksPerTick;
        }

        boolean done() {
            return pending.isEmpty();
        }
    }

    /** Running and recently finished, oldest first. */
    private static final Map<String, Job> jobs = new LinkedHashMap<>();

    private EventBatch() {}

    static JsonObject run(MinecraftServer server, String key, int blocksPerTick) {
        Job existing = jobs.get(key);
        if (existing != null && !existing.done()) return status(existing);
        CompoundTag store = server.getCommandStorage().get(STORAGE);
        if (!store.contains(key, Tag.TAG_LIST)) {
            if (existing != null) return status(existing);
            JsonObject reply = new JsonObject();
            reply.addProperty("ok", false);
            reply.addProperty("key", key);
            reply.addProperty("why", "empty");
            return reply;
        }
        ListTag list = store.getList(key, Tag.TAG_STRING);
        Deque<String> pending = new ArrayDeque<>(list.size());
        for (int i = 0; i < list.size(); i++) expand(list.getString(i), blocksPerTick, pending);
        store.remove(key);
        server.getCommandStorage().set(STORAGE, store);
        Job job = new Job(key, pending, blocksPerTick);
        jobs.remove(key);
        jobs.put(key, job);
        forgetOld();
        // Started at the end of this tick, not inside this command: a command
        // run from inside another is only queued behind it by the game, so
        // neither its blocks nor its time could be counted here.
        return status(job);
    }

    static JsonObject status(MinecraftServer server, String key) {
        Job job = jobs.get(key);
        if (job != null) return status(job);
        JsonObject reply = new JsonObject();
        reply.addProperty("ok", false);
        reply.addProperty("key", key);
        reply.addProperty("why", "unknown");
        return reply;
    }

    static JsonObject cancel(MinecraftServer server, String key) {
        Job job = jobs.get(key);
        if (job == null) return status(server, key);
        job.cancelled = !job.pending.isEmpty();
        job.pending.clear();
        return status(job);
    }

    /** Every tick: the batches still running, in the order they were started. */
    static void tick(MinecraftServer server) {
        if (jobs.isEmpty()) return;
        long start = System.nanoTime();
        for (Job job : jobs.values()) {
            if (job.done()) continue;
            if (System.nanoTime() - start > TICK_BUDGET_NANOS) break;
            step(server, job, start);
        }
    }

    /** Hears only what a command says when it fails, and tells nobody else. */
    private static final class FailureEar implements CommandSource {
        boolean failed;

        @Override
        public void sendSystemMessage(Component message) {
            failed = true;
        }

        @Override
        public boolean acceptsSuccess() {
            return false;
        }

        @Override
        public boolean acceptsFailure() {
            return true;
        }

        @Override
        public boolean shouldInformAdmins() {
            return false;
        }
    }

    private static void step(MinecraftServer server, Job job, long start) {
        long began = System.nanoTime();
        FailureEar ear = new FailureEar();
        CommandSourceStack source = server.createCommandSourceStack().withSource(ear);
        long blocks = 0;
        int ran = 0;
        while (!job.pending.isEmpty()) {
            String command = job.pending.peekFirst();
            int weight = weight(command);
            if (ran > 0 && (blocks + weight > job.blocksPerTick || System.nanoTime() - start > TICK_BUDGET_NANOS)) break;
            job.pending.pollFirst();
            ear.failed = false;
            server.getCommands().performPrefixedCommand(source, command);
            if (ear.failed) job.failed++;
            job.ran++;
            ran++;
            blocks += weight;
        }
        job.blocks += blocks;
        job.ticks++;
        job.longestNanos = Math.max(job.longestNanos, System.nanoTime() - began);
    }

    private static void forgetOld() {
        int finished = 0;
        for (Job job : jobs.values()) if (job.done()) finished++;
        Iterator<Job> each = jobs.values().iterator();
        while (finished > FINISHED_KEPT && each.hasNext()) {
            if (each.next().done()) {
                each.remove();
                finished--;
            }
        }
    }

    private static JsonObject status(Job job) {
        JsonObject reply = new JsonObject();
        reply.addProperty("ok", true);
        reply.addProperty("key", job.key);
        reply.addProperty("done", job.done());
        reply.addProperty("cancelled", job.cancelled);
        reply.addProperty("total", job.total);
        reply.addProperty("ran", job.ran);
        reply.addProperty("failed", job.failed);
        reply.addProperty("ticks", job.ticks);
        reply.addProperty("blocks", job.blocks);
        reply.addProperty("longestTickMs", Math.round(job.longestNanos / 100_000.0) / 10.0);
        return reply;
    }

    // ------------------------------------------------------------------ weighing

    /** The command a line finally runs: past any {@code execute ... run}. */
    static String innermost(String command) {
        String line = command.startsWith("/") ? command.substring(1) : command;
        if (!line.startsWith("execute ")) return line;
        int run = line.lastIndexOf(" run ");
        return run < 0 ? line : line.substring(run + 5);
    }

    /** How many blocks a command changes, as far as can be told from its text. */
    static int weight(String command) {
        String line = innermost(command);
        if (line.startsWith("fill ") || line.startsWith("clone ")) {
            long[] box = box(line.split(" +"));
            return box == null ? PLACE_WEIGHT : (int) Math.min(Integer.MAX_VALUE, volume(box));
        }
        if (line.startsWith("place ")) return PLACE_WEIGHT;
        if (line.startsWith("setblock ")) return 1;
        return 0;
    }

    /** The six whole coordinates after the command's name; null for any relative one. */
    private static long[] box(String[] words) {
        if (words.length < 7) return null;
        long[] box = new long[6];
        for (int i = 0; i < 6; i++) {
            try {
                box[i] = Long.parseLong(words[i + 1]);
            } catch (NumberFormatException relative) {
                return null;
            }
        }
        return box;
    }

    private static long volume(long[] box) {
        return (Math.abs(box[3] - box[0]) + 1) * (Math.abs(box[4] - box[1]) + 1) * (Math.abs(box[5] - box[2]) + 1);
    }

    /** A fill too large for one tick, cut into boxes that each fit; anything else as it is. */
    static void expand(String command, int cap, Deque<String> out) {
        String line = command.startsWith("/") ? command.substring(1) : command;
        String[] words = line.split(" +");
        long[] box = line.startsWith("fill ") ? box(words) : null;
        if (box == null || words.length < 8 || volume(box) <= cap) {
            out.add(command);
            return;
        }
        String mode = words.length > 8 ? words[8] : "replace";
        if (!mode.equals("replace") && !mode.equals("keep") && !mode.equals("destroy")) {
            out.add(command);
            return;
        }
        StringBuilder rest = new StringBuilder();
        for (int i = 7; i < words.length; i++) rest.append(' ').append(words[i]);
        cut(new long[] {
            Math.min(box[0], box[3]), Math.min(box[1], box[4]), Math.min(box[2], box[5]),
            Math.max(box[0], box[3]), Math.max(box[1], box[4]), Math.max(box[2], box[5])
        }, rest.toString(), cap, out);
    }

    private static void cut(long[] box, String rest, int cap, Deque<String> out) {
        if (volume(box) <= cap) {
            out.add("fill " + box[0] + " " + box[1] + " " + box[2] + " " + box[3] + " " + box[4] + " " + box[5] + rest);
            return;
        }
        int axis = 0;
        for (int i = 1; i < 3; i++) if (box[i + 3] - box[i] > box[axis + 3] - box[axis]) axis = i;
        long middle = (box[axis] + box[axis + 3]) / 2;
        long[] low = box.clone();
        long[] high = box.clone();
        low[axis + 3] = middle;
        high[axis] = middle + 1;
        cut(low, rest, cap, out);
        cut(high, rest, cap, out);
    }
}
