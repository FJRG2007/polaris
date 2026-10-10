package com.scout.symbiote.client.render;

import com.mojang.blaze3d.vertex.VertexConsumer;
import org.joml.Matrix3f;
import org.joml.Vector3f;

/** Forge 1.20.1 {@code VertexConsumer#normal(Matrix3f, x, y, z)}: the normal transformed by the pose's normal matrix. */
public final class Verts {
   public static VertexConsumer normal(VertexConsumer vc, Matrix3f normalMatrix, float x, float y, float z) {
      Vector3f n = normalMatrix.transform(new Vector3f(x, y, z)).normalize();
      return vc.setNormal(n.x(), n.y(), n.z());
   }

   private Verts() {
   }
}
