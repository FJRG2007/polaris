package com.scout.symbiote.event;

import net.minecraft.resources.ResourceLocation;
import com.scout.symbiote.tracker.SymbioteProfile;
import com.scout.symbiote.tracker.SymbioteTracker;
import java.util.UUID;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.entity.ai.attributes.Attribute;
import net.minecraft.world.entity.ai.attributes.AttributeInstance;
import net.minecraft.world.entity.ai.attributes.AttributeModifier;
import net.minecraft.world.entity.ai.attributes.Attributes;
import net.minecraft.world.entity.ai.attributes.AttributeModifier.Operation;
import net.neoforged.neoforge.common.NeoForgeMod;
import net.neoforged.neoforge.event.tick.PlayerTickEvent;
import net.neoforged.bus.api.SubscribeEvent;
import net.neoforged.fml.common.EventBusSubscriber;

@EventBusSubscriber(modid = "symbiote")
public final class LivingArmorSpeedHandler {
   private static final UUID SPEED_ID = UUID.fromString("b8d2f3a1-0c4e-4a77-9f21-7c2a9d3e5101");
   private static final UUID STEP_ID = UUID.fromString("b8d2f3a1-0c4e-4a77-9f21-7c2a9d3e5102");

   @SubscribeEvent
   public static void onPlayerTick(PlayerTickEvent.Post event) {
      if (true) {
         if (event.getEntity() instanceof ServerPlayer player) {
            boolean var3 = isArmorActive(player);
            reconcile(player.getAttribute(Attributes.MOVEMENT_SPEED), SPEED_ID, "symbiote_armor_speed", 0.25, Operation.ADD_MULTIPLIED_TOTAL, var3);
            reconcile(player.getAttribute(Attributes.STEP_HEIGHT), STEP_ID, "symbiote_armor_step", 0.6, Operation.ADD_VALUE, var3);
         }
      }
   }

   private static boolean isArmorActive(ServerPlayer player) {
      SymbioteProfile p = SymbioteTracker.get(player.serverLevel()).peek(player.getUUID());
      return p != null && p.stage.isBonded() && p.livingArmorActive;
   }

   private static void reconcile(AttributeInstance inst, UUID id, String name, double amount, Operation op, boolean active) {
      if (inst != null) {
         ResourceLocation key = ResourceLocation.fromNamespaceAndPath("symbiote", name);
         AttributeModifier existing = inst.getModifier(key);
         if (active && existing == null) {
            inst.addTransientModifier(new AttributeModifier(key, amount, op));
         } else if (!active && existing != null) {
            inst.removeModifier(key);
         }
      }
   }

   private LivingArmorSpeedHandler() {
   }
}
