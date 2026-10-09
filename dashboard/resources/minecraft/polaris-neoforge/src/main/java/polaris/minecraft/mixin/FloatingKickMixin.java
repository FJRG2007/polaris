package polaris.minecraft.mixin;

import java.util.Set;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.server.network.ServerGamePacketListenerImpl;
import net.minecraft.world.entity.Entity;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

/**
 * A player inside an event arena is never kicked for floating.
 *
 * With `allow-flight=false` the game disconnects anybody who spends more than
 * `getMaximumFlyingTicks` in the air without gliding ("Flying is not enabled on
 * this server", logged as "kicked for floating too long"). An event puts people
 * in the air on purpose - a dropper's slow fall, a racer put back behind their
 * last ring, a teleport the client has not answered yet - and every one of those
 * was a kick. Switching `allow-flight` on would end that for the whole server,
 * and on NeoForge this check is the only thing that stops a flying client.
 *
 * So the exemption is narrow: only a player carrying one of the two arena tags,
 * which an event adds on the way in and takes off on every way out (`IN_ARENA`
 * in the dashboard's `events/kinds/stage.ts` for stages, and in
 * `events/kinds/arena.ts` for PvP arenas, capture the flag, hide and seek and
 * king of the hill). Everybody else keeps the game's rule. The same method is
 * asked about vehicles, which are left alone.
 */
@Mixin(ServerGamePacketListenerImpl.class)
public abstract class FloatingKickMixin {
    /** `IN_ARENA` in `events/kinds/stage.ts`. */
    private static final String IN_STAGE = "pe_in";
    /** `IN_ARENA` in `events/kinds/arena.ts`. */
    private static final String IN_ARENA = "pe_arena";

    @Inject(method = "getMaximumFlyingTicks", at = @At("HEAD"), cancellable = true)
    private void polaris$eventAir(Entity entity, CallbackInfoReturnable<Integer> answer) {
        if (!(entity instanceof ServerPlayer)) return;
        Set<String> tags = entity.getTags();
        if (tags.contains(IN_STAGE) || tags.contains(IN_ARENA)) {
            answer.setReturnValue(Integer.MAX_VALUE);
        }
    }
}
