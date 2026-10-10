package polaris.minecraft.mixin;

import net.minecraft.server.level.ServerPlayer;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.ModifyVariable;
import polaris.minecraft.EventRespawn;

/**
 * A respawn an event sends elsewhere never spends a charge of the player's
 * respawn anchor.
 *
 * `PlayerList.respawn` resolves the player's own spawn, taking a charge from a
 * charged anchor, before NeoForge's `PlayerRespawnPositionEvent` lets
 * `EventRespawn` move the respawn onto the arena's spot. For a player that
 * event will redirect, the spawn is resolved without using the charge, so the
 * anchor holds as many as it did before they died in the arena.
 */
@Mixin(ServerPlayer.class)
public abstract class RespawnChargeMixin {
    @ModifyVariable(method = "findRespawnPositionAndUseSpawnBlock", at = @At("HEAD"), argsOnly = true)
    private boolean polaris$keepCharge(boolean useCharge) {
        return useCharge && !EventRespawn.redirects((ServerPlayer) (Object) this);
    }
}
