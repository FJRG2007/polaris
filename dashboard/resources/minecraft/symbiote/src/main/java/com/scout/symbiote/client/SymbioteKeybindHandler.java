package com.scout.symbiote.client;

import com.scout.symbiote.network.ModNetwork;
import com.scout.symbiote.network.ServerboundAbilityPacket;
import com.scout.symbiote.network.ServerboundArmAssignPacket;
import com.scout.symbiote.network.ServerboundCommandPacket;
import net.minecraft.client.Minecraft;
import net.minecraft.client.player.ClientInput;
import net.minecraft.world.entity.player.Input;
import net.minecraft.util.Mth;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.phys.Vec3;
import net.neoforged.neoforge.client.event.MovementInputUpdateEvent;
import net.neoforged.neoforge.client.event.InputEvent.MouseScrollingEvent;
import net.neoforged.neoforge.client.event.ClientTickEvent;
import net.neoforged.neoforge.client.event.RenderFrameEvent;
import net.neoforged.bus.api.SubscribeEvent;

public class SymbioteKeybindHandler {
   @SubscribeEvent
   public void onMovementInput(MovementInputUpdateEvent event) {
      if (SymbioteClientState.isBodySeized()) {
         ClientInput input = event.getInput();
         boolean marching = SymbioteClientState.isBodyMarching();
         input.forwardImpulse = marching ? 0.9F : 0.0F;
         input.leftImpulse = 0.0F;
         Minecraft mc = Minecraft.getInstance();
         boolean jumping = marching
            && mc.player != null
            && mc.player.horizontalCollision
            && (mc.player.onGround() || mc.player.isInWater())
            && mc.player.level().noCollision(mc.player, mc.player.getBoundingBox().move(0.0, 1.01, 0.0));
         input.keyPresses = new Input(false, false, false, false, jumping, false, input.keyPresses.sprint());
      }
   }

   @SubscribeEvent
   public void onRenderTick(RenderFrameEvent.Pre event) {
      if (true) {
         Minecraft mc = Minecraft.getInstance();
         if (mc.player != null && mc.level != null && !mc.isPaused()) {
            String preyLock = OverrideFxClient.findActiveWithPrefix("preylock:");
            if (preyLock != null) {
               try {
                  Entity prey = mc.level.getEntity(Integer.parseInt(preyLock.substring(9)));
                  if (prey != null && prey.isAlive()) {
                     double dx = prey.getX() - mc.player.getX();
                     double dz = prey.getZ() - mc.player.getZ();
                     double dy = prey.getY() + prey.getBbHeight() * 0.5 - mc.player.getEyeY();
                     float wantYaw = (float)(Mth.atan2(dz, dx) * (180.0 / Math.PI)) - 90.0F;
                     float wantPitch = (float)(-(Mth.atan2(dy, Math.sqrt(dx * dx + dz * dz)) * (180.0 / Math.PI)));
                     float k = Math.min(1.0F, 0.2F * mc.getDeltaTracker().getGameTimeDeltaTicks());
                     mc.player.setYRot(mc.player.getYRot() + Mth.degreesDifference(mc.player.getYRot(), wantYaw) * k);
                     mc.player.setXRot(Mth.clamp(mc.player.getXRot() + (wantPitch - mc.player.getXRot()) * k, -90.0F, 90.0F));
                     return;
                  }
               } catch (NumberFormatException var22) {
               }
            }

            String deepGrip = OverrideFxClient.findActiveWithPrefix("deepgrip:");
            if (deepGrip != null) {
               try {
                  float wantYaw = Float.parseFloat(deepGrip.split(":")[1]);
                  float k = Math.min(1.0F, 0.18F * mc.getDeltaTracker().getGameTimeDeltaTicks());
                  float yawDiff = Mth.degreesDifference(mc.player.getYRot(), wantYaw);
                  mc.player.setYRot(mc.player.getYRot() + yawDiff * k);
                  mc.player.setXRot(Mth.clamp(mc.player.getXRot() + (78.0F - mc.player.getXRot()) * k, -90.0F, 90.0F));
               } catch (NumberFormatException var20) {
               }
            } else if (SymbioteClientState.isBodySeized()) {
               Vec3 v = mc.player.getDeltaMovement();
               if (!(v.x * v.x + v.z * v.z < 0.004)) {
                  float walkYaw = (float)(Mth.atan2(v.z, v.x) * (180.0 / Math.PI)) - 90.0F;
                  float diff = Mth.degreesDifference(mc.player.getYRot(), walkYaw);
                  float step = diff * Math.min(1.0F, 0.3F * mc.getDeltaTracker().getGameTimeDeltaTicks());
                  mc.player.setYRot(mc.player.getYRot() + step);
               }
            } else {
               float bloom = SymbioteClientState.getBloomProgress(mc.level.getGameTime(), mc.getDeltaTracker().getGameTimeDeltaPartialTick(false));
               if (bloom > 0.01F) {
                  float t = (float)mc.level.getGameTime() + mc.getDeltaTracker().getGameTimeDeltaPartialTick(false);
                  float f = mc.getDeltaTracker().getGameTimeDeltaTicks();
                  float yawDrift = (Mth.sin(t * 0.037F) * 0.9F + Mth.sin(t * 0.011F) * 1.4F) * bloom;
                  float pitchDrift = Mth.sin(t * 0.023F + 1.7F) * 0.7F * bloom;
                  mc.player.setYRot(mc.player.getYRot() + yawDrift * f);
                  mc.player.setXRot(Mth.clamp(mc.player.getXRot() + pitchDrift * f, -85.0F, 85.0F));
               }

               float ft = mc.getDeltaTracker().getGameTimeDeltaTicks();
               String gaze = OverrideFxClient.findActiveWithPrefix("gaze:");
               if (gaze != null) {
                  try {
                     Entity target = mc.level.getEntity(Integer.parseInt(gaze.substring(5)));
                     if (target != null && target.isAlive()) {
                        double dx = target.getX() - mc.player.getX();
                        double dz = target.getZ() - mc.player.getZ();
                        double dy = target.getEyeY() - mc.player.getEyeY();
                        float wantYaw = (float)(Mth.atan2(dz, dx) * (180.0 / Math.PI)) - 90.0F;
                        float yawDiff = Mth.degreesDifference(mc.player.getYRot(), wantYaw);
                        float wantPitch = (float)(-(Mth.atan2(dy, Math.sqrt(dx * dx + dz * dz)) * (180.0 / Math.PI)));
                        float pitchDiff = wantPitch - mc.player.getXRot();
                        float k = Math.min(1.0F, 0.09F * ft);
                        mc.player.setYRot(mc.player.getYRot() + yawDiff * k);
                        mc.player.setXRot(Mth.clamp(mc.player.getXRot() + pitchDiff * k, -90.0F, 90.0F));
                     }
                  } catch (NumberFormatException var21) {
                  }
               }

               if (OverrideFxClient.isActive("ledge_pull")) {
                  float diff = -12.0F - mc.player.getXRot();
                  if (diff < 0.0F) {
                     float k = Math.min(1.0F, 0.06F * ft);
                     mc.player.setXRot(mc.player.getXRot() + diff * k);
                  }
               }
            }
         }
      }
   }

   @SubscribeEvent
   public void onClientTick(ClientTickEvent.Post event) {
      if (true) {
         Minecraft mc = Minecraft.getInstance();
         if (mc.player != null && mc.level != null) {
            String grip = OverrideFxClient.findActiveWithPrefix("deepgrip:");
            if (grip != null) {
               try {
                  String[] parts = grip.split(":");
                  if (parts.length >= 4) {
                     double cx = Double.parseDouble(parts[2]);
                     double cz = Double.parseDouble(parts[3]);
                     double dx = cx - mc.player.getX();
                     double dz = cz - mc.player.getZ();
                     Vec3 dm = mc.player.getDeltaMovement();
                     double lenSq = dx * dx + dz * dz;
                     if (lenSq > 9.0E-4) {
                        double len = Math.sqrt(lenSq);
                        double step = Math.min(len * 0.5, 0.12);
                        mc.player.setDeltaMovement(dx / len * step, dm.y, dz / len * step);
                     } else {
                        mc.player.setDeltaMovement(0.0, dm.y, 0.0);
                     }
                  }
               } catch (NumberFormatException var20) {
               }
            }

            if (!SymbioteClientState.isBonded()) {
               while (SymbioteKeybinds.TENDRIL_YANK.consumeClick()) {
               }

               while (SymbioteKeybinds.WALL_CLING.consumeClick()) {
               }

               while (SymbioteKeybinds.LIVING_ARMOR_TOGGLE.consumeClick()) {
               }

               while (SymbioteKeybinds.FEED.consumeClick()) {
               }

               while (SymbioteKeybinds.RADIAL_MENU.consumeClick()) {
               }

               while (SymbioteKeybinds.TENDRIL_LASH.consumeClick()) {
               }

               while (SymbioteKeybinds.CARAPACE.consumeClick()) {
               }

               while (SymbioteKeybinds.FRENZY.consumeClick()) {
               }

               while (SymbioteKeybinds.APEX.consumeClick()) {
               }

               while (SymbioteKeybinds.CONSUME.consumeClick()) {
               }

               while (SymbioteKeybinds.STRAIN_POWER.consumeClick()) {
               }

               while (SymbioteKeybinds.ARM_ASSIGN.consumeClick()) {
               }

               while (SymbioteKeybinds.ARM_TOGGLE.consumeClick()) {
               }

               while (SymbioteKeybinds.ARM_WALL.consumeClick()) {
               }

               while (SymbioteKeybinds.GRAFT_ASK.consumeClick()) {
               }
            } else {
               while (SymbioteKeybinds.TENDRIL_YANK.consumeClick()) {
                  net.neoforged.neoforge.network.PacketDistributor.sendToServer(new ServerboundAbilityPacket("tendril_yank"));
               }

               while (SymbioteKeybinds.WALL_CLING.consumeClick()) {
                  net.neoforged.neoforge.network.PacketDistributor.sendToServer(new ServerboundAbilityPacket("wall_cling"));
               }

               while (SymbioteKeybinds.LIVING_ARMOR_TOGGLE.consumeClick()) {
                  net.neoforged.neoforge.network.PacketDistributor.sendToServer(new ServerboundAbilityPacket("living_armor_toggle"));
               }

               while (SymbioteKeybinds.FEED.consumeClick()) {
                  net.neoforged.neoforge.network.PacketDistributor.sendToServer(new ServerboundAbilityPacket("feed"));
               }

               while (SymbioteKeybinds.RADIAL_MENU.consumeClick()) {
                  Minecraft.getInstance().setScreen(new RadialMenuScreen());
               }

               while (SymbioteKeybinds.TENDRIL_LASH.consumeClick()) {
                  net.neoforged.neoforge.network.PacketDistributor.sendToServer(new ServerboundAbilityPacket("tendril_lash"));
               }

               while (SymbioteKeybinds.CARAPACE.consumeClick()) {
                  net.neoforged.neoforge.network.PacketDistributor.sendToServer(new ServerboundAbilityPacket("carapace"));
               }

               while (SymbioteKeybinds.FRENZY.consumeClick()) {
                  net.neoforged.neoforge.network.PacketDistributor.sendToServer(new ServerboundAbilityPacket("frenzy"));
               }

               while (SymbioteKeybinds.APEX.consumeClick()) {
                  net.neoforged.neoforge.network.PacketDistributor.sendToServer(new ServerboundAbilityPacket("apex"));
               }

               while (SymbioteKeybinds.CONSUME.consumeClick()) {
                  net.neoforged.neoforge.network.PacketDistributor.sendToServer(new ServerboundAbilityPacket("consume"));
               }

               while (SymbioteKeybinds.STRAIN_POWER.consumeClick()) {
                  net.neoforged.neoforge.network.PacketDistributor.sendToServer(new ServerboundAbilityPacket("strain_power"));
               }

               while (SymbioteKeybinds.ARM_ASSIGN.consumeClick()) {
                  net.neoforged.neoforge.network.PacketDistributor.sendToServer(new ServerboundArmAssignPacket(2));
               }

               while (SymbioteKeybinds.ARM_TOGGLE.consumeClick()) {
                  net.neoforged.neoforge.network.PacketDistributor.sendToServer(new ServerboundArmAssignPacket(1));
               }

               while (SymbioteKeybinds.ARM_WALL.consumeClick()) {
                  net.neoforged.neoforge.network.PacketDistributor.sendToServer(new ServerboundArmAssignPacket(3));
               }

               while (SymbioteKeybinds.GRAFT_ASK.consumeClick()) {
                  if (SymbioteClientState.isGrafted()) {
                     ModNetwork.sendGraft("ask", "");
                  }
               }
            }
         }
      }
   }

   @SubscribeEvent
   public void onMouseScroll(MouseScrollingEvent event) {
   }

   public static void sendCommandPacket(String command) {
      net.neoforged.neoforge.network.PacketDistributor.sendToServer(new ServerboundCommandPacket(command));
   }
}
