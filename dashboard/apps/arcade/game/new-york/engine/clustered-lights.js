import { ClusteredLighting } from 'three/addons/lighting/ClusteredLighting.js';
import ClusteredLightsNode from 'three/addons/tsl/lighting/ClusteredLightsNode.js';
import { DataTexture, FloatType, LightsNode, RGBAFormat, Vector3 } from 'three/webgpu';
import { Break, Fn, If, Loop, directPointLight, dot, int, ivec2, positionView, smoothstep, textureLoad, vec4 } from 'three/tsl';

// js/clustered-lights.js
// Clustered lighting that also takes the city's spot lights (street lamps, shop windows, headlights) off the
// materials. three.js clusters only point lights: every spot light stays a light each lit shader evaluates in turn,
// so the ~190 pooled spots were unrolled into every material's fragment shader, which made each of the city's
// pipelines take one to two seconds to build and compile. Here a spot is a clustered point light with a cone: the
// light texture gains two rows (the cone's axis and cosines), and a point light's cone covers the whole sphere.

const _position = new Vector3();
const _target = new Vector3();
const ROWS = 4;

class ClusteredSpotLightsNode extends ClusteredLightsNode {
  static get type() {
    return 'ClusteredSpotLightsNode';
  }

  constructor(maxLights, tileSize, zSlices, maxLightsPerCluster) {
    super(maxLights, tileSize, zSlices, maxLightsPerCluster);
    this._lightsTexture.dispose();
    this._lightsTexture = new DataTexture(new Float32Array(maxLights * 4 * ROWS), maxLights, ROWS, RGBAFormat, FloatType);
  }

  setLights(lights) {
    const { clusteredLights, materialLights } = this;
    let materialIndex = 0;
    let clusteredIndex = 0;
    for (const light of lights) {
      const clustered = (light.isPointLight === true || (light.isSpotLight === true && !light.map && !light.colorNode)) && light.castShadow !== true;
      if (clustered) clusteredLights[clusteredIndex++] = light;
      else materialLights[materialIndex++] = light;
    }
    materialLights.length = materialIndex;
    clusteredLights.length = clusteredIndex;
    return LightsNode.prototype.setLights.call(this, lights);
  }

  updateLightsTexture(camera) {
    super.updateLightsTexture(camera);
    // The base class wrote rows 0 and 1 in view-depth order: the cone rows follow the same order
    const { _lightsTexture: lightsTexture, clusteredLights, _lightSortOrder: order } = this;
    const data = lightsTexture.image.data;
    const line = lightsTexture.image.width * 4;
    for (let i = 0; i < clusteredLights.length; i++) {
      const light = clusteredLights[order[i]];
      const a = 2 * line + i * 4;
      const b = 3 * line + i * 4;
      if (light.isSpotLight) {
        _position.setFromMatrixPosition(light.matrixWorld);
        _target.setFromMatrixPosition(light.target.matrixWorld);
        _position.sub(_target).normalize();
        data[a] = _position.x;
        data[a + 1] = _position.y;
        data[a + 2] = _position.z;
        data[a + 3] = Math.cos(light.angle);
        data[b] = Math.cos(light.angle * (1 - light.penumbra));
      } else {
        data[a] = 0;
        data[a + 1] = 1;
        data[a + 2] = 0;
        data[a + 3] = -2;
        data[b] = -1;
      }
    }
  }

  getLightData(index) {
    const data = super.getLightData(index);
    index = int(index);
    const cone = textureLoad(this._lightsTexture, ivec2(index, 2));
    const penumbra = textureLoad(this._lightsTexture, ivec2(index, 3));
    data.spotDirection = this._cameraViewMatrix.mul(vec4(cone.xyz, 0.0)).xyz;
    data.coneCos = cone.w;
    data.penumbraCos = penumbra.x;
    return data;
  }

  setupLights(builder, lightNodes) {
    this.updateProgram(builder.renderer);
    const lightingModel = builder.context.reflectedLight;
    lightingModel.directDiffuse.toStack();
    lightingModel.directSpecular.toStack();
    LightsNode.prototype.setupLights.call(this, builder, lightNodes);

    Fn(() => {
      Loop(this.maxLightsPerCluster, ({ i }) => {
        const lightIndex = this.getTile(i);
        If(lightIndex.equal(int(0)), () => {
          Break();
        });
        const { color, decay, viewPosition, distance, spotDirection, coneCos, penumbraCos } = this.getLightData(lightIndex.sub(1));
        const lightVector = viewPosition.sub(positionView);
        If(distance.equal(0).or(dot(lightVector, lightVector).lessThanEqual(distance.mul(distance))), () => {
          const cone = smoothstep(coneCos, penumbraCos, dot(lightVector.normalize(), spotDirection));
          builder.lightsNode.setupDirectLight(builder, this, directPointLight({
            color: color.mul(cone),
            lightVector,
            cutoffDistance: distance,
            decayExponent: decay
          }));
        });
      });
    }, 'void')();
  }
}

class ClusteredSpotLighting extends ClusteredLighting {
  createNode(lights = []) {
    return new ClusteredSpotLightsNode(this.maxLights, this.tileSize, this.zSlices, this.maxLightsPerCluster).setLights(lights);
  }
}

export { ClusteredSpotLighting };
