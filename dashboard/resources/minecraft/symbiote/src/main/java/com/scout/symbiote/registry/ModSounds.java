package com.scout.symbiote.registry;

import net.minecraft.resources.ResourceLocation;
import net.minecraft.core.registries.Registries;
import net.minecraft.sounds.SoundEvent;
import net.neoforged.neoforge.registries.DeferredRegister;
import net.neoforged.neoforge.registries.DeferredHolder;

public final class ModSounds {
   public static final DeferredRegister<SoundEvent> REGISTER = DeferredRegister.create(Registries.SOUND_EVENT, "symbiote");
   public static final DeferredHolder<SoundEvent, SoundEvent> VOICE_UP = reg("voice_up");
   public static final DeferredHolder<SoundEvent, SoundEvent> VOICE_DOWN = reg("voice_down");
   public static final DeferredHolder<SoundEvent, SoundEvent> VOICE_AGGRESSIVE = reg("voice_aggressive");
   public static final DeferredHolder<SoundEvent, SoundEvent> VOICE_WARNING = reg("voice_warning");
   public static final DeferredHolder<SoundEvent, SoundEvent> BOND_ATTACH = reg("bond_attach");
   public static final DeferredHolder<SoundEvent, SoundEvent> TENDRIL_STRIKE = reg("tendril_strike");
   public static final DeferredHolder<SoundEvent, SoundEvent> SLAM_CRUNCH = reg("slam_crunch");
   public static final DeferredHolder<SoundEvent, SoundEvent> ARROW_DEFLECT = reg("arrow_deflect");
   public static final DeferredHolder<SoundEvent, SoundEvent> TENDRIL_ERUPT = reg("tendril_erupt");
   public static final DeferredHolder<SoundEvent, SoundEvent> TENDRIL_EXTEND = reg("tendril_extend");
   public static final DeferredHolder<SoundEvent, SoundEvent> TENDRIL_GRIP = reg("tendril_grip");
   public static final DeferredHolder<SoundEvent, SoundEvent> TENDRIL_RETRACT = reg("tendril_retract");
   public static final DeferredHolder<SoundEvent, SoundEvent> ARMOR_ON = reg("armor_on");
   public static final DeferredHolder<SoundEvent, SoundEvent> ARMOR_OFF = reg("armor_off");
   public static final DeferredHolder<SoundEvent, SoundEvent> OVERRIDE_SEIZURE = reg("override_seizure");
   public static final DeferredHolder<SoundEvent, SoundEvent> HEARTBEAT = reg("heartbeat");
   public static final DeferredHolder<SoundEvent, SoundEvent> REJECTION = reg("rejection");
   public static final DeferredHolder<SoundEvent, SoundEvent> CONSUMPTION = reg("consumption");

   private static DeferredHolder<SoundEvent, SoundEvent> reg(String name) {
      return REGISTER.register(name, () -> SoundEvent.createVariableRangeEvent(ResourceLocation.fromNamespaceAndPath("symbiote", name)));
   }

   private ModSounds() {
   }
}
