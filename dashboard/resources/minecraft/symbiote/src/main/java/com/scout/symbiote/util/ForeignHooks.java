package com.scout.symbiote.util;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import org.spongepowered.asm.mixin.Mixins;
import org.spongepowered.asm.mixin.extensibility.IMixinConfig;
import org.spongepowered.asm.mixin.transformer.Config;

public final class ForeignHooks {
   public static final boolean VAULTED = true;
   public static ForeignHooks.Response RESPONSE = ForeignHooks.Response.REFUSE;
   private static final String OURS = "com.scout.symbiote.";
   private static List<ForeignHooks.Hook> found;
   private static final String[] KNOWN_ADDON_CLASSES = new String[]{
      "com.rpgemperor.symbiotetweaks.SymbioteTweaks", "com.rpgemperor.symbiotetweaks.TweaksConfig", "com.rpgemperor.symbiotetweaks.blob.BlobControl"
   };

   public static List<String> presentAddons() {
      List<String> present = new ArrayList<>();

      for (String name : KNOWN_ADDON_CLASSES) {
         try {
            Class.forName(name, false, ForeignHooks.class.getClassLoader());
            present.add(name);
         } catch (Throwable var6) {
         }
      }

      return present;
   }

   public static synchronized List<ForeignHooks.Hook> scan() {
      if (found != null) {
         return found;
      }

      List<ForeignHooks.Hook> hooks = new ArrayList<>();

      try {
         for (Config config : Mixins.getConfigs()) {
            IMixinConfig inner = config.getConfig();
            if (inner != null) {
               String pkg = inner.getMixinPackage();
               if (pkg == null || !pkg.startsWith("com.scout.symbiote.")) {
                  Set<String> targets = inner.getTargets();
                  if (targets != null && !targets.isEmpty()) {
                     List<String> mine = new ArrayList<>(
                        new LinkedHashSet<>(targets.stream().map(t -> t.replace('/', '.')).filter(t -> t.startsWith("com.scout.symbiote.")).sorted().toList())
                     );
                     if (!mine.isEmpty()) {
                        hooks.add(new ForeignHooks.Hook(config.getName(), pkg, mine));
                     }
                  }
               }
            }
         }
      } catch (Throwable t) {
         SymbioteLog.event("FOREIGN_HOOK_SCAN_FAILED reason={}", t.toString());
         found = List.of();
         return found;
      }

      found = List.copyOf(hooks);
      return found;
   }

   public static void enforce() {
      List<ForeignHooks.Hook> hooks = scan();
      List<String> addons = presentAddons();
      if (hooks.isEmpty() && addons.isEmpty()) {
         SymbioteLog.event("FOREIGN_HOOKS none");
      } else {
         for (ForeignHooks.Hook h : hooks) {
            SymbioteLog.event(
               "FOREIGN_HOOK config={} package={} targets={} classes={}", h.config(), h.mixinPackage(), h.targets().size(), String.join(",", h.targets())
            );
         }

         for (String a : addons) {
            SymbioteLog.event("FOREIGN_ADDON class={}", a);
         }
      }
   }

   public static String playerWarning() {
      return null;
   }

   private ForeignHooks() {
   }

   public record Hook(String config, String mixinPackage, List<String> targets) {
      public String describe() {
         return this.config
            + " rewrites "
            + this.targets.size()
            + " of our classes, including "
            + String.join(", ", this.targets.subList(0, Math.min(3, this.targets.size())));
      }
   }

   public enum Response {
      LOG,
      WARN,
      REFUSE;
   }
}
