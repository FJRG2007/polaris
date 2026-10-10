package com.scout.symbiote.network;

import net.minecraft.network.codec.StreamCodec;
import net.minecraft.network.protocol.common.custom.CustomPacketPayload;
import net.minecraft.resources.ResourceLocation;
import net.neoforged.neoforge.network.handling.IPayloadContext;
import net.minecraft.server.level.ServerPlayer;
import com.scout.symbiote.ability.SymbioteArmsController;
import com.scout.symbiote.tracker.SymbioteProfile;
import com.scout.symbiote.tracker.SymbioteTracker;
import com.scout.symbiote.util.SymbioteLog;
import com.scout.symbiote.voice.VoiceLines;
import java.util.function.Supplier;
import net.minecraft.core.BlockPos;
import net.minecraft.network.FriendlyByteBuf;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.level.block.state.BlockState;

public class ServerboundArmActionPacket implements CustomPacketPayload {
   public static final CustomPacketPayload.Type<ServerboundArmActionPacket> TYPE = new CustomPacketPayload.Type<>(ResourceLocation.fromNamespaceAndPath("symbiote", "serverbound_arm_action_packet"));
   public static final StreamCodec<FriendlyByteBuf, ServerboundArmActionPacket> STREAM_CODEC = StreamCodec.of((buf, pkt) -> encode(pkt, buf), ServerboundArmActionPacket::decode);

   @Override
   public CustomPacketPayload.Type<ServerboundArmActionPacket> type() {
      return TYPE;
   }

   private final boolean mining;
   private final int entityId;
   private final BlockPos block;

   public ServerboundArmActionPacket(boolean mining, int entityId, BlockPos block) {
      this.mining = mining;
      this.entityId = entityId;
      this.block = block;
   }

   public static ServerboundArmActionPacket melee(int entityId) {
      return new ServerboundArmActionPacket(false, entityId, null);
   }

   public static ServerboundArmActionPacket mining(BlockPos pos) {
      return new ServerboundArmActionPacket(true, -1, pos);
   }

   public static void encode(ServerboundArmActionPacket pkt, FriendlyByteBuf buf) {
      buf.writeBoolean(pkt.mining);
      buf.writeVarInt(pkt.entityId);
      buf.writeBoolean(pkt.block != null);
      if (pkt.block != null) {
         buf.writeBlockPos(pkt.block);
      }
   }

   public static ServerboundArmActionPacket decode(FriendlyByteBuf buf) {
      boolean mining = buf.readBoolean();
      int entityId = buf.readVarInt();
      BlockPos block = buf.readBoolean() ? buf.readBlockPos() : null;
      return new ServerboundArmActionPacket(mining, entityId, block);
   }

   public static void handle(ServerboundArmActionPacket pkt, IPayloadContext ctx) {
      ctx.enqueueWork(() -> {
         ServerPlayer player = (ServerPlayer)ctx.player();
         if (player != null) {
            ServerLevel level = player.serverLevel();
            SymbioteProfile p = SymbioteTracker.get(level).peek(player.getUUID());
            if (p != null && p.stage.isBonded()) {
               if (p.isDormant(level.getGameTime())) {
                  SymbioteLog.event("ABILITY_REJECTED ability=arm_overreach player={} reason=dormant", player.getUUID());
                  VoiceLines.send(player, "symbiote.voice.dormant", 2);
               } else if (!SymbioteArmsController.isBusy(player.getUUID())) {
                  if (pkt.mining && pkt.block != null) {
                     BlockState state = level.getBlockState(pkt.block);
                     if (state.isAir()) {
                        return;
                     }

                     int slot = SymbioteArmsController.pickToolSlot(p, state);
                     if (slot < 0) {
                        return;
                     }

                     SymbioteArmsController.beginMining(player, p, slot, pkt.block);
                  } else if (!pkt.mining && pkt.entityId >= 0) {
                     if (!(level.getEntity(pkt.entityId) instanceof LivingEntity target) || target == player) {
                        return;
                     }

                     int slot = SymbioteArmsController.pickWeaponSlot(p);
                     if (slot < 0) {
                        return;
                     }

                     SymbioteArmsController.beginMelee(player, p, slot, target);
                  }

                  ModNetwork.syncToPlayer(level, player);
               }
            }
         }
      });
   }
}
