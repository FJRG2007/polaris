import * as THREE from 'three/webgpu';
import { attribute, instanceColor, mat4, normalLocal, positionLocal, transformNormal } from 'three/tsl';

// js/shared-instances.js
// Instanced meshes that share their shader. three.js keys the node graph of an InstancedMesh by the mesh itself (its
// instance buffers are wired into the graph), so every one of the city's culling cells and tree cells built its own
// graph on the main thread (~30 ms each, ~770 of them before the first frame). A SharedInstances is a plain Mesh whose
// geometry carries the instance matrices (and colours) as named per-instance attributes: three.js keys a plain mesh's
// graph by its material and the layout of its attributes, so every cell of the same prop shares one graph and one
// pipeline, and only the first one drawn pays for them.

const MATRIX_COLUMNS = ['sharedInstanceMatrix0', 'sharedInstanceMatrix1', 'sharedInstanceMatrix2', 'sharedInstanceMatrix3'];
const COLOR = 'sharedInstanceColor';

// The same transform three.js applies to an InstancedMesh (nodes/accessors/Instance.js), read from the attributes.
// Keyed on the geometry's attributes, which are part of the graph's cache key, never on the object, which is not.
const setupPosition = THREE.NodeMaterial.prototype.setupPosition;
THREE.NodeMaterial.prototype.setupPosition = function (builder) {
  if (builder.hasGeometryAttribute(MATRIX_COLUMNS[0])) {
    const matrix = mat4(...MATRIX_COLUMNS.map((name) => attribute(name, 'vec4')));
    positionLocal.assign(matrix.mul(positionLocal).xyz);
    if (builder.hasGeometryAttribute('normal')) normalLocal.assign(transformNormal(normalLocal, matrix));
    if (builder.hasGeometryAttribute(COLOR)) instanceColor.assign(attribute(COLOR, 'vec3'));
  }
  return setupPosition.call(this, builder);
};

const _matrix = new THREE.Matrix4();
const _sphere = new THREE.Sphere();

class SharedInstances extends THREE.Mesh {
  /**
   * `source` is the geometry each instance draws (its vertex data and per-instance attributes are shared, not
   * copied), `matrices` 16 floats per instance in the object's space, `colors` 3 per instance or null. Room for
   * `capacity` instances, of which the first `count` are drawn.
   */
  constructor(source, material, matrices, colors = null, count = matrices.length / 16) {
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.setIndex(source.index);
    for (const [name, attr] of Object.entries(source.attributes)) geometry.setAttribute(name, attr);
    for (const g of source.groups) geometry.addGroup(g.start, g.count, g.materialIndex);
    geometry.setDrawRange(source.drawRange.start, source.drawRange.count);
    const matrixBuffer = new THREE.InstancedInterleavedBuffer(matrices, 16, 1);
    MATRIX_COLUMNS.forEach((name, i) => geometry.setAttribute(name, new THREE.InterleavedBufferAttribute(matrixBuffer, 4, i * 4)));
    if (colors) geometry.setAttribute(COLOR, new THREE.InstancedBufferAttribute(colors, 3));
    super(geometry, material);
    if (!source.boundingSphere) source.computeBoundingSphere();
    if (!source.boundingBox) source.computeBoundingBox();
    this.isSharedInstances = true;
    this.instanceSphere = source.boundingSphere;
    geometry.boundingBox = source.boundingBox; // of one instance, as on an InstancedMesh's geometry
    // Truthy for NodeMaterial, which multiplies the diffuse colour by the instance colour when the object has one
    this.instanceColor = colors ? geometry.attributes[COLOR] : null;
    this.instanceMatrix = matrixBuffer;
    this.setCount(count);
  }

  get capacity() {
    return this.instanceMatrix.count;
  }

  /** Draws the first `n` instances and fits the culling bounds to them. */
  setCount(n) {
    this.geometry.instanceCount = n;
    this.computeBoundingSphere();
  }

  /** Bounds of the drawn instances, in the object's space (the frustum and shadow cameras cull on them). */
  computeBoundingSphere() {
    const sphere = this.geometry.boundingSphere ?? (this.geometry.boundingSphere = new THREE.Sphere());
    sphere.makeEmpty();
    const e = this.instanceMatrix.array;
    for (let i = 0; i < this.geometry.instanceCount; i++) {
      sphere.union(_sphere.copy(this.instanceSphere).applyMatrix4(_matrix.fromArray(e, i * 16)));
    }
  }
}

export { SharedInstances };
