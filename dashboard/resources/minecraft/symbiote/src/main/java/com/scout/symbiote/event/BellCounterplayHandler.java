package com.scout.symbiote.event;

import com.scout.symbiote.config.SymbioteConfig;
import com.scout.symbiote.entity.TendrilFxEntity;
import com.scout.symbiote.network.ModNetwork;
import com.scout.symbiote.tracker.SymbioteProfile;
import com.scout.symbiote.tracker.SymbioteTracker;
import com.scout.symbiote.util.SymbioteLog;
import com.scout.symbiote.voice.VoiceLines;
import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.util.RandomSource;
import net.minecraft.world.level.block.BellBlock;
import net.minecraft.world.level.gameevent.GameEvent;
import net.minecraft.world.phys.Vec3;
import net.neoforged.neoforge.event.VanillaGameEvent;
import net.neoforged.bus.api.SubscribeEvent;
import net.neoforged.fml.common.EventBusSubscriber;

@EventBusSubscriber(modid = "symbiote")
public final class BellCounterplayHandler {
   @SubscribeEvent
   public static void onVanillaGameEvent(VanillaGameEvent event) {
      if (event.getVanillaEvent() == GameEvent.BLOCK_CHANGE) {
         if (event.getLevel() instanceof ServerLevel level) {
            Vec3 pos = event.getEventPosition();
            BlockPos bellPos = BlockPos.containing(pos);
            if (level.getBlockState(bellPos).getBlock() instanceof BellBlock) {
               double radius = SymbioteConfig.BELL_STUN_RADIUS.get();
               double radiusSq = radius * radius;
               long now = level.getGameTime();
               long stunTicks = SymbioteConfig.BELL_STUN_SECONDS.get().intValue() * 20L;
               int stress = SymbioteConfig.BELL_STRESS.get();
               SymbioteTracker tracker = SymbioteTracker.get(level);

               for (ServerPlayer player : level.players()) {
                  if (!(player.distanceToSqr(pos) > radiusSq)) {
                     SymbioteProfile p = tracker.peek(player.getUUID());
                     if (p != null && p.stage.isBonded()) {
                        long stunUntil = now + stunTicks;
                        if (stunUntil > p.dormantUntilTick) {
                           p.dormantUntilTick = stunUntil;
                        }

                        boolean armorDropped = p.livingArmorActive;
                        p.livingArmorActive = false;
                        if (armorDropped) {
                           player.refreshDimensions();
                        }

                        tracker.setDirty();
                        SymbioteLog.event(
                           "BELL_STUN player={} bell={} until={} stress=+{} armor_dropped={}", player.getUUID(), bellPos, stunUntil, stress, armorDropped
                        );
                        SymbioteTracker.adjustStress(level, player, stress, "stress_bell");
                        ModNetwork.syncToPlayer(level, player);
                        if (armorDropped) {
                           ModNetwork.broadcastLivingArmorState(player, false);
                        }

                        VoiceLines.send(player, "symbiote.voice.bell_stun", 4);
                        ModNetwork.sendOverrideFx(player, "bell_stun", (int)stunTicks);
                        RandomSource random = level.random;
                        int count = 5 + random.nextInt(3);
                        Vec3 chest = player.position().add(0.0, 1.0, 0.0);

                        for (int i = 0; i < count; i++) {
                           double yaw = random.nextDouble() * Math.PI * 2.0;
                           double pitch = random.nextDouble() * 1.4 - 0.4;
                           double dist = 2.0 + random.nextDouble() * 2.5;
                           double cosP = Math.cos(pitch);
                           Vec3 tip = chest.add(Math.cos(yaw) * cosP * dist, Math.sin(pitch) * dist, Math.sin(yaw) * cosP * dist);
                           TendrilFxEntity fx = TendrilFxEntity.spawnGrabAtPoint(level, player, tip, 16 + random.nextInt(15), p.strain);
                           fx.setReachTicksOverride(2 + random.nextInt(3));
                           fx.setArc(0.3F + random.nextFloat() * 0.5F, (float)(random.nextDouble() * Math.PI * 2.0));
                        }
                     }
                  }
               }
            }
         }
      }
   }

   private BellCounterplayHandler() {
   }
}
