package com.scout.symbiote.network;

import net.minecraft.network.codec.StreamCodec;
import net.minecraft.network.protocol.common.custom.CustomPacketPayload;
import net.minecraft.resources.ResourceLocation;
import net.neoforged.neoforge.network.handling.IPayloadContext;
import net.minecraft.server.level.ServerPlayer;
import com.scout.symbiote.ability.GraftMorphs;
import com.scout.symbiote.ability.TendrilMantle;
import com.scout.symbiote.tracker.SymbioteProfile;
import com.scout.symbiote.tracker.SymbioteTracker;
import java.util.function.Supplier;
import net.minecraft.network.FriendlyByteBuf;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;

public class ServerboundGraftPacket implements CustomPacketPayload {
   public static final CustomPacketPayload.Type<ServerboundGraftPacket> TYPE = new CustomPacketPayload.Type<>(ResourceLocation.fromNamespaceAndPath("symbiote", "serverbound_graft_packet"));
   public static final StreamCodec<FriendlyByteBuf, ServerboundGraftPacket> STREAM_CODEC = StreamCodec.of((buf, pkt) -> encode(pkt, buf), ServerboundGraftPacket::decode);

   @Override
   public CustomPacketPayload.Type<ServerboundGraftPacket> type() {
      return TYPE;
   }

   private final String action;
   private final String arg;

   public ServerboundGraftPacket(String action, String arg) {
      this.action = action;
      this.arg = arg;
   }

   public static void encode(ServerboundGraftPacket pkt, FriendlyByteBuf buf) {
      buf.writeUtf(pkt.action);
      buf.writeUtf(pkt.arg, 64);
   }

   public static ServerboundGraftPacket decode(FriendlyByteBuf buf) {
      return new ServerboundGraftPacket(buf.readUtf(), buf.readUtf(64));
   }

   public static void handle(ServerboundGraftPacket pkt, IPayloadContext ctx) {
      ctx.enqueueWork(() -> {
         ServerPlayer player = (ServerPlayer)ctx.player();
         if (player != null) {
            ServerLevel level = player.serverLevel();
            SymbioteProfile p = SymbioteTracker.get(level).peek(player.getUUID());
            if (p != null && p.stage.isBonded()) {
               if ("ask".equals(pkt.action)) {
                  GraftMorphs.request(player, level, p);
               } else if ("mantle".equals(pkt.action)) {
                  TendrilMantle.ensureUp(player, level, p, 24000);
               } else if ("mantle_off".equals(pkt.action)) {
                  TendrilMantle.dismiss(player, level);
               }
            }
         }
      });
   }
}
