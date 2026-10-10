package com.scout.symbiote.network;

import net.minecraft.network.codec.StreamCodec;
import net.minecraft.network.protocol.common.custom.CustomPacketPayload;
import net.minecraft.resources.ResourceLocation;
import net.neoforged.neoforge.network.handling.IPayloadContext;
import net.minecraft.server.level.ServerPlayer;
import com.scout.symbiote.client.ArmorStateClientCache;
import com.scout.symbiote.client.armor.LivingArmorClientSizing;
import java.util.UUID;
import java.util.function.Supplier;
import net.minecraft.network.FriendlyByteBuf;

public class ClientboundLivingArmorStatePacket implements CustomPacketPayload {
   public static final CustomPacketPayload.Type<ClientboundLivingArmorStatePacket> TYPE = new CustomPacketPayload.Type<>(ResourceLocation.fromNamespaceAndPath("symbiote", "clientbound_living_armor_state_packet"));
   public static final StreamCodec<FriendlyByteBuf, ClientboundLivingArmorStatePacket> STREAM_CODEC = StreamCodec.of((buf, pkt) -> encode(pkt, buf), ClientboundLivingArmorStatePacket::decode);

   @Override
   public CustomPacketPayload.Type<ClientboundLivingArmorStatePacket> type() {
      return TYPE;
   }

   private final UUID playerId;
   private final boolean active;
   private final boolean coversGear;
   private final int strainOrdinal;

   public ClientboundLivingArmorStatePacket(UUID playerId, boolean active, boolean coversGear, int strainOrdinal) {
      this.playerId = playerId;
      this.active = active;
      this.coversGear = coversGear;
      this.strainOrdinal = strainOrdinal;
   }

   public static void encode(ClientboundLivingArmorStatePacket pkt, FriendlyByteBuf buf) {
      buf.writeUUID(pkt.playerId);
      buf.writeBoolean(pkt.active);
      buf.writeBoolean(pkt.coversGear);
      buf.writeByte(pkt.strainOrdinal);
   }

   public static ClientboundLivingArmorStatePacket decode(FriendlyByteBuf buf) {
      return new ClientboundLivingArmorStatePacket(buf.readUUID(), buf.readBoolean(), buf.readBoolean(), buf.readByte());
   }

   public static void handle(ClientboundLivingArmorStatePacket pkt, IPayloadContext ctx) {
      ctx.enqueueWork(() -> {
         ArmorStateClientCache.set(pkt.playerId, pkt.active, pkt.coversGear, pkt.strainOrdinal);
         LivingArmorClientSizing.refreshPlayerDimensions(pkt.playerId);
      });
   }
}
