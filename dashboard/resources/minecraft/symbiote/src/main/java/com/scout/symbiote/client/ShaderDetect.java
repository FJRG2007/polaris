package com.scout.symbiote.client;

import java.lang.reflect.Method;

public final class ShaderDetect {
   private static boolean resolved;
   private static Object irisApi;
   private static Method inUse;

   public static boolean shadersActive() {
      if (!resolved) {
         resolved = true;

         try {
            Class<?> api = Class.forName("net.irisshaders.iris.api.v0.IrisApi");
            irisApi = api.getMethod("getInstance").invoke(null);
            inUse = api.getMethod("isShaderPackInUse");
         } catch (Throwable var2) {
         }
      }

      if (inUse == null) {
         return false;
      }

      try {
         return (Boolean)inUse.invoke(irisApi);
      } catch (Throwable t) {
         return false;
      }
   }

   private ShaderDetect() {
   }
}
