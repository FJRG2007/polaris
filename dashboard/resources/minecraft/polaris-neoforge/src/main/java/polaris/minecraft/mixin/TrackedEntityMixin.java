package polaris.minecraft.mixin;

import java.util.Set;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.server.network.ServerPlayerConnection;
import net.minecraft.world.entity.Entity;
import org.spongepowered.asm.mixin.Final;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.Shadow;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;
import polaris.minecraft.EventSeek;

/** A hider a seeker cannot see is not tracked by them (see {@link EventSeek}). */
@Mixin(targets = "net.minecraft.server.level.ChunkMap$TrackedEntity")
public abstract class TrackedEntityMixin implements EventSeek.SeekTracker {
    @Shadow @Final Entity entity;
    @Shadow @Final private Set<ServerPlayerConnection> seenBy;

    @Shadow
    public abstract void removePlayer(ServerPlayer player);

    @Shadow
    public abstract void updatePlayer(ServerPlayer player);

    @Inject(method = "updatePlayer", at = @At("HEAD"), cancellable = true)
    private void polaris$conceal(ServerPlayer player, CallbackInfo info) {
        // Never in the game's way: anything unexpected leaves tracking as it was.
        try {
            if (!EventSeek.conceals(entity, player)) return;
            if (seenBy.contains(player.connection)) removePlayer(player);
            EventSeek.heldBack(entity, player);
            info.cancel();
        } catch (RuntimeException unexpected) {
            // Tracked as the game would have.
        }
    }

    @Override
    public void polaris$refresh(ServerPlayer viewer) {
        updatePlayer(viewer);
    }
}
