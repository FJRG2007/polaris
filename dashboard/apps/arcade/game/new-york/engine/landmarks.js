import * as THREE from 'three/webgpu';
import { getBlockBounds, LANDMARK_SITES, BLOCKS, blockAt, avenueX } from './city-config.js';
import {
  createPreWarBuildingMaterial,
  createCurtainWallMaterial,
  createFacadeBoxes,
  createChryslerCrownMaterial,
  createBillboardMaterial,
  WALL_KINDS
} from './tsl-materials.js';
import { batchStaticGroupMeshes } from './city-grid.js';

let bryantParkLawn;

// Custom architectural 3D models for Midtown Manhattan's iconic landmarks

function buildLandmarks(scene) {
  const group = new THREE.Group();
  group.name = 'ManhattanLandmarks';
  const colliders = [];

  const limestoneTrimMat = new THREE.MeshStandardNodeMaterial({
    color: 0xdad0bc,
    roughness: 0.68,
    metalness: 0.12
  });
  const stainlessSteelMat = new THREE.MeshStandardNodeMaterial({
    color: 0xe2ebf4,
    metalness: 0.88,
    roughness: 0.12
  });
  const chryslerCrownMat = createChryslerCrownMaterial();
  const darkBronzeFrameMat = new THREE.MeshStandardNodeMaterial({
    color: 0x26221e,
    roughness: 0.36,
    metalness: 0.72
  });
  const copperRoofMat = new THREE.MeshStandardNodeMaterial({
    color: 0x4b8770,
    roughness: 0.52,
    metalness: 0.28
  });
  const beaconMat = new THREE.MeshBasicNodeMaterial({
    color: 0xff2b2b
  });
  const warmFloodMat = new THREE.MeshStandardNodeMaterial({
    color: 0xffe8be,
    emissive: 0xffc870,
    emissiveIntensity: 1.35,
    roughness: 0.28
  });
  // The Park Avenue Viaduct's roadway round Grand Central, and the dark of the portal it tunnels on through
  const viaductRoadMat = new THREE.MeshStandardNodeMaterial({
    color: 0x3a3b3e,
    roughness: 0.92
  });
  const portalShadowMat = new THREE.MeshStandardNodeMaterial({
    color: 0x0e0f11,
    roughness: 1.0
  });

  // Illuminated MetLife crown sign canvas texture
  const metlifeSignCanvas = document.createElement('canvas');
  metlifeSignCanvas.width = 512;
  metlifeSignCanvas.height = 128;
  const mlCtx = metlifeSignCanvas.getContext('2d');
  mlCtx.fillStyle = '#24221f';
  mlCtx.fillRect(0, 0, 512, 128);
  mlCtx.strokeStyle = '#6e665c';
  mlCtx.lineWidth = 6;
  mlCtx.strokeRect(4, 4, 504, 120);
  mlCtx.fillStyle = '#fff5dc';
  mlCtx.font = '900 76px Inter, Arial, sans-serif';
  mlCtx.textAlign = 'center';
  mlCtx.textBaseline = 'middle';
  mlCtx.fillText('METLIFE', 256, 68);
  const metlifeSignTex = new THREE.CanvasTexture(metlifeSignCanvas);
  metlifeSignTex.colorSpace = THREE.SRGBColorSpace;
  const metlifeSignMat = new THREE.MeshBasicNodeMaterial({ map: metlifeSignTex });

  // Shared canonical landmark facade TSL materials (avoids compiling 13 separate WGSL pipelines)
  const LIMESTONE_CROWN = {
    stoneColor: 0xdad0bc,
    trimColor: 0xa89e8a,
    windowGlassColor: 0x1a2836,
    windowWidth: 2.5,
    floorHeight: 3.6,
    litProbability: 0.58,
    warmth: 0.82,
    crownGlowHeight: 185.0,
    crownGlowColor: 0xffd584,
    seed: 19.31
  };
  const MARBLE_STONE = {
    stoneColor: 0xe6e0d4,
    trimColor: 0xa09888,
    windowGlassColor: 0x1a2634,
    windowWidth: 2.4,
    floorHeight: 3.6,
    litProbability: 0.60,
    warmth: 0.82,
    crownGlowHeight: 152.0,
    seed: 30.19
  };
  const SILVER_CURTAIN = {
    glassTint: 0x1e3e5a,
    frameTint: 0xc8d2dc,
    windowWidth: 2.8,
    floorHeight: 4.0,
    litProbability: 0.62,
    warmth: 0.52,
    reflectivity: 0.94,
    seed: 77.4
  };
  const BRONZE_CURTAIN = {
    glassTint: 0x242a32,
    frameTint: 0x48423c,
    windowWidth: 2.5,
    floorHeight: 3.7,
    litProbability: 0.66,
    warmth: 0.72,
    reflectivity: 0.88,
    seed: 58.2
  };
  const landmarkLimestoneCrownMat = createPreWarBuildingMaterial(LIMESTONE_CROWN);
  const landmarkMarbleStoneMat = createPreWarBuildingMaterial(MARBLE_STONE);
  const landmarkSilverCurtainMat = createCurtainWallMaterial(SILVER_CURTAIN);
  const landmarkBronzeCurtainMat = createCurtainWallMaterial(BRONZE_CURTAIN);
  // Their box-local twins: box-shaped parts are re-emitted as facade boxes at the end (see below)
  const boxLocalTwins = new Map([
    [landmarkLimestoneCrownMat, createPreWarBuildingMaterial({ ...LIMESTONE_CROWN, boxLocal: true })],
    [landmarkMarbleStoneMat, createPreWarBuildingMaterial({ ...MARBLE_STONE, boxLocal: true })],
    [landmarkSilverCurtainMat, createCurtainWallMaterial({ ...SILVER_CURTAIN, boxLocal: true })],
    [landmarkBronzeCurtainMat, createCurtainWallMaterial({ ...BRONZE_CURTAIN, boxLocal: true })]
  ]);

  // -------------------------------------------------------------------------------------------------------------------
  // Every landmark is modelled around a local origin, then fitted onto its real lot (city-config.js LANDMARK_SITES: the
  // OpenStreetMap outline's grid-aligned box): scaled up to its real height (as wide as the real outline allows, about
  // the model's centre) and moved so its centre stands on the outline's centre.
  // -------------------------------------------------------------------------------------------------------------------
  function fitToSite(objs, site, { height, horizontal, stretch = false, offset = [0, 0] } = {}) {
    if (!site) return;
    const box = new THREE.Box3();
    for (const o of objs) {
      o.updateMatrixWorld(true);
      box.expandByObject(o);
    }
    const size = box.getSize(new THREE.Vector3());
    const c = box.getCenter(new THREE.Vector3());
    const sy = height ? height / size.y : 1;
    let sx;
    let sz;
    if (stretch) {
      // fill the site's box exactly (parks & plazas)
      sx = site.w / size.x;
      sz = site.d / size.z;
    } else {
      // as tall as the real building, but never wider than its real outline (+6%) in either direction
      const fit = Math.min(site.w / size.x, site.d / size.z) * 1.06;
      sx = sz = horizontal ?? Math.min(sy, fit);
    }
    const tx = site.x + offset[0];
    const tz = site.z + offset[1];
    for (const o of objs) {
      o.position.set(tx + (o.position.x - c.x) * sx, o.position.y * sy, tz + (o.position.z - c.z) * sz);
      o.scale.multiply(new THREE.Vector3(sx, sy, sz));
      o.updateMatrixWorld(true);
    }
  }
  const site = (name) => LANDMARK_SITES[name];
  // A park block's curb island as a site (Bryant Park & the library)
  const blockSite = (parkName) => {
    const b = BLOCKS.filter((q) => q.parkName === parkName && !q.median).sort((p, q) => q.area - p.area)[0];
    return b && { x: (b.minX + b.maxX) / 2, z: (b.minZ + b.maxZ) / 2, w: b.maxX - b.minX - 9.2, d: b.maxZ - b.minZ - 9.2 };
  };
  // The building line of the block a lot stands in ([x0, x1, z0, z1]: its lot rects' bounds). The real outlines can
  // reach over a sidewalk or a street the city keeps (with its lamps & street trees); landmarks laid out in place stay
  // inside this line, like the blocks' own buildings.
  const buildingLine = (lot) => {
    const b = lot && blockAt(lot.x, lot.z);
    if (!b || !b.rects.length) return null;
    return [
      Math.min(...b.rects.map((r) => r[0])), Math.max(...b.rects.map((r) => r[1])),
      Math.min(...b.rects.map((r) => r[2])), Math.max(...b.rects.map((r) => r[3]))
    ];
  };

  // A landmark part: a mesh at (x, y, z) in its parent's frame, casting & receiving shadows ...
  function addPart(parent, geometry, material, x, y, z, { cast = true, receive = true } = {}) {
    const m = new THREE.Mesh(geometry, material);
    m.position.set(x, y, z);
    m.castShadow = cast;
    m.receiveShadow = receive;
    parent.add(m);
    return m;
  }
  // ... or a box given by its extents there
  const addBox = (parent, material, x0, x1, y0, y1, z0, z1, opts) =>
    addPart(parent, new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0), material, (x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2, opts);

  // -------------------------------------------------------------------------------------------------------------------
  // Player colliders are read back from what is drawn, once a landmark stands on its lot: every solid part adds its own
  // box (its geometry's bounds, or a box given in the part's frame), so each tier, wing & pier stops the player at its
  // own height and footprint, and nothing stops them where nothing stands. A part turned about +y gets an oriented box
  // (controllers.js buildingContact), a tilted one (a clock face) its world bounds.
  // -------------------------------------------------------------------------------------------------------------------
  const solidCentre = new THREE.Vector3();
  const solidPos = new THREE.Vector3();
  const solidRot = new THREE.Quaternion();
  const solidScale = new THREE.Vector3();
  const solidPart = new THREE.Box3();
  const box3 = (x0, y0, z0, x1, y1, z1) => new THREE.Box3(new THREE.Vector3(x0, y0, z0), new THREE.Vector3(x1, y1, z1));
  function solid(part, box = null) {
    if (!box) {
      if (!part.geometry.boundingBox) part.geometry.computeBoundingBox();
      box = part.geometry.boundingBox;
    }
    part.updateWorldMatrix(true, false);
    part.matrixWorld.decompose(solidPos, solidRot, solidScale);
    if (Math.abs(solidRot.x) > 1e-6 || Math.abs(solidRot.z) > 1e-6) {
      const { min, max } = solidPart.copy(box).applyMatrix4(part.matrixWorld);
      colliders.push({ minX: min.x, maxX: max.x, minZ: min.z, maxZ: max.z, minY: min.y, maxY: max.y });
      return;
    }
    box.getCenter(solidCentre).applyMatrix4(part.matrixWorld);
    const hx = (box.max.x - box.min.x) * 0.5 * solidScale.x;
    const hy = (box.max.y - box.min.y) * 0.5 * solidScale.y;
    const hz = (box.max.z - box.min.z) * 0.5 * solidScale.z;
    const turn = 2 * Math.atan2(solidRot.y, solidRot.w);
    const cs = Math.cos(turn);
    const sn = Math.sin(turn);
    const ex = Math.abs(cs) * hx + Math.abs(sn) * hz;
    const ez = Math.abs(sn) * hx + Math.abs(cs) * hz;
    const c = {
      minX: solidCentre.x - ex,
      maxX: solidCentre.x + ex,
      minZ: solidCentre.z - ez,
      maxZ: solidCentre.z + ez,
      minY: solidCentre.y - hy,
      maxY: solidCentre.y + hy
    };
    // turned off the grid's axes (not by whole quarter turns): an oriented box inside those bounds
    if (Math.abs(cs * sn) > 1e-6) c.obb = { cx: solidCentre.x, cz: solidCentre.z, hx, hz, cs, sn };
    colliders.push(c);
  }
  // One collider over a cluster of a parent's thin parts (fins, louvres): their joint bounds in the parent's frame
  function solidCluster(parent, parts) {
    const box = new THREE.Box3();
    for (const p of parts) {
      if (!p.geometry.boundingBox) p.geometry.computeBoundingBox();
      p.updateMatrix();
      box.union(solidPart.copy(p.geometry.boundingBox).applyMatrix4(p.matrix));
    }
    solid(parent, box);
  }

  // =========================================================================
  // 1. EMPIRE STATE BUILDING (Col 2, Row 5: 5th Ave & 34th St)
  // =========================================================================
  {
    const b = getBlockBounds(2, 5);
    const esb = new THREE.Group();
    esb.position.set(b.cx, 0, b.cz);

    const esbMat = landmarkLimestoneCrownMat;

    const podium = new THREE.Mesh(new THREE.BoxGeometry(68, 22, 50), esbMat);
    podium.position.y = 11;
    podium.castShadow = true;
    podium.receiveShadow = true;
    esb.add(podium);

    const portal = new THREE.Mesh(new THREE.BoxGeometry(3.2, 14, 12), limestoneTrimMat);
    portal.position.set(34.2, 7, 0);
    esb.add(portal);

    const tier1 = new THREE.Mesh(new THREE.BoxGeometry(54, 34, 38), esbMat);
    tier1.position.y = 22 + 17;
    tier1.castShadow = true;
    tier1.receiveShadow = true;
    esb.add(tier1);

    const tier2 = new THREE.Mesh(new THREE.BoxGeometry(44, 28, 32), esbMat);
    tier2.position.y = 56 + 14;
    tier2.castShadow = true;
    tier2.receiveShadow = true;
    esb.add(tier2);

    const mainShaft = new THREE.Mesh(new THREE.BoxGeometry(35, 112, 26), esbMat);
    mainShaft.position.y = 84 + 56;
    mainShaft.castShadow = true;
    mainShaft.receiveShadow = true;
    esb.add(mainShaft);

    const wings = [];
    for (const sx of [-18.5, 18.5]) {
      const wing = new THREE.Mesh(new THREE.BoxGeometry(4.5, 96, 16), esbMat);
      wing.position.set(sx, 84 + 48, 0);
      wing.castShadow = true;
      wing.receiveShadow = true;
      esb.add(wing);
      wings.push(wing);
    }

    const tier3 = new THREE.Mesh(new THREE.BoxGeometry(29, 24, 21), esbMat);
    tier3.position.y = 196 + 12;
    tier3.castShadow = true;
    esb.add(tier3);

    const tier4 = new THREE.Mesh(new THREE.BoxGeometry(23, 18, 17), esbMat);
    tier4.position.y = 220 + 9;
    tier4.castShadow = true;
    esb.add(tier4);

    // 86th-Floor Outdoor Observation Deck Terrace, Parapet Railing & Mullioned Glass Core
    const obsTerrace = new THREE.Mesh(new THREE.BoxGeometry(23.8, 1.1, 17.8), limestoneTrimMat);
    obsTerrace.position.y = 238.4;
    esb.add(obsTerrace);

    const rails = [];
    for (const pz of [-8.6, 8.6]) {
      const railZ = new THREE.Mesh(new THREE.BoxGeometry(23.6, 1.25, 0.32), stainlessSteelMat);
      railZ.position.set(0, 239.5, pz);
      esb.add(railZ);
      rails.push(railZ);
    }
    for (const px of [-11.6, 11.6]) {
      const railX = new THREE.Mesh(new THREE.BoxGeometry(0.32, 1.25, 17.6), stainlessSteelMat);
      railX.position.set(px, 239.5, 0);
      esb.add(railX);
      rails.push(railX);
    }

    const obsDeck = new THREE.Mesh(new THREE.BoxGeometry(18.6, 6.4, 13.6), warmFloodMat);
    obsDeck.position.y = 238.8 + 3.2;
    esb.add(obsDeck);

    // Architectural window mullions & upper cornice on 86th-floor observatory
    for (let mx = -7.5; mx <= 7.5; mx += 3.0) {
      const mullionZ = new THREE.Mesh(new THREE.BoxGeometry(0.45, 6.4, 13.95), darkBronzeFrameMat);
      mullionZ.position.set(mx, 242.0, 0);
      esb.add(mullionZ);
    }
    for (let mz = -5.0; mz <= 5.0; mz += 2.5) {
      const mullionX = new THREE.Mesh(new THREE.BoxGeometry(18.95, 6.4, 0.45), darkBronzeFrameMat);
      mullionX.position.set(0, 242.0, mz);
      esb.add(mullionX);
    }
    const obsCap = new THREE.Mesh(new THREE.BoxGeometry(19.8, 0.9, 14.8), limestoneTrimMat);
    obsCap.position.y = 245.2;
    esb.add(obsCap);

    const mast = new THREE.Mesh(new THREE.CylinderGeometry(4.6, 6.2, 30, 16), stainlessSteelMat);
    mast.position.y = 245 + 15;
    esb.add(mast);

    const ring102 = new THREE.Mesh(new THREE.CylinderGeometry(5.1, 5.1, 3.2, 16), warmFloodMat);
    ring102.position.y = 271;
    esb.add(ring102);

    const dome = new THREE.Mesh(new THREE.CylinderGeometry(1.8, 4.6, 8, 16), stainlessSteelMat);
    dome.position.y = 276.5;
    esb.add(dome);

    const spire = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 1.4, 44, 12), stainlessSteelMat);
    spire.position.y = 280.5 + 22;
    esb.add(spire);

    const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.95, 8, 8), beaconMat);
    beacon.position.y = 325.2;
    esb.add(beacon);

    group.add(esb);
    fitToSite([esb], site('Empire State Building'), { height: 443 });
    // every setback stops the player at its own height and width, up to the mast & spire
    for (const p of [podium, portal, tier1, tier2, mainShaft, ...wings, tier3, tier4, obsTerrace, ...rails, obsDeck, obsCap,
      mast, ring102, dome, spire, beacon]) solid(p);
  }

  // =========================================================================
  // 2. CHRYSLER BUILDING (Col 5, Row 3: Lexington Ave & 42nd St)
  // =========================================================================
  {
    const b = getBlockBounds(5, 3);
    const chrysler = new THREE.Group();
    chrysler.position.set(b.cx - 8, 0, b.cz + 6);

    const chryslerShaftMat = landmarkMarbleStoneMat;
    const crownMat = chryslerCrownMat;

    const base = new THREE.Mesh(new THREE.BoxGeometry(50, 24, 44), chryslerShaftMat);
    base.position.y = 12;
    base.castShadow = true;
    base.receiveShadow = true;
    chrysler.add(base);

    const step1 = new THREE.Mesh(new THREE.BoxGeometry(40, 24, 34), chryslerShaftMat);
    step1.position.y = 24 + 12;
    step1.castShadow = true;
    step1.receiveShadow = true;
    chrysler.add(step1);

    const step2 = new THREE.Mesh(new THREE.BoxGeometry(31, 22, 28), chryslerShaftMat);
    step2.position.y = 48 + 11;
    step2.castShadow = true;
    step2.receiveShadow = true;
    chrysler.add(step2);

    const shaft = new THREE.Mesh(new THREE.BoxGeometry(24, 102, 24), chryslerShaftMat);
    shaft.position.y = 70 + 51;
    shaft.castShadow = true;
    shaft.receiveShadow = true;
    chrysler.add(shaft);

    // 61st floor Silver Eagle Gargoyles at all 4 corners
    for (const gx of [-12.2, 12.2]) {
      for (const gz of [-12.2, 12.2]) {
        const gargoyle = new THREE.Mesh(new THREE.ConeGeometry(0.95, 3.8, 6), stainlessSteelMat);
        gargoyle.position.set(gx * 1.06, 169, gz * 1.06);
        gargoyle.rotation.x = gz > 0 ? Math.PI * 0.38 : -Math.PI * 0.38;
        gargoyle.rotation.z = gx > 0 ? -Math.PI * 0.38 : Math.PI * 0.38;
        chrysler.add(gargoyle);
      }
    }

    // 7-Tier Terraced Art Deco Sunburst Crown with radiating triangular clerestory windows
    const crownTiers = [];
    const numTiers = 7;
    let curY = 172;
    for (let t = 0; t < numTiers; t++) {
      const u = t / numTiers;
      const w = 22.8 * (1.0 - u * 0.72);
      const h = 6.8 * (1.0 - u * 0.16);

      const tierCore = new THREE.Mesh(new THREE.BoxGeometry(w, h, w * 0.82), crownMat);
      tierCore.position.y = curY + h * 0.5;
      chrysler.add(tierCore);

      const tierCross = new THREE.Mesh(new THREE.BoxGeometry(w * 0.82, h, w), crownMat);
      tierCross.position.y = curY + h * 0.5;
      chrysler.add(tierCross);

      const rib = new THREE.Mesh(new THREE.BoxGeometry(w + 0.7, 0.55, w + 0.7), stainlessSteelMat);
      rib.position.y = curY + h;
      chrysler.add(rib);

      crownTiers.push(tierCore, tierCross, rib);
      curY += h;
    }

    const needle = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 1.35, 38, 12), stainlessSteelMat);
    needle.position.y = curY + 18;
    chrysler.add(needle);

    const cBeacon = new THREE.Mesh(new THREE.SphereGeometry(0.8, 8, 8), beaconMat);
    cBeacon.position.y = curY + 37.5;
    chrysler.add(cBeacon);

    group.add(chrysler);
    fitToSite([chrysler], site('Chrysler Building'), { height: 319 });
    for (const p of [base, step1, step2, shaft, ...crownTiers, needle, cBeacon]) solid(p);
  }

  // =========================================================================
  // 3. ONE VANDERBILT (Col 3, Row 3: Vanderbilt Ave & 42nd St)
  // =========================================================================
  {
    const b = getBlockBounds(3, 3);
    const vanderbilt = new THREE.Group();
    vanderbilt.position.set(b.cx + 12, 0, b.cz + 5);

    const ovMat = landmarkSilverCurtainMat;

    const segments = [
      { w: 40, d: 38, h: 68, y: 0, ox: 0, oz: 0 },
      { w: 35, d: 33, h: 72, y: 66, ox: 1.0, oz: -1.0 },
      { w: 29, d: 28, h: 62, y: 136, ox: -1.0, oz: 1.0 },
      { w: 23, d: 22, h: 42, y: 196, ox: 0.5, oz: 0.5 },
      { w: 15, d: 15, h: 24, y: 236, ox: 0, oz: 0 }
    ];
    const segmentMeshes = [];
    for (const seg of segments) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(seg.w, seg.h, seg.d), ovMat);
      m.position.set(seg.ox, seg.y + seg.h * 0.5, seg.oz);
      m.castShadow = true;
      m.receiveShadow = true;
      vanderbilt.add(m);
      segmentMeshes.push(m);
    }

    // SUMMIT One Vanderbilt cantilevered glass sky-boxes & structural terracotta/steel fins
    const summitCore = new THREE.Mesh(new THREE.BoxGeometry(24.6, 8.2, 23.2), warmFloodMat);
    summitCore.position.set(0.5, 206, 0.5);
    vanderbilt.add(summitCore);

    const finsZ = [];
    const finsX = [];
    for (let fx = -11; fx <= 11; fx += 2.75) {
      const finZ = new THREE.Mesh(new THREE.BoxGeometry(0.42, 8.6, 23.8), stainlessSteelMat);
      finZ.position.set(0.5 + fx, 206, 0.5);
      vanderbilt.add(finZ);
      finsZ.push(finZ);
    }
    for (let fz = -10; fz <= 10; fz += 2.5) {
      const finX = new THREE.Mesh(new THREE.BoxGeometry(25.2, 8.6, 0.42), stainlessSteelMat);
      finX.position.set(0.5, 206, 0.5 + fz);
      vanderbilt.add(finX);
      finsX.push(finX);
    }

    const ovSpire = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.95, 30, 8), warmFloodMat);
    ovSpire.position.y = 260 + 15;
    vanderbilt.add(ovSpire);

    group.add(vanderbilt);
    fitToSite([vanderbilt], site('One Vanderbilt'), { height: 427 });
    for (const p of [...segmentMeshes, summitCore, ovSpire]) solid(p);
    // the SUMMIT's fin cage, a little wider than the tier it rings: each set of fins on its own, a cross in plan
    solidCluster(vanderbilt, finsZ);
    solidCluster(vanderbilt, finsX);
  }

  // =========================================================================
  // 4. GRAND CENTRAL TERMINAL, PARK AVE VIADUCT & METLIFE BUILDING (Park Ave & 42nd St)
  // =========================================================================
  // Laid out in place, each on its own real lot, rather than fitted as one model: the terminal fronting 42nd St, the
  // MetLife Building on its old office-building site behind it. Both are centred on Park Ave and kept inside the block's
  // building line, which stops short of the OpenStreetMap outlines on the Vanderbilt Ave sidewalk and over De Pew Pl
  // (streets here, with their lamps & street trees).
  {
    const gct = site('Grand Central Terminal');
    const ml = site('MetLife Building');
    const line = buildingLine(gct);
    if (gct && ml && line) {
      const px = avenueX('park');
      const x0 = Math.max(gct.x - gct.w / 2, line[0]); // Vanderbilt Ave
      const x1 = Math.min(gct.x + gct.w / 2, line[1]); // De Pew Pl
      const zS = Math.min(gct.z + gct.d / 2, line[3]); // 42nd St
      const zN = ml.z + ml.d / 2; // where the MetLife Building takes over
      const DECK = 7.6; // the viaduct's roadway, wrapped round the terminal at its second-floor level
      const wx = px - (x1 - px); // the terminal's west wall: as far west of Park Ave as De Pew Pl is east of it
      const zF = zS - 12.3; // its 42nd St front, behind the viaduct's terrace
      const zB = zN + 7.2; // its back, against the north wing the viaduct tunnels through

      const gctGroup = new THREE.Group();
      gctGroup.name = 'GrandCentralTerminal';

      // The viaduct's base (shops & the 42nd St entrances under the roadway) and the north wing
      const base = addBox(gctGroup, landmarkMarbleStoneMat, x0, x1, 0, DECK, zB, zS);
      const northWing = addBox(gctGroup, landmarkMarbleStoneMat, x0, x1, 0, 24, zN, zB);
      for (const dx of [-12, 0, 12]) addBox(gctGroup, warmFloodMat, px + dx - 2.6, px + dx + 2.6, 0, 4.8, zS, zS + 0.12, { cast: false });

      // Park Avenue Viaduct: a terrace along the 42nd St front and the roadway up the Vanderbilt Ave side into the north
      // wing (De Pew Pl's lamps & trees stand where its east side would run)
      const terraceRoad = addBox(gctGroup, viaductRoadMat, x0, x1, DECK, DECK + 0.3, zF, zS, { cast: false });
      const sideRoad = addBox(gctGroup, viaductRoadMat, x0, wx, DECK, DECK + 0.3, zB, zF, { cast: false });
      const balustrades = [
        addBox(gctGroup, limestoneTrimMat, x0, x1, DECK, DECK + 1.3, zS - 0.5, zS),
        addBox(gctGroup, limestoneTrimMat, x0, x0 + 0.5, DECK, DECK + 1.3, zB, zS - 0.5),
        addBox(gctGroup, limestoneTrimMat, x1 - 0.5, x1, DECK, DECK + 1.3, zF, zS - 0.5)
      ];
      addBox(gctGroup, portalShadowMat, x0 + 1.2, wx - 1.2, DECK + 0.3, DECK + 5.6, zB, zB + 0.12, { cast: false });
      const portalLintel = addBox(gctGroup, limestoneTrimMat, x0 + 0.6, wx - 0.6, DECK + 5.6, DECK + 6.6, zB, zB + 0.5);
      // Commodore Vanderbilt on the terrace, before the middle window
      const statueBase = addBox(gctGroup, limestoneTrimMat, px - 1.2, px + 1.2, DECK + 0.3, DECK + 2.7, zF + 6, zF + 8.4);
      const statue = addBox(gctGroup, darkBronzeFrameMat, px - 0.5, px + 0.5, DECK + 2.7, DECK + 5.3, zF + 6.8, zF + 7.6, { cast: false });

      // The terminal: stone walls round the main concourse under a green copper roof
      const hall = addBox(gctGroup, landmarkMarbleStoneMat, wx, x1, DECK, 30, zB, zF);
      const roof = addBox(gctGroup, copperRoofMat, wx + 0.4, x1 - 0.4, 30, 31.2, zB + 0.4, zF - 0.4, { cast: false });
      const czN = zF - 65;
      const czS = zF - 28;
      const concourse = addBox(gctGroup, landmarkMarbleStoneMat, px - 42, px + 42, 30, 36, czN, czS);
      const vaultShape = new THREE.Shape();
      vaultShape.moveTo(-18.5, 0);
      vaultShape.quadraticCurveTo(0, 12, 18.5, 0);
      vaultShape.closePath();
      const vaultGeo = new THREE.ExtrudeGeometry(vaultShape, { depth: 84, bevelEnabled: false, curveSegments: 10 });
      vaultGeo.rotateY(Math.PI * 0.5); // the shallow barrel vault runs east-west, 84 m long ...
      vaultGeo.translate(-42, 0, 0);
      const vault = addPart(gctGroup, vaultGeo, copperRoofMat, px, 36, (czN + czS) / 2); // ... rising 6 m over 37

      // The Beaux-Arts 42nd St front: 3 monumental arched windows with dark bronze muntins, paired columns, the
      // entablature, the attic with the Tiffany clock, and the Glory of Commerce group (Mercury between Hercules &
      // Minerva) crowning it at the terminal's full height
      const front = addBox(gctGroup, limestoneTrimMat, px - 30, px + 30, DECK, 29.5, zF, zF + 2.5);
      const fz = zF + 2.5;
      for (const wx3 of [-18, 0, 18]) {
        addBox(gctGroup, warmFloodMat, px + wx3 - 5, px + wx3 + 5, 10, 22, fz, fz + 0.4, { cast: false });
        const archTop = addPart(gctGroup, new THREE.CylinderGeometry(5, 5, 0.4, 20), warmFloodMat, px + wx3, 22, fz + 0.2, { cast: false });
        archTop.rotation.x = Math.PI * 0.5;
        for (const mx of [-2.5, 0, 2.5]) {
          addBox(gctGroup, darkBronzeFrameMat, px + wx3 + mx - 0.17, px + wx3 + mx + 0.17, 10, 26.4, fz + 0.3, fz + 0.65, { cast: false });
        }
        for (const my of [13, 16.5, 20]) {
          addBox(gctGroup, darkBronzeFrameMat, px + wx3 - 5, px + wx3 + 5, my - 0.17, my + 0.17, fz + 0.3, fz + 0.65, { cast: false });
        }
      }
      const columns = [];
      for (const cx of [-28.1, -25.9, -10.1, -7.9, 7.9, 10.1, 25.9, 28.1]) {
        columns.push(addPart(gctGroup, new THREE.CylinderGeometry(0.7, 0.8, 19.6, 12), limestoneTrimMat, px + cx, DECK + 0.3 + 9.8, fz + 0.8));
      }
      const entablature = addBox(gctGroup, limestoneTrimMat, px - 30.5, px + 30.5, 27.5, 29.5, fz, fz + 1.8);
      const attic = addBox(gctGroup, limestoneTrimMat, px - 26, px + 26, 29.5, 34, zF - 0.5, fz - 0.5);
      const clockBezel = addPart(gctGroup, new THREE.CylinderGeometry(2.4, 2.4, 0.7, 20), darkBronzeFrameMat, px, 31.8, fz - 0.2, { cast: false });
      clockBezel.rotation.x = Math.PI * 0.5;
      const clockGlow = addPart(gctGroup, new THREE.CylinderGeometry(1.95, 1.95, 0.8, 20), warmFloodMat, px, 31.8, fz - 0.15, { cast: false });
      clockGlow.rotation.x = Math.PI * 0.5;
      const sculpture = [
        addBox(gctGroup, limestoneTrimMat, px - 10, px + 10, 34, 36.4, zF - 1.5, zF + 1.8),
        addBox(gctGroup, limestoneTrimMat, px - 9, px - 3.5, 36.4, 39.8, zF - 1, zF + 1.4),
        addBox(gctGroup, limestoneTrimMat, px + 3.5, px + 9, 36.4, 39.8, zF - 1, zF + 1.4),
        addBox(gctGroup, limestoneTrimMat, px - 1.5, px + 1.5, 36.4, 44.2, zF - 0.8, zF + 1.2),
        addBox(gctGroup, limestoneTrimMat, px - 3.4, px + 3.4, 41.6, 43.4, zF - 0.1, zF + 0.4),
        addPart(gctGroup, new THREE.SphereGeometry(0.85, 10, 8), limestoneTrimMat, px, 44.95, zF + 0.2)
      ];

      // The great arched windows of the concourse in the terminal's side walls
      for (const side of [-1, 1]) {
        const sx = side < 0 ? wx : x1;
        for (const k of [-1, 0, 1]) {
          const z = (czN + czS) / 2 + k * 12;
          addBox(gctGroup, warmFloodMat, sx - 0.2, sx + 0.2, 12, 23, z - 4, z + 4, { cast: false });
          const sideArch = addPart(gctGroup, new THREE.CylinderGeometry(4, 4, 0.4, 18), warmFloodMat, sx, 23, z, { cast: false });
          sideArch.rotation.z = Math.PI * 0.5;
          for (const mz of [-2, 0, 2]) {
            addBox(gctGroup, darkBronzeFrameMat, sx - 0.32, sx + 0.32, 12, 26.6, z + mz - 0.15, z + mz + 0.15, { cast: false });
          }
          for (const my of [15.5, 19.5]) {
            addBox(gctGroup, darkBronzeFrameMat, sx - 0.32, sx + 0.32, my - 0.15, my + 0.15, z - 4, z + 4, { cast: false });
          }
        }
      }

      // The MetLife Building: a 10-storey base filling its lot and the tower, an elongated hexagon across Park Ave (a
      // slab between pointed ends, squares turned 45°), with the illuminated sign band under its crown
      const mlGroup = new THREE.Group();
      mlGroup.name = 'MetLifeBuilding';
      const metlifeMat = landmarkBronzeCurtainMat;
      const mx0 = Math.max(ml.x - ml.w / 2, line[0]);
      const mx1 = Math.min(ml.x + ml.w / 2, line[1]);
      const mzN = Math.max(ml.z - ml.d / 2, line[2]);
      const PODIUM = 42;
      const TOP = 236;
      const tz = (mzN + zN) / 2;
      const tHalf = Math.min(px - mx0, mx1 - px) - 2;
      const tDepth = 44;
      const mlPodium = addBox(mlGroup, metlifeMat, mx0, mx1, 0, PODIUM, mzN, zN);
      const slab = addBox(mlGroup, metlifeMat, px - tHalf + tDepth / 2, px + tHalf - tDepth / 2, PODIUM, TOP, tz - tDepth / 2, tz + tDepth / 2);
      const ends = [-1, 1].map((s) => {
        const end = addPart(mlGroup, new THREE.BoxGeometry(tDepth * Math.SQRT1_2, TOP - PODIUM, tDepth * Math.SQRT1_2), metlifeMat,
          px + s * (tHalf - tDepth / 2), (PODIUM + TOP) / 2, tz);
        end.rotation.y = Math.PI * 0.25;
        return end;
      });
      const mlCrown = addBox(mlGroup, metlifeMat, px - 18, px + 18, TOP, 246, tz - 19, tz + 19);
      const signBand = addBox(mlGroup, metlifeSignMat, px - 15, px + 15, 226, 233, tz - tDepth / 2 - 0.7, tz + tDepth / 2 + 0.7,
        { cast: false, receive: false });

      group.add(gctGroup, mlGroup);
      for (const p of [base, northWing, terraceRoad, sideRoad, ...balustrades, portalLintel, statueBase, statue, hall, roof,
        concourse, front, ...columns, entablature, attic, clockBezel, ...sculpture, mlPodium, slab, ...ends, mlCrown, signBand]) solid(p);
      // the vault under its curve: a full-height middle and two lower steps either side (its frame: x along it, z across)
      for (const [z0, z1, h] of [[-6.2, 6.2, 6], [6.2, 12.3, 5.33], [-12.3, -6.2, 5.33], [12.3, 18.5, 3.35], [-18.5, -12.3, 3.35]]) {
        solid(vault, box3(-42, 0, z0, 42, h, z1));
      }
    }
  }

  // =========================================================================
  // 5. BRYANT PARK & NEW YORK PUBLIC LIBRARY (Col 2, Row 4: 5th Ave & 42nd St)
  // =========================================================================
  {
    const b = getBlockBounds(2, 4);
    const bpGroup = new THREE.Group();
    bpGroup.position.set(b.cx, 0, b.cz);

    const nypl = new THREE.Mesh(new THREE.BoxGeometry(26, 21, 56), landmarkMarbleStoneMat);
    nypl.position.set(20, 10.5, 0);
    nypl.castShadow = true;
    nypl.receiveShadow = true;
    bpGroup.add(nypl);

    const nyplRoof = new THREE.Mesh(new THREE.BoxGeometry(22, 3.2, 50), copperRoofMat);
    nyplRoof.position.set(20, 22.5, 0);
    bpGroup.add(nyplRoof);

    // Beaux-Arts 5th Avenue Colonnaded Portico: recessed marble vestibule, 3 arched bronze/glass portals & 6 Corinthian columns
    const porticoBack = new THREE.Mesh(new THREE.BoxGeometry(2.6, 18.5, 22), landmarkMarbleStoneMat);
    porticoBack.position.set(32.2, 9.25, 0);
    porticoBack.castShadow = true;
    porticoBack.receiveShadow = true;
    bpGroup.add(porticoBack);

    const portals = [];
    for (const pz of [-6.4, 0, 6.4]) {
      const archFrame = new THREE.Mesh(new THREE.BoxGeometry(1.1, 11.8, 4.2), darkBronzeFrameMat);
      archFrame.position.set(33.3, 8.2, pz);
      bpGroup.add(archFrame);

      const archGlass = new THREE.Mesh(new THREE.BoxGeometry(1.25, 10.6, 3.2), warmFloodMat);
      archGlass.position.set(33.35, 8.0, pz);
      bpGroup.add(archGlass);
      portals.push(archFrame, archGlass);
    }

    const columns = [];
    for (const cz of [-9.6, -5.8, -2.2, 2.2, 5.8, 9.6]) {
      const column = new THREE.Mesh(new THREE.CylinderGeometry(0.58, 0.66, 14.2, 12), limestoneTrimMat);
      column.position.set(34.8, 9.5, cz);
      column.castShadow = true;
      column.receiveShadow = true;
      bpGroup.add(column);
      columns.push(column);
    }

    const porticoEntablature = new THREE.Mesh(new THREE.BoxGeometry(4.2, 2.2, 22.4), limestoneTrimMat);
    porticoEntablature.position.set(33.6, 17.6, 0);
    porticoEntablature.castShadow = true;
    bpGroup.add(porticoEntablature);

    const porticoAttic = new THREE.Mesh(new THREE.BoxGeometry(3.6, 2.0, 16.0), limestoneTrimMat);
    porticoAttic.position.set(33.4, 19.6, 0);
    bpGroup.add(porticoAttic);

    const stairs = new THREE.Mesh(new THREE.BoxGeometry(5.5, 2.4, 18), limestoneTrimMat);
    stairs.position.set(35.5, 1.2, 0);
    stairs.receiveShadow = true;
    bpGroup.add(stairs);

    const lionParts = [];
    for (const lz of [-10.5, 10.5]) {
      const pedestal = new THREE.Mesh(new THREE.BoxGeometry(3.2, 2.2, 2.2), limestoneTrimMat);
      pedestal.position.set(35.8, 1.1, lz);
      bpGroup.add(pedestal);
      const lion = new THREE.Mesh(new THREE.BoxGeometry(2.6, 1.4, 1.2), limestoneTrimMat);
      lion.position.set(36.0, 2.8, lz);
      bpGroup.add(lion);
      lionParts.push(pedestal, lion);
    }

    const lawnWall = new THREE.Mesh(new THREE.BoxGeometry(46, 0.85, 60), limestoneTrimMat);
    lawnWall.position.set(-14, 0.42, 0);
    lawnWall.receiveShadow = true;
    bpGroup.add(lawnWall);

    const lawnGrassMat = new THREE.MeshStandardNodeMaterial({
      color: 0x388c42,
      emissive: 0x081e0b,
      roughness: 0.80
    });
    const lawn = new THREE.Mesh(new THREE.BoxGeometry(38, 0.28, 48), lawnGrassMat);
    lawn.position.set(-13, 0.92, 0);
    lawn.receiveShadow = true;
    bpGroup.add(lawn);

    const fountainBasin = new THREE.Mesh(new THREE.CylinderGeometry(5.8, 6.2, 1.1, 20), limestoneTrimMat);
    fountainBasin.position.set(-29, 0.9, 0);
    bpGroup.add(fountainBasin);

    const fountainWater = new THREE.Mesh(
      new THREE.CylinderGeometry(5.2, 5.2, 0.16, 20),
      new THREE.MeshStandardNodeMaterial({ color: 0x24789c, emissive: 0x0a2e40, roughness: 0.12, metalness: 0.65 })
    );
    fountainWater.position.set(-29, 1.42, 0);
    bpGroup.add(fountainWater);

    const carouselBase = new THREE.Mesh(new THREE.CylinderGeometry(3.8, 4.0, 2.8, 14), limestoneTrimMat);
    carouselBase.position.set(-12, 2.2, 21);
    bpGroup.add(carouselBase);
    const carouselRoof = new THREE.Mesh(
      new THREE.ConeGeometry(4.4, 2.2, 14),
      new THREE.MeshStandardNodeMaterial({ color: 0xb83228, roughness: 0.45 })
    );
    carouselRoof.position.set(-12, 4.6, 21);
    bpGroup.add(carouselRoof);

    group.add(bpGroup);
    fitToSite([bpGroup], blockSite('Bryant Park'), { height: 30, stretch: true });
    // the library, its portico, steps & lions, the fountain and the carousel (the raised lawn stays walkable)
    for (const p of [nypl, nyplRoof, porticoBack, ...portals, ...columns, porticoEntablature, porticoAttic, stairs, ...lionParts,
      fountainBasin, carouselBase, carouselRoof]) solid(p);
    bpGroup.updateMatrixWorld(true);
    const lb = new THREE.Box3().setFromObject(lawn);
    bryantParkLawn = { minX: lb.min.x, maxX: lb.max.x, minZ: lb.min.z, maxZ: lb.max.z, top: lb.max.y };
  }

  // =========================================================================
  // 6. ONE TIMES SQUARE & BROADWAY LED CANYON (Col 1, Row 3 & Broadway Corridor)
  // =========================================================================
  {
    const b = getBlockBounds(1, 3);
    const tsGroup = new THREE.Group();
    tsGroup.position.set(b.cx, 0, b.cz);

    const darkFacadeMat = landmarkBronzeCurtainMat;

    const otsW = 18;
    const otsD = 26;
    const otsH = 118;
    const otsX = -16; // b.cx - 16 = -181 (sits right on the Times Square bowtie prow east of Broadway x=-201)
    const otsTower = new THREE.Mesh(new THREE.BoxGeometry(otsW, otsH, otsD), darkFacadeMat);
    otsTower.position.set(otsX, otsH * 0.5, 14);
    otsTower.castShadow = true;
    otsTower.receiveShadow = true;
    tsGroup.add(otsTower);

    for (let s = 0; s < 5; s++) {
      const panelH = 17.5;
      const panelY = 14 + s * 19.5;
      const screenW = new THREE.Mesh(new THREE.PlaneGeometry(otsD - 2, panelH), createBillboardMaterial(s));
      screenW.rotation.y = -Math.PI * 0.5;
      screenW.position.set(otsX - otsW * 0.5 - 0.25, panelY, 14);
      tsGroup.add(screenW);

      const screenS = new THREE.Mesh(new THREE.PlaneGeometry(otsW - 2, panelH), createBillboardMaterial(s + 1));
      screenS.position.set(otsX, panelY, 14 + otsD * 0.5 + 0.25);
      tsGroup.add(screenS);

      const screenN = new THREE.Mesh(new THREE.PlaneGeometry(otsW - 2, panelH), createBillboardMaterial(s + 3));
      screenN.rotation.y = Math.PI;
      screenN.position.set(otsX, panelY, 14 - otsD * 0.5 - 0.25);
      tsGroup.add(screenN);
    }

    const ballMast = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.5, 26, 8), stainlessSteelMat);
    ballMast.position.set(otsX, otsH + 13, 14);
    tsGroup.add(ballMast);

    const nyeBall = new THREE.Mesh(
      new THREE.SphereGeometry(2.8, 14, 14),
      new THREE.MeshBasicNodeMaterial({ color: 0x88f5ff })
    );
    nyeBall.position.set(otsX, otsH + 22, 14);
    tsGroup.add(nyeBall);

    // (the towers around the bowtie are the procedural blocks' Broadway flush walls & billboards now)
    group.add(tsGroup);
    fitToSite([tsGroup], site('One Times Square'), { height: 120 });
    for (const p of [otsTower, ballMast, nyeBall]) solid(p);
  }

  // =========================================================================
  // 7. ROCKEFELLER CENTER / 30 ROCK (Col 2, Row 2: 5th-6th Ave, 45th-48th St)
  // =========================================================================
  {
    const b = getBlockBounds(2, 2);
    const rockGroup = new THREE.Group();
    rockGroup.position.set(b.cx, 0, b.cz);

    const rockMat = landmarkLimestoneCrownMat;

    const slabMain = new THREE.Mesh(new THREE.BoxGeometry(24, 212, 56), rockMat);
    slabMain.position.set(-14, 106, 0);
    slabMain.castShadow = true;
    slabMain.receiveShadow = true;
    rockGroup.add(slabMain);

    const slabStep1 = new THREE.Mesh(new THREE.BoxGeometry(34, 135, 44), rockMat);
    slabStep1.position.set(-14, 67.5, 0);
    slabStep1.castShadow = true;
    slabStep1.receiveShadow = true;
    rockGroup.add(slabStep1);

    const wings = [];
    for (const cz of [-18, 18]) {
      const wing = new THREE.Mesh(new THREE.BoxGeometry(28, 28, 18), rockMat);
      wing.position.set(18, 14, cz);
      wing.castShadow = true;
      wing.receiveShadow = true;
      rockGroup.add(wing);
      wings.push(wing);
    }

    const prometheus = new THREE.Mesh(
      new THREE.TorusGeometry(2.6, 0.45, 10, 20),
      new THREE.MeshStandardNodeMaterial({ color: 0xffc845, metalness: 0.65, roughness: 0.22 })
    );
    prometheus.position.set(1, 3.8, 0);
    prometheus.rotation.y = Math.PI * 0.5;
    rockGroup.add(prometheus);

    group.add(rockGroup);
    fitToSite([rockGroup], site('30 Rockefeller Plaza'), { height: 259 });
    for (const p of [slabMain, slabStep1, ...wings, prometheus]) solid(p);
  }

  // =========================================================================
  // 8. CITIGROUP CENTER (Col 5, Row 1: Lexington Ave & 53rd St)
  // =========================================================================
  {
    const b = getBlockBounds(5, 1);
    const citiGroup = new THREE.Group();
    citiGroup.position.set(b.cx, 0, b.cz);

    const citiMat = landmarkSilverCurtainMat;

    const stilts = [];
    for (const [sx, sz] of [[-18, 0], [18, 0], [0, -18], [0, 18]]) {
      const stilt = new THREE.Mesh(new THREE.BoxGeometry(7.5, 30, 7.5), stainlessSteelMat);
      stilt.position.set(sx, 15, sz);
      stilt.castShadow = true;
      stilt.receiveShadow = true;
      citiGroup.add(stilt);
      stilts.push(stilt);
    }
    const core = new THREE.Mesh(new THREE.BoxGeometry(16, 30, 16), stainlessSteelMat);
    core.position.set(0, 15, 0);
    core.castShadow = true;
    core.receiveShadow = true;
    citiGroup.add(core);

    const citiShaft = new THREE.Mesh(new THREE.BoxGeometry(42, 145, 42), citiMat);
    citiShaft.position.set(0, 30 + 72.5, 0);
    citiShaft.castShadow = true;
    citiShaft.receiveShadow = true;
    citiGroup.add(citiShaft);

    const wedgeShape = new THREE.Shape();
    wedgeShape.moveTo(-21, 0);
    wedgeShape.lineTo(21, 0);
    wedgeShape.lineTo(-21, 34);
    wedgeShape.closePath();

    const wedgeGeo = new THREE.ExtrudeGeometry(wedgeShape, { depth: 42, bevelEnabled: false });
    wedgeGeo.translate(0, 0, -21);
    const citiCrown = new THREE.Mesh(wedgeGeo, stainlessSteelMat);
    citiCrown.position.set(0, 175, 0);
    citiGroup.add(citiCrown);

    group.add(citiGroup);
    fitToSite([citiGroup], site('Citigroup Center'), { height: 279 });
    // the plaza under the tower stays open between its four stilts & core; the sloped crown in four steps
    for (const p of [...stilts, core, citiShaft]) solid(p);
    for (let k = 0; k < 4; k++) solid(citiCrown, box3(-21 + k * 10.5, 0, -21, -10.5 + k * 10.5, 34 * (1 - k / 4), 21));
  }

  // =========================================================================
  // 9. FLATIRON BUILDING (Col 2, Row 7: 5th Ave / Broadway & 23rd St)
  // =========================================================================
  {
    const b = getBlockBounds(2, 7);
    const flatironGroup = new THREE.Group();
    // Sits on the triangular island between Broadway (x = -42) and 5th Ave (x = 0)
    flatironGroup.position.set(b.cx + 28, 0, b.cz - 4);

    const flatironMat = landmarkMarbleStoneMat;

    const triShape = new THREE.Shape();
    triShape.moveTo(0, -26);
    triShape.quadraticCurveTo(2.0, -26, 11, 24);
    triShape.lineTo(-13, 24);
    triShape.quadraticCurveTo(-2.5, -26, 0, -26);

    const flatGeo = new THREE.ExtrudeGeometry(triShape, {
      depth: 88,
      bevelEnabled: true,
      bevelThickness: 0.6,
      bevelSize: 0.6,
      bevelSegments: 2
    });
    flatGeo.rotateX(Math.PI * 0.5);
    flatGeo.translate(0, 88, 0);

    const flatironMesh = new THREE.Mesh(flatGeo, flatironMat);
    flatironMesh.castShadow = true;
    flatironMesh.receiveShadow = true;
    flatironGroup.add(flatironMesh);

    const corniceGeo = new THREE.ExtrudeGeometry(triShape, {
      depth: 2.8,
      bevelEnabled: true,
      bevelThickness: 0.8,
      bevelSize: 1.2,
      bevelSegments: 2
    });
    corniceGeo.rotateX(Math.PI * 0.5);
    corniceGeo.translate(0, 89.2, 0);
    const corniceMesh = new THREE.Mesh(corniceGeo, limestoneTrimMat);
    flatironGroup.add(corniceMesh);

    group.add(flatironGroup);
    fitToSite([flatironGroup], site('Flatiron Building'), { height: 87 });
    // The wedge in slices along its length, each as wide as the plan (plus the bevel) at its broad end: shape y is the
    // prism's z here, so its narrow prow carries no wall of empty air
    const plan = triShape.extractPoints(12).shape;
    const planWidth = (y0, y1) => {
      let lo = Infinity;
      let hi = -Infinity;
      for (let i = 0; i < plan.length; i++) {
        const p = plan[i];
        const q = plan[(i + 1) % plan.length];
        if (p.y >= y0 && p.y <= y1) { lo = Math.min(lo, p.x); hi = Math.max(hi, p.x); }
        for (const y of [y0, y1]) {
          if ((p.y - y) * (q.y - y) < 0) {
            const x = p.x + ((q.x - p.x) * (y - p.y)) / (q.y - p.y);
            lo = Math.min(lo, x);
            hi = Math.max(hi, x);
          }
        }
      }
      return [lo, hi];
    };
    const planBox = new THREE.Box2().setFromPoints(plan);
    const slices = (mesh, n, bevel, y0, y1) => {
      for (let k = 0; k < n; k++) {
        const z0 = planBox.min.y + ((planBox.max.y - planBox.min.y) * k) / n;
        const z1 = planBox.min.y + ((planBox.max.y - planBox.min.y) * (k + 1)) / n;
        const [lo, hi] = planWidth(z0, z1);
        solid(mesh, box3(lo - bevel, y0, k ? z0 : z0 - bevel, hi + bevel, y1, k < n - 1 ? z1 : z1 + bevel));
      }
    };
    slices(flatironMesh, 10, 0.85, -0.6, 85.6);
    slices(corniceMesh, 5, 1.7, 85.6, 90.0);
  }

  // =========================================================================
  // 10. SEAGRAM BUILDING & GRANITE PLAZA (Col 4, Row 1: Park Ave & 53rd St)
  // =========================================================================
  {
    const b = getBlockBounds(4, 1);
    const seagramGroup = new THREE.Group();
    seagramGroup.position.set(b.cx, 0, b.cz);

    const seagramMat = landmarkBronzeCurtainMat;

    const tower = new THREE.Mesh(new THREE.BoxGeometry(42, 162, 36), seagramMat);
    tower.position.set(8, 81, 0);
    tower.castShadow = true;
    tower.receiveShadow = true;
    seagramGroup.add(tower);

    const bustle = new THREE.Mesh(new THREE.BoxGeometry(24, 92, 26), seagramMat);
    bustle.position.set(22, 46, 0);
    bustle.castShadow = true;
    bustle.receiveShadow = true;
    seagramGroup.add(bustle);

    const poolMat = new THREE.MeshStandardNodeMaterial({ color: 0x1e5266, roughness: 0.1, metalness: 0.7 });
    const pools = [];
    for (const pz of [-14, 14]) {
      const pool = new THREE.Mesh(new THREE.BoxGeometry(14, 0.55, 12), poolMat);
      pool.position.set(-22, 0.32, pz);
      seagramGroup.add(pool);
      pools.push(pool);
    }

    group.add(seagramGroup);
    fitToSite([seagramGroup], site('Seagram Building'), { height: 157, offset: [-14, 0] });
    for (const p of [tower, bustle, ...pools]) solid(p);
  }

  // =========================================================================
  // 11. ONE WORLD TRADE CENTER (LOWER MANHATTAN · VESEY ST & FULTON ST)
  // =========================================================================
  {
    const owtcGroup = new THREE.Group();
    owtcGroup.position.set(-260, 0, 1234);

    const owtcMat = landmarkSilverCurtainMat;
    const podiumFinMat = new THREE.MeshStandardNodeMaterial({
      color: 0xc8d4e0,
      roughness: 0.22,
      metalness: 0.85
    });

    // 52m-tall Glass & Steel Podium Base with Vertical Prismatic Louver Fins
    const basePodium = new THREE.Mesh(new THREE.BoxGeometry(48, 52, 48), owtcMat);
    basePodium.position.y = 26;
    basePodium.castShadow = true;
    basePodium.receiveShadow = true;
    owtcGroup.add(basePodium);

    const finsNS = [];
    const finsEW = [];
    for (let f = -20; f <= 20; f += 5) {
      const finNS = new THREE.Mesh(new THREE.BoxGeometry(0.45, 44, 49.2), podiumFinMat);
      finNS.position.set(f, 28, 0);
      owtcGroup.add(finNS);

      const finEW = new THREE.Mesh(new THREE.BoxGeometry(49.2, 44, 0.45), podiumFinMat);
      finEW.position.set(0, 28, f);
      owtcGroup.add(finEW);
      finsNS.push(finNS);
      finsEW.push(finEW);
    }

    // Illuminated Vesey St / Fulton St Double-Height Glass Lobby Portals
    const lobbyNS = new THREE.Mesh(new THREE.BoxGeometry(24, 9.5, 48.6), warmFloodMat);
    lobbyNS.position.set(0, 4.8, 0);
    owtcGroup.add(lobbyNS);
    const lobbyEW = new THREE.Mesh(new THREE.BoxGeometry(48.6, 9.5, 24), warmFloodMat);
    lobbyEW.position.set(0, 4.8, 0);
    owtcGroup.add(lobbyEW);

    //Podium Setback Collar at y = 52m
    const podiumCollar = new THREE.Mesh(new THREE.BoxGeometry(49.6, 1.8, 49.6), podiumFinMat);
    podiumCollar.position.y = 52.0;
    owtcGroup.add(podiumCollar);

    // True Flat-Faceted Chamfered Square Antiprism Shaft (8 razor-sharp triangular glass planes)
    const shaft1Geo = new THREE.CylinderGeometry(23.5, 33.9, 235, 4).toNonIndexed();
    shaft1Geo.computeVertexNormals();
    const shaft1 = new THREE.Mesh(shaft1Geo, owtcMat);
    shaft1.rotation.y = Math.PI * 0.25;
    shaft1.position.y = 52 + 117.5;
    shaft1.castShadow = true;
    shaft1.receiveShadow = true;
    owtcGroup.add(shaft1);

    const shaft2Geo = new THREE.CylinderGeometry(33.9, 23.5, 235, 4).toNonIndexed();
    shaft2Geo.computeVertexNormals();
    const shaft2 = new THREE.Mesh(shaft2Geo, owtcMat);
    shaft2.position.y = 52 + 117.5;
    shaft2.castShadow = true;
    shaft2.receiveShadow = true;
    owtcGroup.add(shaft2);

    const parapetRing = new THREE.Mesh(new THREE.CylinderGeometry(19, 19, 8, 16), warmFloodMat);
    parapetRing.position.y = 291;
    owtcGroup.add(parapetRing);

    const spire = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 2.2, 68, 12), podiumFinMat);
    spire.position.y = 295 + 34;
    owtcGroup.add(spire);

    const beacon = new THREE.Mesh(new THREE.SphereGeometry(1.4, 10, 10), warmFloodMat);
    beacon.position.y = 364;
    owtcGroup.add(beacon);

    group.add(owtcGroup);
    fitToSite([owtcGroup], site('One World Trade Center'), { height: 541, horizontal: 1.27 }); // a 61 m square base
    for (const p of [basePodium, lobbyNS, lobbyEW, podiumCollar, parapetRing, spire, beacon]) solid(p);
    // the louvres standing proud of the podium's faces, each set on its own (a cross in plan)
    solidCluster(owtcGroup, finsNS);
    solidCluster(owtcGroup, finsEW);
    // The antiprism in six storeys of two boxes each: shaft1 is a square in plan, shrinking upwards (its cross-section
    // is a diamond in its own frame, turned 45°), shaft2 a diamond growing upwards (a square in shaft1's frame). Each box
    // takes its shaft's plan at the wider end of the storey.
    const r1 = (y) => 33.9 + ((23.5 - 33.9) * (y + 117.5)) / 235;
    const r2 = (y) => 23.5 + ((33.9 - 23.5) * (y + 117.5)) / 235;
    for (let k = 0; k < 6; k++) {
      const y0 = -117.5 + (235 * k) / 6;
      const y1 = -117.5 + (235 * (k + 1)) / 6;
      const h1 = r1(y0) * Math.SQRT1_2;
      const h2 = r2(y1) * Math.SQRT1_2;
      solid(shaft2, box3(-h1, y0, -h1, h1, y1, h1));
      solid(shaft1, box3(-h2, y0, -h2, h2, y1, h2));
    }
  }

  // =========================================================================
  // 12. NEW YORK STOCK EXCHANGE (LOWER MANHATTAN · WALL ST & BROAD ST)
  // =========================================================================
  // George B. Post's 1903 temple front on Broad St (six giant Corinthian columns between square end piers on a raised
  // base, the sculpted pediment, a big flag hung across the colonnade) before the ten-storey exchange, and the plainer
  // 1922 wing along Wall St. It stands turned with its streets on its real lot, inside the block's building line (street
  // trees line New St & Broad St just beyond it).
  {
    const lot = site('New York Stock Exchange');
    const line = buildingLine(lot);
    if (lot && line) {
      const BROAD = 0.0495; // Broad St runs 2.8° off the grid ...
      const WALL = -0.2148; // ... and Wall St 12.3° the other way (the block's frontage frames)
      const cs = Math.cos(BROAD);
      const sn = Math.sin(BROAD);
      // The Broad St front from the building line's Wall St corner to the lot's south end, wholly inside the line; the
      // back as far west as the line allows on New St. Local x points at Broad St, z down it.
      const len = (lot.z + lot.d / 2 - line[2]) / cs;
      const neX = line[1] - len * sn;
      const E = (neX - line[0]) / cs / 2;
      const N = len / 2;
      const nyse = new THREE.Group();
      nyse.name = 'NewYorkStockExchange';
      nyse.rotation.y = BROAD;
      nyse.position.set(neX - E * cs + N * sn, 0, line[2] + E * sn + N * cs);

      const TOP = 44; // the roof, under a cornice & parapet up to the building's real 47 m
      const T = 20.5; // half the temple front, centred on the Broad St front
      const RECESS = E - 6; // the colonnade's glass wall
      const marble = landmarkMarbleStoneMat;
      // Windows down to the street on every front (no storefronts), a blank wall on the neighbour's side
      const fronts = [WALL_KINDS.entry, WALL_KINDS.entry, WALL_KINDS.entry, WALL_KINDS.entry];
      const back = addBox(nyse, marble, -E, RECESS, 0, TOP, -N, N);
      back.userData.faces = [WALL_KINDS.entry, WALL_KINDS.entry, WALL_KINDS.entry, WALL_KINDS.blankStone];
      const northFront = addBox(nyse, marble, RECESS, E, 0, TOP, -N, -T);
      const southFront = addBox(nyse, marble, RECESS, E, 0, TOP, T, N);
      northFront.userData.faces = fronts;
      southFront.userData.faces = [WALL_KINDS.entry, WALL_KINDS.entry, WALL_KINDS.entry, WALL_KINDS.blankStone];

      // The temple front: the raised base with its doors, the end piers, the glass wall of the trading floor behind
      // six columns, the entablature with its lettered frieze, the pediment & its sculpture group
      const podium = addBox(nyse, limestoneTrimMat, RECESS, E, 0, 8, -T, T);
      for (const z of [-8, 0, 8]) addBox(nyse, warmFloodMat, E, E + 0.12, 0, 4.4, z - 1.5, z + 1.5, { cast: false });
      const piers = [
        addBox(nyse, limestoneTrimMat, RECESS, E, 8, 24, -T, -T + 4.5),
        addBox(nyse, limestoneTrimMat, RECESS, E, 8, 24, T - 4.5, T)
      ];
      const glassWall = addBox(nyse, landmarkBronzeCurtainMat, RECESS, RECESS + 0.25, 8, 24, -T + 4.5, T - 4.5);
      const colonnade = [];
      for (const z of [-13, -7.8, -2.6, 2.6, 7.8, 13]) {
        colonnade.push(
          addBox(nyse, limestoneTrimMat, E - 2, E, 8, 9.1, z - 1, z + 1),
          addPart(nyse, new THREE.CylinderGeometry(0.72, 0.82, 13.3, 14), limestoneTrimMat, E - 1, 15.75, z),
          addPart(nyse, new THREE.CylinderGeometry(1.15, 0.8, 1.6, 14), limestoneTrimMat, E - 1, 23.2, z)
        );
      }
      const entablature = addBox(nyse, limestoneTrimMat, RECESS, E + 0.5, 24, 28, -T - 0.5, T + 0.5);
      const ledge = addBox(nyse, limestoneTrimMat, RECESS, E + 1.1, 27.6, 28.4, -T - 1, T + 1);

      const friezeCanvas = document.createElement('canvas');
      friezeCanvas.width = 1024;
      friezeCanvas.height = 64;
      const fr = friezeCanvas.getContext('2d');
      fr.fillStyle = '#dad0bc';
      fr.fillRect(0, 0, 1024, 64);
      fr.fillStyle = '#5a5246';
      fr.font = '600 44px Georgia, "Times New Roman", serif';
      fr.textAlign = 'center';
      fr.textBaseline = 'middle';
      fr.fillText('NEW YORK STOCK EXCHANGE', 512, 34);
      const friezeTex = new THREE.CanvasTexture(friezeCanvas);
      friezeTex.colorSpace = THREE.SRGBColorSpace;
      const friezeMat = new THREE.MeshStandardNodeMaterial({ map: friezeTex, roughness: 0.68, metalness: 0.12 });
      const frieze = addPart(nyse, new THREE.PlaneGeometry(26, 1.6), friezeMat, E + 0.52, 25.9, 0, { cast: false });
      frieze.rotation.y = Math.PI * 0.5;

      const pedShape = new THREE.Shape();
      pedShape.moveTo(-T - 1, 0);
      pedShape.lineTo(T + 1, 0);
      pedShape.lineTo(0, 6.2);
      pedShape.closePath();
      const pedGeo = new THREE.ExtrudeGeometry(pedShape, { depth: 1.8, bevelEnabled: false });
      pedGeo.rotateY(Math.PI * 0.5); // the triangle across the front, 1.8 m deep
      const pediment = addPart(nyse, pedGeo, limestoneTrimMat, E - 1.5, 28.4, 0);
      const rake = Math.atan2(6.2, T + 1);
      const rakeLength = Math.hypot(6.2, T + 1) + 0.6;
      for (const s of [-1, 1]) {
        const rakingCornice = addPart(nyse, new THREE.BoxGeometry(1.4, 0.7, rakeLength), limestoneTrimMat, E + 0.4, 31.86, (s * (T + 1)) / 2);
        rakingCornice.rotation.x = s * rake;
      }
      // "Integrity Protecting the Works of Man": Integrity in the middle, the figures either side sinking under the slopes
      for (const [z, h, w] of [[0, 4.4, 1.6], [-4.5, 3.6, 1.5], [4.5, 3.6, 1.5], [-9, 2.6, 3], [9, 2.6, 3], [-14, 1.4, 4], [14, 1.4, 4],
        [-18.2, 0.5, 2.4], [18.2, 0.5, 2.4]]) {
        addBox(nyse, limestoneTrimMat, E + 0.3, E + 1, 28.4, 28.4 + h, z - w / 2, z + w / 2);
      }

      // The flag across the colonnade, hung from the entablature in front of the columns (canton to the viewer's left)
      const flagCanvas = document.createElement('canvas');
      flagCanvas.width = 494;
      flagCanvas.height = 260;
      const fl = flagCanvas.getContext('2d');
      for (let s = 0; s < 13; s++) {
        fl.fillStyle = s % 2 ? '#f4f1ea' : '#b22234';
        fl.fillRect(0, s * 20, 494, 20);
      }
      fl.fillStyle = '#3c3b6e';
      fl.fillRect(0, 0, 198, 140);
      fl.fillStyle = '#f4f1ea';
      for (let r = 0; r < 9; r++) {
        for (let c = 0; c < (r % 2 ? 5 : 6); c++) {
          const sx = 16.5 + c * 33 + (r % 2) * 16.5;
          const sy = 7 + r * 14;
          fl.beginPath();
          for (let k = 0; k < 10; k++) {
            const a = -Math.PI / 2 + (k * Math.PI) / 5;
            const rad = k % 2 ? 2.4 : 6;
            if (k) fl.lineTo(sx + Math.cos(a) * rad, sy + Math.sin(a) * rad);
            else fl.moveTo(sx + Math.cos(a) * rad, sy + Math.sin(a) * rad);
          }
          fl.closePath();
          fl.fill();
        }
      }
      const flagTex = new THREE.CanvasTexture(flagCanvas);
      flagTex.colorSpace = THREE.SRGBColorSpace;
      const flagMat = new THREE.MeshStandardNodeMaterial({ map: flagTex, roughness: 0.9, side: THREE.DoubleSide });
      const flag = addPart(nyse, new THREE.PlaneGeometry(26, 13.7), flagMat, E + 0.35, 24 - 0.3 - 6.85, 0, { cast: false });
      flag.rotation.y = Math.PI * 0.5;

      // Cornices & parapets round the roof (none over the temple front, which stops at its pediment)
      const roofline = [
        addBox(nyse, limestoneTrimMat, -E - 0.6, RECESS + 0.6, TOP, TOP + 1.2, -N - 0.6, N + 0.6),
        addBox(nyse, limestoneTrimMat, RECESS + 0.6, E + 0.6, TOP, TOP + 1.2, -N - 0.6, -T + 0.6),
        addBox(nyse, limestoneTrimMat, RECESS + 0.6, E + 0.6, TOP, TOP + 1.2, T - 0.6, N + 0.6),
        addBox(nyse, limestoneTrimMat, -E - 0.6, -E, TOP + 1.2, 47, -N - 0.6, N + 0.6),
        addBox(nyse, limestoneTrimMat, E, E + 0.6, TOP + 1.2, 47, -N - 0.6, -T + 0.6),
        addBox(nyse, limestoneTrimMat, E, E + 0.6, TOP + 1.2, 47, T - 0.6, N + 0.6),
        addBox(nyse, limestoneTrimMat, RECESS, RECESS + 0.6, TOP + 1.2, 47, -T + 0.6, T - 0.6)
      ];

      // The Wall St wing, turned onto Wall St from the Broad St corner, as long as New St allows
      const turn = WALL - BROAD;
      const ux = Math.cos(turn);
      const uz = -Math.sin(turn); // along Wall St, eastwards
      const vx = Math.sin(turn);
      const vz = Math.cos(turn); // across it, into the block
      const DEPTH = 12;
      const wingLen = (2 * E + DEPTH * vx) / ux;
      const along = (a, b) => [E - a * ux + b * vx, -N - a * uz + b * vz]; // a back from the corner, b in from Wall St
      const wingPart = (w, h, d, a, b, y) => {
        const [x, z] = along(a, b);
        const m = addPart(nyse, new THREE.BoxGeometry(w, h, d), y > TOP ? limestoneTrimMat : marble, x, y, z);
        m.rotation.y = turn;
        return m;
      };
      const wing = wingPart(wingLen, TOP, DEPTH, wingLen / 2, DEPTH / 2, TOP / 2);
      wing.userData.faces = fronts;
      const wingRoof = [
        wingPart(wingLen + 1.2, 1.2, DEPTH + 1.2, wingLen / 2, DEPTH / 2, TOP + 0.6),
        wingPart(wingLen + 1.2, 1.8, 0.6, wingLen / 2, -0.3, TOP + 2.1),
        wingPart(0.6, 1.8, DEPTH + 1.2, wingLen + 0.3, DEPTH / 2, TOP + 2.1)
      ];

      group.add(nyse);
      for (const p of [back, northFront, southFront, podium, ...piers, glassWall, ...colonnade, entablature, ledge, ...roofline,
        wing, ...wingRoof]) solid(p);
      // the pediment in three steps under its slopes (its frame: x through it, z across the front)
      for (let k = 0; k < 3; k++) solid(pediment, box3(0, (6.2 * k) / 3, -(T + 1) * (1 - k / 3), 1.8, (6.2 * (k + 1)) / 3, (T + 1) * (1 - k / 3)));
    }
  }

  // Box-shaped facade parts become box-local facade boxes: every wall laid out in whole window bays between solid
  // masonry corners, like the procedural blocks, so no window is cut by a corner. Parts turned about +y (the MetLife
  // tower's pointed ends, the Stock Exchange along Broad St) stay turned; tilted & non-box parts (Flatiron prism, One WTC
  // antiprism) keep the world-space window grid. A part's userData.faces sets its walls' WALL_KINDS (shop fronts all
  // round by default).
  group.updateMatrixWorld(true);
  const facadeBoxes = new Map();
  const boxParts = [];
  group.traverse((obj) => {
    if (obj.isMesh && boxLocalTwins.has(obj.material) && obj.geometry.type === 'BoxGeometry') boxParts.push(obj);
  });
  const partPos = new THREE.Vector3();
  const partRot = new THREE.Quaternion();
  const partScale = new THREE.Vector3();
  for (const m of boxParts) {
    m.matrixWorld.decompose(partPos, partRot, partScale);
    if (Math.abs(partRot.x) > 1e-5 || Math.abs(partRot.z) > 1e-5) continue;
    const { width, height, depth } = m.geometry.parameters;
    const twin = boxLocalTwins.get(m.material);
    if (!facadeBoxes.has(twin)) facadeBoxes.set(twin, []);
    facadeBoxes.get(twin).push({
      x: partPos.x,
      y: partPos.y,
      z: partPos.z,
      w: width * partScale.x,
      h: height * partScale.y,
      d: depth * partScale.z,
      ry: 2 * Math.atan2(partRot.y, partRot.w),
      faces: m.userData.faces
    });
    m.removeFromParent();
  }
  for (const [mat, boxes] of facadeBoxes) {
    const inst = createFacadeBoxes(mat, boxes);
    inst.castShadow = true;
    inst.receiveShadow = true;
    group.add(inst);
  }

  batchStaticGroupMeshes(group, new Set([stainlessSteelMat]));

  scene.add(group);
  return { group, colliders };
}

export { buildLandmarks, bryantParkLawn };
