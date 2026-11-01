// Point-mass flight with energy exchange, drag, flapping and a soft stall.
// Independent of rendering and wildfire playback. Units: metres, seconds, radians.
export const FORMS = {
  bird: { cruise: 17, stall: 7, max: 48, radius: .55, flap: 6.2, cooldown: .42, agility: 1.5 },
  dragon: { cruise: 25, stall: 11, max: 66, radius: 1.25, flap: 9, cooldown: .65, agility: .95 },
};
export const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
export function createFlight(position, yaw = 0, form = 'bird') {
  return { position: { ...position }, yaw, pitch: 0, bank: 0, speed: FORMS[form].cruise,
    form, cooldown: 0, flapPhase: 0, stall: 0, impact: 0, contacts: 0, distance: 0 };
}
export function flap(f) {
  if (f.cooldown > 0) return false;
  const spec = FORMS[f.form];
  f.speed = Math.min(spec.max, f.speed + spec.flap);
  f.cooldown = spec.cooldown; f.flapPhase = 1;
  return true;
}
export function advanceFlight(f, input, dt, wind = { x: 0, z: 0 }) {
  const spec = FORMS[f.form];
  f.cooldown = Math.max(0, f.cooldown - dt);
  f.flapPhase = Math.max(0, f.flapPhase - dt * 3.4);
  f.impact = Math.max(0, f.impact - dt);
  if (input.flap) flap(f);
  const turn = clamp(input.turn || 0, -1, 1), pitch = clamp(input.pitch || 0, -1, 1);
  f.yaw -= turn * spec.agility * dt * clamp(22 / Math.max(8, f.speed), .55, 1.5);
  f.pitch = clamp(f.pitch + pitch * .85 * dt, -1.25, 1.05);
  if (input.level) f.pitch *= Math.exp(-2 * dt);
  f.bank += (-turn * .48 - f.bank) * (1 - Math.exp(-5 * dt));
  // A dive converts altitude into speed; pulling up spends kinetic energy.
  const folded = input.dive ? .35 : 1;
  const drag = (.0065 + Math.abs(f.bank) * .006) * f.speed * f.speed * folded;
  // Tucking converts some extra downward motion into forward speed.
  const gravity = -9.81 * Math.sin(f.pitch) + (input.dive ? 3 : 0);
  f.speed = clamp(f.speed + (gravity - drag - (input.brake ? 14 : 0)) * dt, 2, spec.max);
  f.stall = clamp(1 - f.speed / spec.stall, 0, 1);
  const sink = .75 * folded + f.stall * f.stall * 12 + (input.dive ? 6 : 0);
  const c = Math.cos(f.pitch);
  return { x: (-Math.sin(f.yaw) * c * f.speed + wind.x) * dt,
    y: (Math.sin(f.pitch) * f.speed - sink) * dt,
    z: (-Math.cos(f.yaw) * c * f.speed + wind.z) * dt };
}
