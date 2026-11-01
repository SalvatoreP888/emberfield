import fs from 'node:fs';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import * as THREE from '../dist/vendor/three.module.js';

const vendor=new URL('../dist/vendor/three.module.js',import.meta.url).href;
const source=fs.readFileSync(new URL('../dist/fire.js',import.meta.url),'utf8');
async function load(text){return (await import('data:text/javascript;base64,'+Buffer.from(text.replace("from 'three'",`from '${vendor}'`)).toString('base64'))).FireEffects;}
const FireEffects=await load(source);
const weather={windSpeed:14,windAngle:-Math.PI/4,rain:0,night:false,paused:false};
function create(Effects=FireEffects){
  const scene=new THREE.Scene();scene.fog=new THREE.FogExp2(0x4b5c53,.0062);
  const camera=new THREE.PerspectiveCamera(43,16/9,.4,900);camera.position.set(0,20,100);camera.lookAt(0,2,0);camera.updateMatrixWorld();
  const effects=new Effects(scene,camera);effects.setViewport?.(1280,720,1.5);
  return {scene,camera,effects};
}
function input(){return {
  trees:new Float32Array([1,0,1,12,3,0,1,.1,.2,.3]),
  phases:new Float32Array([.8,0,.1,.7]),
  smoke:new Float32Array([2,5,3,4,.7,.6,.2,.31,4,7,-30,9,.4,.2,.6,.77]),
  embers:new Float32Array([3,8,5,.8,.07,.3,.57,0]),
};}
function advance(e,d,seq,dt=.1,time=0,w=weather){e.update(time,dt,d.trees,w,d.smoke,d.embers,d.phases,seq);}
function copyData(d){return Object.fromEntries(Object.entries(d).map(([k,v])=>[k,v.slice()]));}
function assertOrigins(e,expected){
  const a=e.smokeGeometry.attributes.iOrigin.array;
  for(let i=0;i<e.counts.smoke;i++)assert.ok(expected.some(p=>p.every((v,j)=>Math.abs(v-a[i*3+j])<1e-5)),`non-Rust origin ${Array.from(a.slice(i*3,i*3+3))}`);
}

// Combustion stage separation, direct physical fields and exact depth order.
{
  const {scene,effects:e}=create(),d=input();advance(e,d,1);
  assert.ok(e.counts.surfaceFlames>0);assert.equal(e.counts.crownFlames,0);
  assert.ok(e.flameGeometry.attributes.iShape.array[1]<3.2);
  assert.equal(e.counts.smoke,2);assert.equal(e.counts.embers,1);
  assert.deepEqual(Array.from(e.smokeGeometry.attributes.iOrigin.array.slice(0,6)),[4,7,-30,2,5,3]);
  assert.deepEqual(Array.from(e.emberGeometry.attributes.position.array.slice(0,3)),[3,8,5]);
  assert.equal(e.smokeGeometry.attributes.iShape.array[0],9);
  d.phases[1]=.9;advance(e,d,2);assert.ok(e.counts.crownFlames>0);
  d.phases.fill(0);advance(e,d,3);assert.equal(e.counts.flames,0);assert.equal(e.counts.smoke,2);
  let disposed=0;e.noiseField.addEventListener('dispose',()=>disposed++);e.dispose();assert.equal(disposed,1);assert.equal(scene.children.length,0);
}

// No stale worker views: earlier source buffers are detached before adoption.
{
  const {effects:e}=create(),first=input();advance(e,first,1);
  const next=copyData(first);next.smoke[0]=5;next.smoke[6]+=.01;next.embers[1]=10;next.embers[5]+=.01;
  for(const a of Object.values(first))structuredClone(a.buffer,{transfer:[a.buffer]});
  advance(e,next,2,.05,.05);
  assertOrigins(e,[[5,5,3],[4,7,-30]]);
  assert.equal(e.smokeGeometry.attributes.iFrom.array[4],2);
  assert.equal(e.emberGeometry.attributes.aFrom.array[1],8);
  assert.equal(e.work.interpolatedSmoke,2);assert.equal(e.work.interpolatedEmbers,1);
  assert.equal(e.smokeMaterial.uniforms.uInterpolation.value,0);
  e.update(.075,.025,next.trees,weather,next.smoke,next.embers,next.phases,2);
  assert.ok(e.smokeMaterial.uniforms.uInterpolation.value>0&&e.smokeMaterial.uniforms.uInterpolation.value<=1);
  // Paused edits still update the latest physical state and stop interpolation.
  const edited=copyData(next);edited.smoke[0]=6;advance(e,edited,3,.05,.075,{...weather,paused:true});
  assert.equal(e.smokeMaterial.uniforms.uInterpolation.value,1);
  assertOrigins(e,[[6,5,3],[4,7,-30]]);
  e.lastRefresh=-Infinity;advance(e,edited,4,.05,0);assert.equal(e.work.interpolatedSmoke,0);
  e.dispose();
}

// Colliding seeds and younger/reborn particles cannot borrow another trajectory.
{
  const {effects:e}=create(),d=input();d.smoke[15]=d.smoke[7];advance(e,d,1);
  const next=copyData(d);next.smoke[0]+=1;next.smoke[8]+=1;next.smoke[6]+=.01;next.smoke[14]+=.01;
  advance(e,next,2);assert.equal(e.work.interpolatedSmoke,0);
  for(let i=0;i<e.counts.smoke;i++)for(let j=0;j<3;j++)assert.equal(e.smokeGeometry.attributes.iFrom.array[i*4+j],e.smokeGeometry.attributes.iOrigin.array[i*3+j]);
  e.dispose();
}

// A static or paused adopted snapshot does no scans, sorting or buffer uploads.
{
  const {effects:e,camera}=create(),d=input();advance(e,d,1);
  const before={...e.work},version=e.smokeGeometry.attributes.iOrigin.version;
  for(let i=0;i<600;i++)advance(e,d,1,1/60,1+i/60);
  assert.equal(e.work.flameRefreshes,before.flameRefreshes);assert.equal(e.work.particleRefreshes,before.particleRefreshes);
  assert.equal(e.work.uploadBytes,before.uploadBytes);assert.equal(e.smokeGeometry.attributes.iOrigin.version,version);
  camera.position.set(2000,20,100);camera.lookAt(2000,2,0);camera.updateMatrixWorld();advance(e,d,1,.1,11);
  assert.equal(e.counts.smoke,0);assert.equal(e.counts.flames,0);
  e.setViewport(1000,600,2);advance(e,d,1,.1,11.1);assert.equal(e.emberMaterial.uniforms.uPixelScale.value,600);
  e.dispose();
}

function dense(){
  const trees=new Float32Array(3600*10),phases=new Float32Array(3600*4),smoke=new Float32Array(2800*8),embers=new Float32Array(1000*8);
  for(let i=0;i<3600;i++){trees.set([(i%60-30)*4,0,(Math.floor(i/60)-30)*4,10,3,0,i<400?1:0,.15,.18,i/3600],i*10);if(i<400)phases.set([.7,.35,.1,.8],i*4);}
  for(let i=0;i<2800;i++)smoke.set([(i%40-20)*2,4+i%17,((i/40)|0)*.8-30,3+i%9,.12+(i%6)*.03,.4,.4,i/2800],i*8);
  for(let i=0;i<1000;i++)embers.set([(i%25-12)*2,5+i%14,((i/25)|0)-20,.8,.08,.3,i/1000,0],i*8);
  return {trees,phases,smoke,embers};
}
// Visibility and shader-work budgets are bounded at every quality level.
{
  const {effects:e,camera}=create(),d=dense();let seq=1;
  const limits={low:[140,800,300,1.8,1],medium:[240,1500,650,3.4,2],high:[400,2600,1200,5.8,3]};
  for(const [level,limit]of Object.entries(limits)){
    e.setQuality(level);advance(e,d,seq++);
    assert.ok(e.counts.burning<=limit[0]);assert.ok(e.counts.smoke<=limit[1]);assert.ok(e.counts.embers<=limit[2]);assert.ok(e.work.smokeCoverage<=limit[3]+1e-5);
    assert.equal(e.lights.filter(l=>l.visible).length,limit[4]);
    assert.ok(e.smokeGeometry.attributes.iOrigin.updateRanges[0].count<=limit[1]*3);
    let last=Infinity;const m=camera.matrixWorldInverse.elements,a=e.smokeGeometry.attributes.iOrigin.array;
    for(let i=0;i<e.counts.smoke;i++){const depth=-(m[2]*a[i*3]+m[6]*a[i*3+1]+m[10]*a[i*3+2]+m[14]);assert.ok(depth<=last+1e-4);last=depth;}
  }
  for(const g of[e.flameGeometry,e.smokeGeometry,e.emberGeometry])for(const a of Object.values(g.attributes))assert.ok(a.array.every(Number.isFinite));
  assert.equal(e.noiseField.image.data.length,32768);assert.equal(e.noiseField.format,THREE.RedFormat);assert.equal(e.noiseField.colorSpace,THREE.NoColorSpace);
  assert.equal(e.flameMaterial.uniforms.uNoiseField.value,e.smokeMaterial.uniforms.uNoiseField.value);
  for(const mat of[e.flameMaterial,e.smokeMaterial,e.emberMaterial]){
    const expanded=[mat.vertexShader,mat.fragmentShader].map(shader=>shader.replace(/#include <([^>]+)>/g,(_,name)=>{assert.ok(name in THREE.ShaderChunk);return THREE.ShaderChunk[name];}));
    for(const shader of expanded)assert.ok(!shader.includes('#include'));
    const outputs=new Map([...expanded[0].matchAll(/varying\s+(\w+)\s+(\w+)\s*;/g)].map(m=>[m[2],m[1]]));
    for(const match of expanded[1].matchAll(/varying\s+(\w+)\s+(\w+)\s*;/g))assert.equal(outputs.get(match[2]),match[1],`varying type mismatch: ${match[2]}`);
  }
  const vendorSource=fs.readFileSync(new URL('../dist/vendor/three.module.js',import.meta.url),'utf8');
  assert.ok(vendorSource.includes("versionString = '#version 300 es\\n'"));
  assert.ok(vendorSource.includes("'#define attribute in'"));assert.ok(vendorSource.includes("'#define varying out'"));
  assert.ok(vendorSource.includes("'#define gl_FragColor pc_fragColor'"));assert.ok(vendorSource.includes('precision ${parameters.precision} sampler3D;'));
  assert.ok(vendorSource.includes('internalFormat = _gl.R8;'));assert.ok(e.smokeMaterial.fragmentShader.includes('uniform highp sampler3D uNoiseField'));
  assert.equal(e.smokeGeometry.attributes.iWeight.array.every(Number.isFinite),true);
  assert.ok(!e.smokeMaterial.vertexShader.includes('fract(uTime'));assert.ok(e.smokeMaterial.vertexShader.includes('mix(iFrom.xyz,iOrigin'));
  assert.throws(()=>e.setQuality('ultra'),RangeError);e.dispose();
}
console.log('PASS: stage separation, direct Rust particle fields, detached snapshot buffers, safe interpolation, duplicate-seed rejection, paused updates, no redundant work, camera culling, quality/area budgets, prefix uploads, shader interfaces, disposal.');

if(process.argv.includes('--benchmark')){
  const data=dense();
  let Baseline,baselineSource;
  if(process.argv.includes('--baseline-stdin')){baselineSource=fs.readFileSync(0,'utf8');Baseline=await load(baselineSource);}
  function measure(Effects,label,dynamic){
    const {effects:e}=create(Effects);let flameRefreshes=0,particleRefreshes=0;
    const ff=e.refreshFlames.bind(e),fp=e.refreshParticles.bind(e);
    e.refreshFlames=(...a)=>{flameRefreshes++;return ff(...a)};e.refreshParticles=(...a)=>{particleRefreshes++;return fp(...a)};
    for(let i=0;i<120;i++)advance(e,data,dynamic?Math.floor(i/3):1,1/60,i/60);
    flameRefreshes=particleRefreshes=0;const uploadStart=e.work?.uploadBytes||0;
    const frames=1800,t=performance.now();
    for(let i=0;i<frames;i++)advance(e,data,dynamic?40+Math.floor(i/3):1,1/60,2+i/60);
    const elapsed=performance.now()-t;
    const result={implementation:label,scenario:dynamic?'20 Hz adopted snapshots':'unchanged adopted snapshot',frames,cpuMs:Number(elapsed.toFixed(2)),msPerDisplayUpdate:Number((elapsed/frames).toFixed(4)),flameRefreshes,particleRefreshes,rendered:{...e.counts},smokeScreenCoverage:e.work?.smokeCoverage,maxDensityCompensation:e.work?.densityCompensationMax};
    if(e.work)result.uploadMiB=Number(((e.work.uploadBytes-uploadStart)/1048576).toFixed(2));
    else {let smokeBytes=0,fireBytes=0;for(const a of Object.values(e.smokeGeometry.attributes))if(a.isInstancedBufferAttribute)smokeBytes+=a.array.byteLength;for(const a of Object.values(e.emberGeometry.attributes))smokeBytes+=a.array.byteLength;for(const a of Object.values(e.flameGeometry.attributes))if(a.isInstancedBufferAttribute)fireBytes+=a.array.byteLength;result.uploadMiB=Number(((smokeBytes*particleRefreshes+fireBytes*flameRefreshes)/1048576).toFixed(2));}
    e.dispose();return result;
  }
  const rows=[];for(const dynamic of[false,true]){if(Baseline)rows.push(measure(Baseline,'committed baseline',dynamic));rows.push(measure(FireEffects,'updated medium',dynamic));}
  const report={
    generatedAt:new Date().toISOString(),
    note:'CPU adapter microbenchmark only; no WebGL context or measured GPU FPS. Upload counts are requested buffer bytes after warmup. Quality budgets and shader instruction analysis do not prove a GPU frame-rate improvement.',
    sourceSha256:createHash('sha256').update(source).digest('hex'),
    baselineSha256:baselineSource?createHash('sha256').update(baselineSource).digest('hex'):null,
    fixture:{trees:3600,burningTrees:400,smokeParcels:2800,embers:1000,displayUpdates:1800,displayHz:60,snapshotHz:20,viewport:[1280,720],pixelRatio:1.5,updatedQuality:'medium'},
    shaderAudit:{threeRevision:THREE.REVISION,glslVersion:'300 es via ShaderMaterial prefix',sampler:'highp sampler3D / filtered R8 / NoColorSpace',noiseVolumeBytes:32768,vertexAttributes:{flame:5,smoke:7,embers:3},varyingComponentsIncludingFog:{flame:9,smoke:10,embers:4},noiseTextureFetchesPerFragment:{low:{flame:3,smoke:2},medium:{flame:5,smoke:4},high:{flame:6,smoke:5}},legacyHashCallsPerFragment:{flame:48,smoke:40},compileVerified:false,reason:'WebGL is unavailable in the current browser; glslangValidator/glslc are not installed. Varying, attribute, precision, uniform, texture format and prefix contracts were checked against the vendored Three.js source.'},
    results:rows,
  };
  if(Baseline){report.improvements=Object.fromEntries([0,2].map(i=>[i===0?'unchangedSnapshot':'twentyHzSnapshots',{cpuReductionPercent:Number((100*(1-rows[i+1].cpuMs/rows[i].cpuMs)).toFixed(2)),requestedUploadReductionPercent:rows[i].uploadMiB?Number((100*(1-rows[i+1].uploadMiB/rows[i].uploadMiB)).toFixed(2)):null}]))}
  const serialized=JSON.stringify(report,null,2);console.log(serialized);
  if(process.argv.includes('--report')){fs.mkdirSync(new URL('../docs/',import.meta.url),{recursive:true});fs.writeFileSync(new URL('../docs/effects-performance.json',import.meta.url),serialized+'\n');}

}
