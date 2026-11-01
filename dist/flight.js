import * as THREE from 'three';
import { FORMS, createFlight, advanceFlight, clamp } from './flight-physics.js';
import { FlightAvatar } from './flight-avatar.js';
import { FlightGame } from './flight-game.js';
import { DragonBreath } from './dragon-breath.js';

export class FlightMode {
  constructor({ scene, camera, controls, canvas, sim, keys, notify, onEnter, toggleSimulation, supported }) {
    Object.assign(this, { scene, camera, controls, canvas, sim, keys, notify, onEnter, toggleSimulation, supported });
    this.active = false; this.loading = false; this.mouse = { x: 0, y: 0 }; this.touch = { turn: 0, pitch: 0 };
    this.clock = 0; this.saved = null;
    this.cameraView = 'chase'; this.snapCamera = true;
    this.pendingLookX = 0; this.pendingLookY = 0;
    this.cameraGoal = new THREE.Vector3(); this.cameraSmooth = new THREE.Vector3();
    this.flightPosition = new THREE.Vector3(); this.flightDirection = new THREE.Vector3(); this.lookTarget = new THREE.Vector3();
    this.panel = document.getElementById('flight-panel'); this.hud = document.getElementById('flight-hud');
    this.status = document.getElementById('flight-status'); this.readout = document.getElementById('flight-readout');
    this.wings = this.makeWings(); camera.add(this.wings);
    for (const form of ['bird', 'dragon']) document.getElementById(`fly-${form}`).onclick = () => this.enter(form);
    document.getElementById('flight-exit').onclick = () => this.exit();
    document.getElementById('flight-transform').onclick = () => this.enter(this.flight.form === 'bird' ? 'dragon' : 'bird');
    document.getElementById('flight-camera').onclick = () => this.toggleCamera();
    document.getElementById('flight-simulation').onclick = () => this.toggleSimulation();
    document.getElementById('flight-trail').onclick = () => {
      if (!this.active) return;
      const enabled = !this.game.enabled;
      this.game.setEnabled(enabled, this.flight);
      const button = document.getElementById('flight-trail');
      button.textContent = enabled ? 'Trail: On' : 'Trail: Off';
      button.setAttribute('aria-pressed', String(enabled));
      document.getElementById('flight-objective').hidden = !enabled;
    };
    canvas.addEventListener('click', () => { if (this.active && !matchMedia('(pointer: coarse)').matches) canvas.requestPointerLock?.()?.catch?.(() => this.notify('Use arrow keys to steer, or drag to look.')); });
    canvas.addEventListener('pointerdown', e => { if (this.active && document.pointerLockElement !== canvas) { this.drag = { id: e.pointerId, x: e.clientX, y: e.clientY }; canvas.setPointerCapture(e.pointerId); } });
    canvas.addEventListener('pointermove', e => {
      if (!this.active) return;
      if (document.pointerLockElement === canvas) { this.mouse.x += e.movementX; this.mouse.y += e.movementY; }
      else if (this.drag?.id === e.pointerId) { this.mouse.x += e.clientX - this.drag.x; this.mouse.y += e.clientY - this.drag.y; this.drag.x = e.clientX; this.drag.y = e.clientY; }
    });
    document.addEventListener('pointerlockchange', () => {
      const locked = document.pointerLockElement === canvas;
      if (this.hadPointerLock && !locked && this.active && !document.getElementById('help-dialog').open) this.exit();
      this.hadPointerLock = locked;
    });
    const release = () => { this.drag = null; this.touch.turn = this.touch.pitch = 0; this.touch.flap = this.touch.dive = this.touch.fire = false; };
    canvas.addEventListener('pointerup', () => this.drag = null);
    canvas.addEventListener('pointercancel', () => this.drag = null);
    window.addEventListener('blur', release); document.addEventListener('visibilitychange', release);
    document.getElementById('help-dialog').addEventListener('close', () => { this.suspended = false; });
    for (const button of document.querySelectorAll('[data-flight-control]')) {
      const key = button.dataset.flightControl;
      const set = value => {
        if (key === 'left' || key === 'right') this.touch.turn = value ? (key === 'left' ? -1 : 1) : 0;
        else if (key === 'up' || key === 'down') this.touch.pitch = value ? (key === 'up' ? 1 : -1) : 0;
        else this.touch[key] = value;
      };
      button.addEventListener('pointerdown', e => { e.preventDefault(); button.setPointerCapture(e.pointerId); set(true); });
      for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) button.addEventListener(event, () => set(false));
      button.addEventListener('keydown', e => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); set(true); } });
      button.addEventListener('keyup', () => set(false));
      button.addEventListener('blur', () => set(false));
    }
  }
  makeWings() {
    const group = new THREE.Group(); group.visible = false; group.scale.setScalar(.45); group.position.set(0,-.35,-.8);
    this.wingMaterial = new THREE.MeshBasicMaterial({ color: 0x9b886b, side: THREE.DoubleSide, depthTest: false, depthWrite: false });
    for (const side of [-1, 1]) {
      const pivot = new THREE.Group(); pivot.position.set(side * .2, -.32, -.62);
      const geometry = new THREE.BufferGeometry();
      // Swept silhouette with feathered fingers; dragon switches to a membrane.
      const points = [0,0,0, side*1.6,.05,-.45, side*1.1,0,.65,
        0,0,0, side*1.1,0,.65, side*.55,0,.4];
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
      const mesh = new THREE.Mesh(geometry, this.wingMaterial); mesh.renderOrder = 100;
      pivot.add(mesh);
      for (let j = 0; j < 6; j++) {
        const feather = new THREE.Mesh(new THREE.ConeGeometry(.09, .65, 3), this.wingMaterial);
        feather.rotation.x = Math.PI / 2; feather.rotation.z = side * (.2 + j * .08);
        feather.position.set(side * (.65 + j * .15), -.01, .45 - j * .06); pivot.add(feather);
      }
      group.add(pivot);
    }
    return group;
  }
  async enter(form) {
    if (!this.supported) { this.notify('Flight needs WebGL 2. Enable hardware acceleration and reload to fly.'); return; }
    if (this.loading) return;
    if (!this.active) {
      this.loading = true; this.status.textContent = 'Preparing flight…';
      try {
        const { FlightCollision, loadFlightPhysics } = await import('./flight-collision.js');
        await loadFlightPhysics();
        this.collision = new FlightCollision(this.sim);
        const p = this.camera.position;
        this.flight = createFlight({ x: p.x, y: this.sim.height(p.x,p.z)+28, z: p.z }, 0, form);
        this.flight.pitch = -.08;
        const direction = new THREE.Vector3(); this.camera.getWorldDirection(direction);
        this.flight.yaw = Math.atan2(-direction.x, -direction.z);
        this.collision.refresh(this.flight.position, 0, true);
        this.safeSpawn();
        this.avatar = new FlightAvatar(this.scene);
        this.game = new FlightGame({ scene: this.scene, sim: this.sim });
        this.game.start(this.flight);
        document.getElementById('flight-objective').hidden = false;
        document.getElementById('flight-trail').textContent = 'Trail: On';
        document.getElementById('flight-trail').setAttribute('aria-pressed', 'true');
        this.breath = new DragonBreath({ scene: this.scene, sim: this.sim });
        this.saved = { position: this.camera.position.clone(), target: this.controls.target.clone(), fov: this.camera.fov, near: this.camera.near };
        this.onEnter(); this.accumulator = 0; this.tucked = false; this.wingsBlocked = false; this.breathState = null; this.pendingLookX = this.pendingLookY = 0; this.controls.enabled = false; this.active = true; this.snapCamera = true;
        this.camera.near = .1; this.camera.updateProjectionMatrix();
        this.canvas.setAttribute('aria-label', 'Flight viewport. Arrow keys steer; Space flaps; Shift dives; Escape exits.');
        this.notify('You’re airborne! Space to flap · ↑ climb · ↓ dive · A/D turn');
      } catch (error) {
        this.collision?.dispose(); this.collision = null;
        this.avatar?.dispose(); this.avatar = null; this.game?.dispose(); this.game = null;
        this.breath?.dispose(); this.breath = null;
        this.notify('Flight could not start. Try again.'); console.error('Flight initialization:', error); return;
      } finally { this.loading = false; this.status.textContent = 'Choose your wings'; }
    }
    this.flight.form = form; this.flight.speed = Math.max(this.flight.speed, FORMS[form].cruise); this.safeSpawn();
    this.avatar.setForm(form); this.avatar.setVisible(this.cameraView === 'chase');
    document.getElementById('flight-breath-status').hidden = form !== 'dragon';
    document.getElementById('flight-breath-control').hidden = form !== 'dragon';
    this.wingMaterial.color.setHex(form === 'dragon' ? 0x974d39 : 0xa69776);
    this.wings.children.forEach(wing => wing.children.forEach((part, i) => { if (i) part.visible = form === 'bird'; }));
    this.wings.visible = this.cameraView === 'first'; this.hud.hidden = false; this.panel.hidden = true;
    this.mouse.x = this.mouse.y = 0;
    document.body.dataset.flight = form;
    for (const name of ['bird', 'dragon']) document.getElementById(`fly-${name}`).setAttribute('aria-pressed', String(name === form));
    document.getElementById('flight-transform').textContent = form === 'bird' ? 'Become a dragon' : 'Become a bird';
    this.canvas.focus();
  }
  safeSpawn() {
    const p = this.flight.position;
    p.y = Math.max(p.y, this.sim.height(p.x, p.z) + 5);
    // Transforming to a larger body must never start inside a canopy.
    for (let i = 0; i < 100 && this.collision.overlapsCreature(this.flight); i++) p.y += 1;
  }
  syncPlayback(paused) {
    const button = document.getElementById('flight-simulation');
    button.textContent = paused ? 'Resume fire' : 'Pause fire';
    button.setAttribute('aria-label', paused ? 'Resume wildfire simulation' : 'Pause wildfire simulation');
    button.setAttribute('aria-pressed', String(paused));
  }
  toggleCamera() {
    if (!this.active) return;
    this.cameraView = this.cameraView === 'chase' ? 'first' : 'chase';
    this.snapCamera = true;
    this.wings.visible = this.cameraView === 'first';
    this.avatar?.setVisible(this.cameraView === 'chase');
    const button = document.getElementById('flight-camera');
    button.textContent = this.cameraView === 'chase' ? 'Camera: Chase' : 'Camera: First person';
    button.setAttribute('aria-pressed', String(this.cameraView === 'first'));
  }
  updateCamera(dt, f) {
    const position = this.flightPosition.set(f.position.x, f.position.y, f.position.z);
    const cp = Math.cos(f.pitch);
    const direction = this.flightDirection.set(-Math.sin(f.yaw) * cp, Math.sin(f.pitch), -Math.cos(f.yaw) * cp);
    // Streaming and weather follow the creature rather than the chase camera.
    this.controls.target.copy(position);
    if (this.cameraView === 'first') {
      this.camera.position.copy(position);
      this.camera.rotation.order = 'YXZ';
      this.camera.rotation.set(f.pitch, f.yaw, f.bank * .25, 'YXZ');
    } else {
      const distance = f.form === 'dragon' ? 16 : 10;
      const height = f.form === 'dragon' ? 4.6 : 2.8;
      this.cameraGoal.copy(position).addScaledVector(direction, -distance);
      this.cameraGoal.y += height;
      if (this.snapCamera) this.cameraSmooth.copy(this.cameraGoal);
      else this.cameraSmooth.lerp(this.cameraGoal, 1 - Math.exp(-5 * dt));
      // Sweep from the player to the desired camera before looking at the avatar.
      // A near branch pulls the camera in rather than letting it see through the forest.
      const origin = { x: position.x, y: position.y, z: position.z };
      const delta = { x: this.cameraSmooth.x - origin.x, y: this.cameraSmooth.y - origin.y, z: this.cameraSmooth.z - origin.z };
      const hit = this.collision.sweep(origin, delta, .3);
      const fraction = hit ? clamp(hit.fraction, 0, 1) : 1;
      this.camera.position.set(origin.x + delta.x * fraction, origin.y + delta.y * fraction, origin.z + delta.z * fraction);
      this.lookTarget.copy(position).addScaledVector(direction, 5);
      this.camera.lookAt(this.lookTarget);
    }
    this.snapCamera = false;
    const targetFov = 65 + clamp((f.speed - 16) * .3, 0, 14);
    this.camera.fov += (targetFov - this.camera.fov) * (1 - Math.exp(-3 * dt));
    this.camera.updateProjectionMatrix(); this.camera.updateMatrixWorld();
  }
  exit() {
    if (!this.active) return;
    this.active = false; this.suspended = false; this.touch = {turn:0,pitch:0}; this.drag = null; this.wings.visible = false; this.hud.hidden = true; this.panel.hidden = false;
    if (document.pointerLockElement === this.canvas) document.exitPointerLock();
    this.camera.position.copy(this.saved.position); this.controls.target.copy(this.saved.target);
    this.camera.fov = this.saved.fov; this.camera.near = this.saved.near; this.camera.rotation.order = 'XYZ'; this.camera.rotation.z = 0;
    this.camera.updateProjectionMatrix(); this.controls.enabled = true; this.controls.update();
    this.collision.dispose(); this.collision = null; this.keys.clear();
    this.avatar?.dispose(); this.avatar = null; this.game?.dispose(); this.game = null;
    this.breath?.dispose(); this.breath = null;
    delete document.body.dataset.flight;
    for (const name of ['bird', 'dragon']) document.getElementById(`fly-${name}`).setAttribute('aria-pressed', 'false');
    this.canvas.setAttribute('aria-label', 'Forest viewport — drag to orbit, scroll to zoom, WASD to travel');
  }
  update(dt, weather) {
    if (!this.active) return;
    if (document.getElementById('help-dialog').open || this.suspended) return;
    const f = this.flight, k = this.keys;
    this.pendingLookX += this.mouse.x; this.pendingLookY += this.mouse.y;
    this.mouse.x = this.mouse.y = 0;
    const input = {
      turn: (k.has('d') || k.has('arrowright') ? 1 : 0) - (k.has('a') || k.has('arrowleft') ? 1 : 0) + this.touch.turn,
      pitch: (k.has('s') || k.has('arrowup') ? 1 : 0) - (k.has('w') || k.has('arrowdown') ? 1 : 0) + this.touch.pitch,
      flap: k.has(' ') || this.touch.flap, dive: k.has('shift') || this.touch.dive,
      fire: k.has('f') || this.touch.fire,
      brake: k.has('control'), level: k.has('l'),
    };
    this.collision.refresh(f.position, dt);
    const wind = { x: Math.cos(weather.windAngle) * weather.windSpeed / 3.6 * .45, z: Math.sin(weather.windAngle) * weather.windSpeed / 3.6 * .45 };
    // Fixed substeps make energy and steering independent of display frame rate.
    this.accumulator = Math.min(.12, (this.accumulator || 0) + dt);
    while (this.accumulator >= 1/60) {
      const previous = {yaw:f.yaw, pitch:f.pitch, bank:f.bank, tucked:this.tucked};
      const before = { ...f.position };
      // Mouse turns belong to the same sweep as movement, so wings cannot
      // rotate through a nearby trunk between fixed physics steps.
      f.yaw -= this.pendingLookX * .0023;
      f.pitch = clamp(f.pitch - this.pendingLookY * .002, -1.25, 1.05);
      this.pendingLookX = this.pendingLookY = 0;
      const delta = advanceFlight(f, input, 1/60, wind);
      const collided = this.collision.moveCreature(f, delta, {tucked:!!input.dive, previous});
      const wingsBlocked = !!f.wingsBlocked;
      const effectiveTuck = !!input.dive || wingsBlocked;
      if (collided) {
        if (f.impact <= 0) { f.contacts++; f.speed = Math.max(4, f.speed * .45); }
        f.impact = .4;
        // A soft rebound creates room to turn away, without teleporting through trees.
        const back = { x: -delta.x * .35, y: Math.max(.025, -delta.y * .35), z: -delta.z * .35 };
        this.collision.moveCreature(f, back, {tucked:effectiveTuck, previous:{yaw:f.yaw,pitch:f.pitch,bank:f.bank,tucked:effectiveTuck}});
      }
      this.tucked = effectiveTuck; this.wingsBlocked = wingsBlocked;
      f.distance += Math.hypot(f.position.x - before.x, f.position.y - before.y, f.position.z - before.z);
      this.accumulator -= 1/60;
    }
    this.clock += dt;
    this.updateCamera(dt, f);
    this.avatar.update(f, dt, { ...input, dive: this.tucked });
    // If a close obstruction forces the camera into the player, hide the
    // creature briefly instead of drawing its interior across the screen.
    this.avatar.setVisible(this.cameraView === 'chase' && this.camera.position.distanceTo(this.flightPosition) > 2.2);
    const trail = this.game.update(f, dt);
    document.getElementById('flight-game-status').textContent = `${trail.rings} ${trail.rings === 1 ? 'ring' : 'rings'} · ${trail.score} pts · ${trail.streak} streak`;
    document.getElementById('flight-game-feedback').textContent = trail.event || `${trail.distance} m ${trail.direction} · fly through the ring`;
    this.breathState = this.breath.update(f, dt, input.fire);
    if (f.form === 'dragon') {
      const b = this.breathState;
      const label = b.overheated ? 'Fire recovering' : b.firing ? (b.hit?.kind === 'tree' || b.hit?.kind === 'ground' ? 'Breathing fire' : 'Aim at the forest') : 'Fire ready · hold F';
      document.getElementById('flight-breath-status').textContent = `${label} · ${Math.round(b.fuel)}%`;
    }
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const beat = Math.sin((1 - f.flapPhase) * Math.PI * 2) * f.flapPhase;
    this.wings.children.forEach((wing, i) => {
      const side = i ? 1 : -1;
      wing.rotation.z = side * (this.tucked ? -.95 : (reduced ? 0 : beat * .7));
      wing.position.y = -.32 + (reduced ? 0 : Math.sin(this.clock * 2) * .015);
    });
    const altitude = Math.max(0, f.position.y - this.sim.height(f.position.x, f.position.z));
    this.readout.textContent = `${f.form === 'bird' ? 'BIRD' : 'DRAGON'} · ${Math.round(f.speed * 3.6)} km/h · ${Math.round(altitude)} m above ground`;
    const message = this.wingsBlocked ? 'Wings tucked — clear the trees' : f.impact > 0 ? 'Bump! Pull up and turn away' : f.stall > .15 ? 'Stalling — flap or nose down' : input.dive ? 'Wings tucked · diving' : f.flapPhase > .1 ? 'Flapping' : f.pitch > .2 ? 'Climbing · spending speed' : f.pitch < -.2 ? 'Diving · gaining speed' : 'Gliding';
    document.getElementById('flight-feedback').textContent = message;
  }
  diagnostics() {
    if (!this.active) return { active: false };
    const f = this.flight;
    return { active: true, form: f.form, camera: this.cameraView, speed: f.speed, yaw: f.yaw, pitch: f.pitch, position: { ...f.position }, contacts: f.contacts,
      avatarVisible: this.avatar?.root.visible, trail: this.game?.snapshot(f), breath: this.breathState,
      stall: f.stall, clearance: f.position.y - this.sim.height(f.position.x, f.position.z), overlapping: this.collision.overlapsCreature(f, !!this.tucked) };
  }
}
