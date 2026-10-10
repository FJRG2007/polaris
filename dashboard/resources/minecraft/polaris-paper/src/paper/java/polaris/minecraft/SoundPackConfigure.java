package polaris.minecraft;

import com.destroystokyo.paper.event.player.PlayerConnectionCloseEvent;
import io.papermc.paper.connection.PlayerConfigurationConnection;
import io.papermc.paper.event.connection.configuration.AsyncPlayerConnectionConfigureEvent;
import java.net.URI;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import net.kyori.adventure.resource.ResourcePackInfo;
import net.kyori.adventure.resource.ResourcePackRequest;
import net.kyori.adventure.text.Component;
import org.bukkit.Bukkit;
import org.bukkit.event.EventHandler;
import org.bukkit.event.EventPriority;
import org.bukkit.event.Listener;

/**
 * The sound pack, handed to a player whose game is still connecting (Paper
 * 1.21.7 and later; {@link SoundPack} loads this only there). The configuration
 * phase waits on this event, so the player is held behind the joining screen
 * until their game has answered, and the reload the pack costs happens there
 * instead of once they are in the world. The answer is kept for {@link
 * SoundPack#onJoin}, which then does not send the pack again.
 */
final class SoundPackConfigure implements Listener {
    /** How long a joining player is held for their game's answer before they are
     *  let in anyway: a slow download must not cost them their place. */
    private static final long WAIT_SECONDS = 120;

    private final SoundPack sounds;
    /** Each joining player's answer still awaited, so a player who leaves first
     *  frees the thread holding them instead of keeping it for the full wait. */
    private final Map<UUID, CompletableFuture<String>> waiting = new ConcurrentHashMap<>();

    SoundPackConfigure(SoundPack sounds) {
        this.sounds = sounds;
    }

    @EventHandler
    public void onConfigure(AsyncPlayerConnectionConfigureEvent event) {
        PlayerConfigurationConnection connection = event.getConnection();
        UUID player = connection.getProfile().getId();
        if (player == null) return;
        sounds.joining(player);
        SoundConfig.Pack pack = sounds.current();
        // Somebody already in the game is being reconfigured, not joining: the
        // pack they have stays, and onJoin will not run to read an answer.
        if (pack == null || Bukkit.getPlayer(player) != null) return;
        URI url;
        try {
            url = URI.create(pack.url());
        } catch (IllegalArgumentException unreadable) {
            return; // onJoin hands it out the way it always has
        }
        CompletableFuture<String> answer = new CompletableFuture<>();
        waiting.put(player, answer);
        connection.getAudience().sendResourcePacks(ResourcePackRequest.resourcePackRequest()
                .packs(ResourcePackInfo.resourcePackInfo(pack.id(), url, pack.sha1()))
                // Next to the server's own pack, never in place of it.
                .replace(false)
                .required(SoundPack.requiredOf(pack))
                .prompt(pack.prompt().map(Component::text).orElse(null))
                .callback((id, status, audience) -> {
                    if (pack.id().equals(id) && !status.intermediate()) answer.complete(status.name());
                })
                .build());
        String state = SoundConfig.state(await(answer));
        waiting.remove(player, answer);
        // No final answer (too slow, or gone): onJoin sends it the usual way.
        if (state.equals("pending")) return;
        sounds.answeredWhileJoining(player, pack, state);
        if (state.equals("declined") && pack.required()) connection.disconnect(pack.kick().isEmpty()
                ? Component.translatable("multiplayer.requiredTexturePrompt.disconnect")
                : Component.text(pack.kick()));
    }

    @EventHandler(priority = EventPriority.MONITOR)
    public void onClose(PlayerConnectionCloseEvent event) {
        CompletableFuture<String> answer = waiting.remove(event.getPlayerUniqueId());
        if (answer != null) answer.complete("PENDING");
    }

    /** The game's final answer, or "PENDING" where it gave none in time. */
    private static String await(CompletableFuture<String> answer) {
        try {
            return answer.get(WAIT_SECONDS, TimeUnit.SECONDS);
        } catch (InterruptedException stopped) {
            Thread.currentThread().interrupt();
        } catch (TimeoutException | ExecutionException none) {
            // let them in; the pack follows on arrival
        }
        return "PENDING";
    }
}
