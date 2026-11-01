import * as THREE from 'three';

// Lightweight creatures, drawn in world space and facing local -Z. Their
// dimensions are visual: the flight controller owns the collision body.
const damp = (a, b, rate, dt) => a + (b - a) * (1 - Math.exp(-rate * dt));
const MAT = (color, extra = {}) => new THREE.MeshStandardMaterial({
  color, roughness: .88, flatShading: true, ...extra,
});

function ellipsoid(parent, material, position, scale, sphere) {
  const mesh = new THREE.Mesh(sphere, material);
  mesh.position.set(...position); mesh.scale.set(...scale);
  mesh.castShadow = true; mesh.receiveShadow = true; parent.add(mesh);
  return mesh;
}

function polygon(points, material) {
  // Coordinates are [x, y, z] on a slightly curved X/Z surface. Triangulate
  // the outline rather than relying on a fan for the scalloped dragon wing.
  const contour = points.map(p => new THREE.Vector2(p[0], p[2]));
  const triangles = THREE.ShapeUtils.triangulateShape(contour, []);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(points.flat(), 3));
  geometry.setIndex(triangles.flat()); geometry.computeVertexNormals();
  const mesh = new THREE.Mesh(geometry, material); mesh.castShadow = true; mesh.receiveShadow = true;
  return mesh;
}

function bone(parent, material, from, to, radius, radiusEnd = radius * .65) {
  const start = new THREE.Vector3(...from), end = new THREE.Vector3(...to);
  const direction = end.clone().sub(start);
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radiusEnd, radius, direction.length(), 5), material);
  mesh.position.copy(start.add(end).multiplyScalar(.5));
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize());
  mesh.castShadow = true; parent.add(mesh); return mesh;
}

function cone(parent, material, position, radius, height, rotation = [0, 0, 0]) {
  const mesh = new THREE.Mesh(new THREE.ConeGeometry(radius, height, 6), material);
  mesh.position.set(...position); mesh.rotation.set(...rotation); mesh.castShadow = true; parent.add(mesh); return mesh;
}

function birdWing(side, materials) {
  const pivot = new THREE.Group(); pivot.position.set(side * .36, .15, -.16);
  const p = (x, y, z) => [x * side, y, z];
  // Broad upper wing and individually cut flight feathers make the silhouette
  // readable from above as well as from the chase camera.
  pivot.add(polygon([
    p(0, 0, -.33), p(.7, .05, -.43), p(1.5, .02, -.55), p(2.48, -.02, -.62),
    p(2.65, -.04, -.40), p(2.30, -.07, .02), p(1.98, -.05, .28),
    p(1.48, -.03, .55), p(.85, -.02, .60), p(.05, 0, .35),
  ], materials.wing));
  // Overlapping, pointed primaries with pale shafts. Alternating tones prevent
  // the wing from becoming a single flat triangle at typical camera distance.
  for (let i = 0; i < 8; i++) {
    const x = .65 + i * .22, z = .34 - i * .11, reach = .66 + i * .095;
    pivot.add(polygon([
      p(x, .008, z - .13), p(x + .24, .015, z - .16),
      p(x + reach, -.025, z + .25 - i * .025), p(x + reach * .65, -.015, z + .40 - i * .025),
    ], i % 2 ? materials.feather : materials.featherLight));
  }
  pivot.add(polygon([
    p(.05, .025, -.20), p(.72, .06, -.35), p(1.47, .03, -.43),
    p(2.33, .005, -.54), p(2.12, .01, -.40), p(1.40, .05, -.29), p(.45, .04, -.12),
  ], materials.highlight));
  return pivot;
}

function dragonWing(side, materials) {
  const pivot = new THREE.Group(); pivot.position.set(side * .55, .32, -.18);
  const p = (x, y, z) => [side * x, y, z];
  const shoulder = p(0, 0, -.35), wrist = p(1.4, .13, -.78), tip = p(3.48, .06, -1.36);
  const f1 = p(3.0, -.1, .28), f2 = p(2.2, -.14, .98), f3 = p(1.3, -.12, 1.32), root = p(.08, 0, .65);
  // Concave trailing edge is deliberately scalloped between the long fingers.
  pivot.add(polygon([shoulder, wrist, tip, p(3.22, -.01, -.65), f1,
    p(2.42, -.06, .47), f2, p(1.73, -.06, .73), f3, p(.88, -.04, .80), root], materials.membrane));
  pivot.add(polygon([shoulder, wrist, tip, p(3.15, .02, -.94), p(1.45, .14, -.55), p(.08, .03, -.10)], materials.membraneLight));
  for (const [from, to, radius] of [[shoulder, wrist, .13], [wrist, tip, .105], [wrist, f1, .066], [wrist, f2, .07], [wrist, f3, .07], [wrist, root, .08]]) {
    bone(pivot, materials.bone, from, to, radius, radius * .35);
  }
  // Little wing claws at the wrists give the dragon a clear silhouette.
  cone(pivot, materials.horn, p(1.36, .12, -.95), .12, .48, [-Math.PI / 2, 0, side * .38]);
  return pivot;
}

function buildBird(sphere) {
  const group = new THREE.Group();
  const m = {
    body: MAT(0x735039), light: MAT(0xdbc6a1), dark: MAT(0x3c2d24),
    wing: MAT(0x795942, { side: THREE.DoubleSide }),
    feather: MAT(0x3c3029, { side: THREE.DoubleSide }),
    featherLight: MAT(0x574034, { side: THREE.DoubleSide }),
    highlight: MAT(0xb49a77, { side: THREE.DoubleSide }),
    gold: MAT(0xd3a34b), eye: MAT(0x171814, { roughness: .3 }),
  };
  ellipsoid(group, m.body, [0, 0, .04], [.48, .40, .86], sphere);
  ellipsoid(group, m.light, [0, -.15, -.24], [.36, .23, .57], sphere);
  ellipsoid(group, m.light, [0, .20, -.77], [.34, .32, .38], sphere);
  cone(group, m.gold, [0, .17, -1.19], .19, .42, [-Math.PI / 2, 0, 0]);
  for (const side of [-1, 1]) {
    ellipsoid(group, m.eye, [side * .29, .23, -.88], [.052, .052, .055], sphere);
    ellipsoid(group, m.gold, [side * .20, -.32, .37], [.055, .15, .055], sphere);
  }
  const wings = [-1, 1].map(side => birdWing(side, m)); wings.forEach(w => group.add(w));
  const tail = new THREE.Group(); tail.position.set(0, .02, .65); group.add(tail);
  for (let i = -3; i <= 3; i++) {
    const angle = i * .15, mesh = polygon([
      [-.14, 0, -.08], [.14, 0, -.08], [.13, 0, 1.05], [0, -.012, 1.28], [-.13, 0, 1.05],
    ], i % 2 ? m.featherLight : m.feather);
    mesh.rotation.y = angle; mesh.position.x = i * .065; tail.add(mesh);
  }
  return { group, wings, tail };
}

function buildDragon(sphere) {
  const group = new THREE.Group();
  const m = {
    scale: MAT(0x843d30), dark: MAT(0x4c2826), belly: MAT(0xc98259),
    membrane: MAT(0xa84e3c, { side: THREE.DoubleSide }),
    membraneLight: MAT(0xc56b4b, { side: THREE.DoubleSide }),
    bone: MAT(0x63302b), horn: MAT(0xe1c79a), eye: MAT(0xe8ba45, { emissive: 0x61400c, emissiveIntensity: .3 }),
  };
  ellipsoid(group, m.scale, [0, 0, 0], [.72, .62, 1.27], sphere);
  ellipsoid(group, m.belly, [0, -.30, -.10], [.56, .38, 1.03], sphere);
  ellipsoid(group, m.scale, [0, .34, -1.03], [.49, .48, .74], sphere);
  ellipsoid(group, m.scale, [0, .32, -1.57], [.49, .34, .53], sphere);
  ellipsoid(group, m.dark, [0, .12, -1.85], [.40, .17, .26], sphere);
  for (const side of [-1, 1]) {
    ellipsoid(group, m.eye, [side * .42, .46, -1.52], [.085, .075, .075], sphere);
    cone(group, m.horn, [side * .31, .72, -1.10], .13, .67, [1.05, 0, side * -.35]);
    cone(group, m.horn, [side * .48, .50, -.94], .09, .42, [1.1, 0, side * -.7]);
    const leg = ellipsoid(group, m.scale, [side * .57, -.38, .54], [.19, .30, .25], sphere);
    leg.rotation.z = side * -.35;
    for (let t = -1; t <= 1; t++) cone(group, m.horn, [side * .62 + t * .095, -.60, .40], .045, .16, [-Math.PI / 2, 0, 0]);
  }
  const wings = [-1, 1].map(side => dragonWing(side, m)); wings.forEach(w => group.add(w));
  // Jointed tail tapers away from the camera, with a spade-shaped tip.
  const tail = new THREE.Group(); tail.position.set(0, .08, 1.0); group.add(tail);
  for (let i = 0; i < 5; i++) {
    const width = .43 - i * .07;
    ellipsoid(tail, i % 2 ? m.dark : m.scale, [0, -i * .065, i * .53], [width, width * .8, .43], sphere);
    cone(tail, m.horn, [0, .31 - i * .085, i * .48], .10 - i * .01, .30 - i * .025);
  }
  tail.add(polygon([[0, -.27, 3.06], [-.42, -.20, 2.59], [0, -.15, 2.28], [.42, -.20, 2.59]], m.membrane));
  for (let i = 0; i < 5; i++) cone(group, m.horn, [0, .53, -.70 + i * .34], .12, .33);
  return { group, wings, tail };
}

/**
 * A third-person creature for the existing flight state.
 *
 * new FlightAvatar(scene): attaches a hidden root to the scene.
 * setForm('bird' | 'dragon'): selects the body without rebuilding it.
 * setVisible(boolean): show or hide it when entering/leaving flight.
 * update(state, dt, input): positions and animates it. state is the object
 * returned by createFlight; input.dive folds the wings, input.flap is optional.
 * dispose(): removes the root and frees geometries and materials.
 */
export class FlightAvatar {
  constructor(scene) {
    this.scene = scene; this.root = new THREE.Group(); this.root.name = 'Flight creature';
    this.root.visible = false; scene.add(this.root);
    const sphere = new THREE.SphereGeometry(1, 12, 8);
    this.creatures = { bird: buildBird(sphere), dragon: buildDragon(sphere) };
    this.root.add(this.creatures.bird.group, this.creatures.dragon.group);
    this.form = ''; this.elapsed = 0; this.wingAngle = 0;
    this.motionPreference = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
    this.setForm('bird');
  }
  setForm(form) {
    if (!(form in this.creatures)) throw new Error(`Unknown creature: ${form}`);
    this.form = form;
    for (const [name, creature] of Object.entries(this.creatures)) creature.group.visible = name === form;
    this.root.name = form === 'bird' ? 'Bird' : 'Dragon';
  }
  setVisible(visible) { this.root.visible = Boolean(visible); }
  update(state, dt, input = {}) {
    const creature = this.creatures[this.form];
    this.root.position.set(state.position.x, state.position.y, state.position.z);
    this.root.rotation.set(state.pitch, state.yaw, state.bank || 0, 'YXZ');
    this.elapsed += dt;
    // flapPhase resets on an actual impulse, not merely while holding the key.
    // A shallow slow cycle keeps gliding wings alive while remaining comfortable.
    const flap = Math.max(0, state.flapPhase || 0);
    const reducedMotion = this.motionPreference?.matches;
    const beat = Math.sin((1 - flap) * Math.PI * 2) * flap;
    const glide = reducedMotion ? 0 : Math.sin(this.elapsed * 1.7) * .035;
    const target = input.dive ? -.70 : glide + beat * (reducedMotion ? .35 : .75);
    this.wingAngle = damp(this.wingAngle, target, 12, dt);
    creature.wings[0].rotation.z = -this.wingAngle;
    creature.wings[1].rotation.z = this.wingAngle;
    creature.wings[0].rotation.y = input.dive ? .55 : .03;
    creature.wings[1].rotation.y = input.dive ? -.55 : -.03;
    const tailIdle = reducedMotion ? 0 : Math.sin(this.elapsed * 2) * .05;
    creature.tail.rotation.y = damp(creature.tail.rotation.y, -(state.bank || 0) * .4 + tailIdle, 5, dt);
    creature.tail.rotation.x = damp(creature.tail.rotation.x, state.pitch * -.13, 5, dt);
  }
  dispose() {
    this.scene.remove(this.root);
    const geometries = new Set(), materials = new Set();
    this.root.traverse(obj => {
      if (obj.geometry) geometries.add(obj.geometry);
      if (obj.material) for (const mat of Array.isArray(obj.material) ? obj.material : [obj.material]) materials.add(mat);
    });
    for (const geometry of geometries) geometry.dispose();
    for (const material of materials) material.dispose();
  }
}
