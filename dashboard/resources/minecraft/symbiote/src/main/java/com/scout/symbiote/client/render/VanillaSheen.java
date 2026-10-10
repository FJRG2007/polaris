package com.scout.symbiote.client.render;

import net.minecraft.util.ARGB;
import com.mojang.blaze3d.vertex.VertexConsumer;
import java.lang.reflect.Method;
import net.minecraft.client.renderer.LightTexture;
import net.minecraft.world.phys.Vec3;
import org.joml.Matrix3f;
import org.joml.Matrix4f;
import org.joml.Vector3f;

public final class VanillaSheen {
   public static final float TENDRIL_STRENGTH = 0.42F;
   public static final float TENDRIL_EXP = 9.0F;
   public static final float ARMOR_STRENGTH = 0.5F;
   public static final float ARMOR_EXP = 15.0F;
   public static float GLINT_STRENGTH = 0.55F;
   public static float GLINT_EXP = 30.0F;
   public static float GLINT_CHAOS = 0.75F;
   public static final float KEY_X;
   public static final float KEY_Y;
   public static final float KEY_Z;
   private static final Vector3f SP = new Vector3f();
   private static final Vector3f SN = new Vector3f();
   private static boolean probed = false;
   private static Object irisApi;
   private static Method irisInUse;
   private static Method ofIsShaders;
   private static long nextPollNanos = Long.MIN_VALUE;
   private static boolean shadersOn = false;

   public static boolean shadersActive() {
      long t = System.nanoTime();
      if (t < nextPollNanos) {
         return shadersOn;
      }

      nextPollNanos = t + 2000000000L;
      if (!probed) {
         probed = true;

         try {
            Class<?> c = Class.forName("net.irisshaders.iris.api.v0.IrisApi");
            irisApi = c.getMethod("getInstance").invoke(null);
            irisInUse = c.getMethod("isShaderPackInUse");
         } catch (Throwable ignored) {
            irisApi = null;
            irisInUse = null;
         }

         try {
            ofIsShaders = Class.forName("net.optifine.Config").getMethod("isShaders");
         } catch (Throwable ignored) {
            ofIsShaders = null;
         }
      }

      boolean on = false;

      try {
         if (irisInUse != null) {
            on = (Boolean)irisInUse.invoke(irisApi);
         }
      } catch (Throwable broken) {
         irisInUse = null;
      }

      try {
         if (!on && ofIsShaders != null) {
            on = (Boolean)ofIsShaders.invoke(null);
         }
      } catch (Throwable broken) {
         ofIsShaders = null;
      }

      shadersOn = on;
      return on;
   }

   public static float spec(Matrix4f pose, Matrix3f normalMat, Vec3 pos, Vec3 normal, int packedLight, float exp, float strength) {
      SP.set((float)pos.x, (float)pos.y, (float)pos.z);
      pose.transformPosition(SP);
      SN.set((float)normal.x, (float)normal.y, (float)normal.z);
      normalMat.transform(SN);
      return specCam(SP.x, SP.y, SP.z, SN.x, SN.y, SN.z, packedLight, exp, strength);
   }

   public static float specTransform(Matrix4f pose, Matrix3f normalMat, Vec3 pos, Vec3 normal, int packedLight, float exp, float strength, Vector3f outPos) {
      return specTransform(pose, normalMat, pos, normal, packedLight, exp, strength, outPos, KEY_X, KEY_Y, KEY_Z);
   }

   public static float specTransform(
      Matrix4f pose, Matrix3f normalMat, Vec3 pos, Vec3 normal, int packedLight, float exp, float strength, Vector3f outPos, float kx, float ky, float kz
   ) {
      outPos.set((float)pos.x, (float)pos.y, (float)pos.z);
      pose.transformPosition(outPos);
      SN.set((float)normal.x, (float)normal.y, (float)normal.z);
      normalMat.transform(SN);
      return specCam(outPos.x, outPos.y, outPos.z, SN.x, SN.y, SN.z, packedLight, exp, strength, kx, ky, kz);
   }

   public static float specCam(float px, float py, float pz, float nx, float ny, float nz, int packedLight, float exp, float strength) {
      return specCam(px, py, pz, nx, ny, nz, packedLight, exp, strength, KEY_X, KEY_Y, KEY_Z);
   }

   public static float specCam(
      float px, float py, float pz, float nx, float ny, float nz, int packedLight, float exp, float strength, float kx, float ky, float kz
   ) {
      if (shadersActive()) {
         return 0.0F;
      }

      float nl = (float)Math.sqrt(nx * nx + ny * ny + nz * nz);
      if (nl < 1.0E-5F) {
         return 0.0F;
      }

      nx /= nl;
      ny /= nl;
      nz /= nl;
      float pl = (float)Math.sqrt(px * px + py * py + pz * pz);
      if (pl < 1.0E-5F) {
         return 0.0F;
      }

      float hx = -px / pl + kx;
      float hy = -py / pl + ky;
      float hz = -pz / pl + kz;
      float hl = (float)Math.sqrt(hx * hx + hy * hy + hz * hz);
      if (hl < 1.0E-5F) {
         return 0.0F;
      }

      float ndh = (nx * hx + ny * hy + nz * hz) / hl;
      if (ndh <= 0.0F) {
         return 0.0F;
      }

      float s = (float)Math.pow(ndh, exp) * strength;
      return s * (Math.max(LightTexture.block(packedLight), LightTexture.sky(packedLight)) / 15.0F);
   }

   private VanillaSheen() {
   }

   static {
      float x = -0.38F;
      float y = 0.8F;
      float z = 0.36F;
      float l = (float)Math.sqrt(x * x + y * y + z * z);
      KEY_X = x / l;
      KEY_Y = y / l;
      KEY_Z = z / l;
   }

   /**
    * Adds the camera-relative sheen to whatever is drawn through it. 1.21.4 vertex consumers have no endVertex, so
    * the attributes are gathered and the vertex is written once its normal (always the last attribute a model sets)
    * arrives; the packed single-call form used by baked model parts is handled directly.
    */
   public static final class Consumer implements VertexConsumer {
      private final VertexConsumer delegate;
      private final float exp;
      private final float strength;
      private float x;
      private float y;
      private float z;
      private float u;
      private float v;
      private int cr = 255;
      private int cg = 255;
      private int cb = 255;
      private int ca = 255;
      private int ou;
      private int ov = 10;
      private int lu;
      private int lv;

      public Consumer(VertexConsumer delegate, float exp, float strength) {
         this.delegate = delegate;
         this.exp = exp;
         this.strength = strength;
      }

      @Override
      public VertexConsumer addVertex(float x, float y, float z) {
         this.x = x;
         this.y = y;
         this.z = z;
         return this;
      }

      @Override
      public VertexConsumer setColor(int r, int g, int b, int a) {
         this.cr = r;
         this.cg = g;
         this.cb = b;
         this.ca = a;
         return this;
      }

      @Override
      public VertexConsumer setUv(float u, float v) {
         this.u = u;
         this.v = v;
         return this;
      }

      @Override
      public VertexConsumer setUv1(int u, int v) {
         this.ou = u;
         this.ov = v;
         return this;
      }

      @Override
      public VertexConsumer setUv2(int u, int v) {
         this.lu = u;
         this.lv = v;
         return this;
      }

      @Override
      public VertexConsumer setNormal(float nx, float ny, float nz) {
         this.emit(nx, ny, nz);
         return this;
      }

      @Override
      public void addVertex(float x, float y, float z, int color, float u, float v, int packedOverlay, int packedLight, float nx, float ny, float nz) {
         this.x = x;
         this.y = y;
         this.z = z;
         this.ca = ARGB.alpha(color);
         this.cr = ARGB.red(color);
         this.cg = ARGB.green(color);
         this.cb = ARGB.blue(color);
         this.u = u;
         this.v = v;
         this.ou = packedOverlay & 65535;
         this.ov = packedOverlay >> 16 & 65535;
         this.lu = packedLight & 65535;
         this.lv = packedLight >> 16 & 65535;
         this.emit(nx, ny, nz);
      }

      private void emit(float nx, float ny, float nz) {
         float s = VanillaSheen.specCam(this.x, this.y, this.z, nx, ny, nz, LightTexture.pack(this.lu, this.lv), this.exp, this.strength);
         int r = this.cr;
         int g = this.cg;
         int b = this.cb;
         if (s > 0.0F) {
            r = Math.min(255, Math.round(r + (255 - r) * s));
            g = Math.min(255, Math.round(g + (255 - g) * s));
            b = Math.min(255, Math.round(b + (255 - b) * s));
         }

         this.delegate
            .addVertex(this.x, this.y, this.z)
            .setColor(r, g, b, this.ca)
            .setUv(this.u, this.v)
            .setUv1(this.ou, this.ov)
            .setUv2(this.lu, this.lv)
            .setNormal(nx, ny, nz);
      }
   }
}
