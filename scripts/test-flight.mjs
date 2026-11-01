import assert from 'node:assert/strict';
import { createFlight, advanceFlight, flap, FORMS } from '../dist/flight-physics.js';
import { FlightCollision, loadFlightPhysics } from '../dist/flight-collision.js';
const step = (f, input, seconds, hz=120) => { for(let i=0;i<seconds*hz;i++) advanceFlight(f,input,1/hz); return f; };
const dive = createFlight({x:0,y:100,z:0}), climb = createFlight({x:0,y:100,z:0});
dive.pitch=-.6;climb.pitch=.6;step(dive,{},1);step(climb,{},1);
assert.ok(dive.speed>17 && climb.speed<17,'diving gains speed while climbing spends it');
const bird=createFlight({x:0,y:100,z:0}); assert.ok(flap(bird));assert.equal(flap(bird),false,'flaps have a cooldown');
const stalled=createFlight({x:0,y:100,z:0});stalled.speed=2;
assert.ok(advanceFlight(stalled,{},1/120).y<-.05,'stall produces a meaningful sink');
flap(stalled);assert.ok(stalled.speed>FORMS.bird.stall,'flap can recover flight speed');
const a=createFlight({x:0,y:100,z:0}), b=createFlight({x:0,y:100,z:0});
step(a,{turn:.5,pitch:-.1},3,120);step(b,{turn:.5,pitch:-.1},3,240);
assert.ok(Math.abs(a.speed-b.speed)<.04 && Math.abs(a.yaw-b.yaw)<.01,'physics converges across step rates');
await loadFlightPhysics();
const sim={trees:()=>new Float32Array([0,0,0,20,3,1,0,0,0,42]),height:()=>0};
const world=new FlightCollision(sim);world.refresh({x:0,y:10,z:0},0,true);
for(const form of ['bird','dragon']){
 const p={x:-20,y:10,z:0}, radius=FORMS[form].radius;
 assert.ok(world.move(p,{x:100,y:0,z:0},radius),'swept body hits canopy even in a 100m step');
 assert.ok(p.x<0 && !world.overlaps(p,radius),'body stops outside canopy');
 const ground={x:30,y:10,z:30};assert.ok(world.move(ground,{x:0,y:-100,z:0},radius));
 assert.ok(ground.y>=radius && !world.overlaps(ground,radius),'ground stops high-speed dives');
}
const free={x:-20,y:40,z:0};assert.equal(world.move(free,{x:100,y:0,z:0},.55),false);assert.equal(free.x,80,'can fly above canopy');
world.dispose();
console.log('PASS flight energy, flap cooldown, stall recovery, timestep convergence, bird/dragon swept canopy and terrain collisions, clear-air travel.');
const stumps={trees:()=>new Float32Array([0,0,0,20,3,-1,0,1,0,42]),height:()=>0};
const cutWorld=new FlightCollision(stumps);cutWorld.refresh({x:0,y:10,z:0},0,true);
const gap={x:-20,y:10,z:0};assert.equal(cutWorld.move(gap,{x:40,y:0,z:0},.55),false,'cut canopy is removed from collision world');
const stump={x:-10,y:.6,z:0};assert.ok(cutWorld.move(stump,{x:20,y:0,z:0},.55),'cut stump still collides');cutWorld.dispose();
const trunkWorld=new FlightCollision(sim);trunkWorld.refresh({x:0,y:1,z:0},0,true);
const trunk={x:-10,y:1,z:0};assert.ok(trunkWorld.move(trunk,{x:20,y:0,z:0},.55),'swept body hits the thin trunk below the canopy');
assert.ok(trunk.x<0 && !trunkWorld.overlaps(trunk,.55));trunkWorld.dispose();
console.log('PASS cut-canopy clearance, stump collisions and swept thin-trunk collisions.');

// Contacts should permit natural glancing slides and retreat instead of trapping
// a flyer in Rapier's safety margin.
const slideWorld = new FlightCollision(sim); slideWorld.refresh({x:0,y:1,z:0},0,true);
const glancing = {x:-3,y:1,z:0};
assert.ok(slideWorld.move(glancing,{x:5,y:0,z:1},.55),'glancing impact is detected');
assert.ok(glancing.z > 1.2 && !slideWorld.overlaps(glancing,.55),'remaining motion slides safely along the trunk');
const contact = {x:-3,y:1,z:0}; slideWorld.move(contact,{x:5,y:0,z:0},.55);
const beforeRetreat = contact.x;
assert.equal(slideWorld.move(contact,{x:-.5,y:0,z:0},.55),false,'moving out of the contact margin is allowed');
assert.ok(contact.x < beforeRetreat-.49 && !slideWorld.overlaps(contact,.55));
const cameraOrigin = {x:-4,y:1,z:0}, desiredCamera = {x:4,y:1,z:0};
const cameraSafe = slideWorld.cameraPosition(cameraOrigin,desiredCamera,.3);
assert.ok(cameraSafe.x < 0 && !slideWorld.overlaps(cameraSafe,.3),'camera is placed before a trunk');
assert.deepEqual(cameraOrigin,{x:-4,y:1,z:0},'camera query does not move origin');
assert.deepEqual(desiredCamera,{x:4,y:1,z:0},'camera query does not move desired point');
const upperOrigin={x:-4,y:30,z:0}, upperDesired={x:4,y:30,z:0};
assert.deepEqual(slideWorld.cameraPosition(upperOrigin,upperDesired,.3),upperDesired,'camera can reach a clear view');
slideWorld.dispose();

const tucked = createFlight({x:0,y:100,z:0}), glide = createFlight({x:0,y:100,z:0});
step(tucked,{dive:true},1);step(glide,{},1);
assert.ok(tucked.speed > 17 && tucked.speed > glide.speed,'tucking trades altitude for speed');
const longGlide = createFlight({x:0,y:100,z:0}); step(longGlide,{},12);
assert.ok(longGlide.speed > FORMS.bird.stall, 'a level glide retains controllable airspeed for a while');
console.log('PASS glancing contact and retreat, obstruction-safe camera, tuck acceleration, and sustained glide.');

// Creature outline sweeps cover wing tips and the head, while tucked wings fit
// through a gap that the full wingspan cannot. Rotation is swept too.
const outlineSim = x => ({trees:()=>new Float32Array([x,0,0,20,3,1,0,0,0,42]),height:()=>0});
const wingWorld = new FlightCollision(outlineSim(-3.2)); wingWorld.refresh({x:0,y:1,z:10},0,true);
const spread = createFlight({x:0,y:1,z:10});
assert.ok(!wingWorld.overlapsCreature(spread));
assert.ok(wingWorld.moveCreature(spread,{x:0,y:0,z:-20},{previous:{yaw:0,pitch:0,bank:0},tucked:false}),'extended wing hits tree');
assert.ok(spread.position.z>0 && !wingWorld.overlapsCreature(spread),'extended wing cannot pass through trunk');
const narrow = createFlight({x:0,y:1,z:10});
assert.equal(wingWorld.moveCreature(narrow,{x:0,y:0,z:-20},{previous:{yaw:0,pitch:0,bank:0,tucked:true},tucked:true}),false,'tucked wings clear the same gap');
assert.equal(narrow.position.z,-10);
wingWorld.dispose();
const headWorld = new FlightCollision(outlineSim(0)); headWorld.refresh({x:0,y:1,z:10},0,true);
const head = createFlight({x:0,y:1,z:10});
assert.ok(headWorld.moveCreature(head,{x:0,y:0,z:-20},{previous:{yaw:0,pitch:0,bank:0}}));
assert.ok(head.position.z>1.8 && !headWorld.overlapsCreature(head),'head stops ahead of the body'); headWorld.dispose();
const rotateSim = {trees:()=>new Float32Array([0,0,-3.2,20,3,1,0,0,0,42]),height:()=>0};
const rotateWorld = new FlightCollision(rotateSim); rotateWorld.refresh({x:0,y:1,z:0},0,true);
const turn = createFlight({x:0,y:1,z:0}); turn.yaw=Math.PI/2;
assert.ok(rotateWorld.moveCreature(turn,{x:0,y:0,z:0},{previous:{yaw:0,pitch:0,bank:0}}),'rotating wing cannot sweep through trunk');
assert.ok(turn.yaw<Math.PI/2 && !rotateWorld.overlapsCreature(turn),'rotation stops safely at contact');rotateWorld.dispose();
console.log('PASS third-person head and wing sweeps, tucked gap clearance, and rotation collision.');

const mutableTree = new Float32Array([0,0,0,20,3,1,0,0,0,42]);
const mutableWorld = new FlightCollision({trees:()=>mutableTree,height:()=>0,revision:()=>1});
const pathStart={x:-10,y:12,z:1.6}; mutableWorld.refresh(pathStart,0,true);
let freshPath={...pathStart}; assert.ok(mutableWorld.move(freshPath,{x:20,y:0,z:0},.55),'fresh crown blocks the path');
const firstWorld=mutableWorld.world;mutableWorld.refresh(pathStart,1.1);
assert.equal(mutableWorld.world,firstWorld,'unchanged snapshots do not rebuild physics every second');
mutableTree[7]=1;mutableWorld.refresh(pathStart,1.1);
assert.notEqual(mutableWorld.world,firstWorld,'a changed crown updates collision geometry');
const burnedPath={...pathStart};assert.equal(mutableWorld.move(burnedPath,{x:20,y:0,z:0},.55),false,'burned-away branches stop blocking empty space');
mutableWorld.dispose();
console.log('PASS stable-world reuse and burned-crown collision updates.');
const unfoldWorld = new FlightCollision(outlineSim(-3.2));unfoldWorld.refresh({x:0,y:1,z:0},0,true);
const unfold=createFlight({x:0,y:1,z:0});
assert.ok(!unfoldWorld.overlapsCreature(unfold,true),'folded creature fits the gap');
assert.ok(unfoldWorld.moveCreature(unfold,{x:0,y:0,z:0},{previous:{yaw:0,pitch:0,bank:0,tucked:true},tucked:false}));
assert.equal(unfold.wingsBlocked,true,'caller is told to keep wings folded if opening hits a trunk');
assert.ok(!unfoldWorld.overlapsCreature(unfold,true));unfoldWorld.dispose();
console.log('PASS blocked wings remain folded in a narrow gap.');
const arcSim={trees:()=>new Float32Array([2.2,0,-2.8,20,.8,1,0,0,0,42]),height:()=>0};
const arcWorld=new FlightCollision(arcSim);arcWorld.refresh({x:0,y:1,z:0},0,true);
const arc=createFlight({x:0,y:1,z:0});arc.yaw=Math.PI/2;
assert.ok(arcWorld.moveCreature(arc,{x:0,y:0,z:0},{previous:{yaw:0,pitch:0,bank:0}}),'fast turn checks the wing arc between endpoints');
assert.ok(arc.yaw<Math.PI/2 && !arcWorld.overlapsCreature(arc),'fast turn stops before the wing enters the trunk');arcWorld.dispose();
console.log('PASS fast rotational arcs against obstacles.');
