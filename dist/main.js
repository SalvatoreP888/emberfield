import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { Simulation } from './simulation.js';
import { ForestView } from './forest.js';
import { FireEffects } from './fire.js';
import { CompatibilityRenderer } from './compatibility.js';

const $ = id => document.getElementById(id);
const clamp = (x,a,b) => Math.max(a,Math.min(b,x));
const mobile = matchMedia('(max-width: 780px)').matches;
const params = new URLSearchParams(location.search);
let seed = Math.max(1, (Number(params.get('seed')) || 2049) >>> 0);
const state = {tool:'observe',paused:false,speed:1,brush:10,windSpeed:14,windAngle:-Math.PI/4,moisture:.18,rain:0,night:false,sound:false,quality:'auto',overlay:'natural',scenario:'clearing'};
let sim,forest,fire,renderer,composer,controls,scene,camera,sun,hemi,fillLight,bloom,rainfall;
let visualTime=0,uiClock=0,focusClock=0,lastTime=performance.now(),frameCount=0,fpsClock=0,contextLost=false;
let lastSequence=-1,lastRevision=-1,resetPending=false,shadowClock=0,qualityLevel=1,pixelRatio=1;
const qualityNames=['low','medium','high'],qualityLabels=['Low','Balanced','High'];
const frameSamples=new Float32Array(120),workSamples=new Float32Array(120);
let sampleCursor=0,sampleCount=0,slowWindows=0,fastWindows=0,qualityClock=0;
const performanceStats={fps:0,frameMs:0,p95Ms:0,workMs:0,renderMs:0,longFrames:0};
let notificationTimer,holding=false,pointerMoved=false,lastPaint=0, audioContext,noiseGain,windGain,compatibility=false;
let brushRing,brushDisc,brushPoint=null;
const keys=new Set(),cursor=new THREE.Vector2(),raycaster=new THREE.Raycaster();
const up=new THREE.Vector3(0,1,0),forward=new THREE.Vector3(),right=new THREE.Vector3(),movement=new THREE.Vector3();
const compassNames=['east','southeast','south','southwest','west','northwest','north','northeast'];
const compassShort=['E','SE','S','SW','W','NW','N','NE'];

function notify(message){ $('notification').textContent=message;$('notification').classList.add('visible');clearTimeout(notificationTimer);notificationTimer=setTimeout(()=>$('notification').classList.remove('visible'),2400); }
function compassIndex(){return (Math.round(state.windAngle/(Math.PI/4))%8+8)%8;}
function setPanel(open){$('environment').classList.toggle('closed',!open);$('environment-toggle').setAttribute('aria-expanded',String(open));$('environment').inert=!open;}
function weatherChanged(){
  if(sim)sim.weather(state.windSpeed,state.windAngle,state.moisture,state.rain);
  const d=compassIndex();
  $('wind-value').innerHTML=`${state.windSpeed}<span> km/h</span>`;
  $('wind-output').textContent=`${state.windSpeed} km/h`;
  $('wind-speed').value=state.windSpeed;
  $('wind-speed').style.setProperty('--fill',`${state.windSpeed/60*100}%`);
  $('moisture').value=Math.round(state.moisture*100);
  $('moisture').style.setProperty('--fill',`${state.moisture/.8*100}%`);
  $('moisture-output').textContent=`${Math.round(state.moisture*100)}%`;
  $('wind-direction').innerHTML=`Blowing ${compassNames[d]} <span>↻</span>`;
  $('wind-arrow').style.transform=`rotate(${state.windAngle*180/Math.PI+90}deg)`;
  $('wind-brief').textContent=`${state.windSpeed} km/h ${compassShort[d]}`;
  $('moisture-brief').textContent=`${Math.round(state.moisture*100)}% moisture`;
  $('rain').checked=state.rain>0;
  if(rainfall)rainfall.visible=state.rain>0;
}

function setTool(tool){
  state.tool=tool;holding=false;
  document.querySelectorAll('[data-tool]').forEach(b=>{const active=b.dataset.tool===tool;b.classList.toggle('active',active);b.setAttribute('aria-pressed',String(active));});
  $('world').classList.toggle('painting',tool!=='observe');
  const hints={observe:mobile?'Drag to orbit · Pinch to zoom · Two fingers to travel':'Drag to look around <span>·</span> Scroll to zoom <span>·</span> WASD to explore',ignite:'Click or drag to ignite <span>·</span> Right-drag to orbit <span>·</span> [ / ] brush size',water:'Paint water to cool trees and soak fuel <span>·</span> Right-drag to orbit',clear:'Drag to remove fuel and create a firebreak <span>·</span> Right-drag to orbit'};
  $('tool-hint').innerHTML=hints[tool];
  $('brush-label').hidden=tool==='observe';
  if(controls){controls.mouseButtons.LEFT=tool==='observe'?THREE.MOUSE.ROTATE:-1;controls.mouseButtons.RIGHT=tool==='observe'?THREE.MOUSE.PAN:THREE.MOUSE.ROTATE;controls.touches.ONE=tool==='observe'?THREE.TOUCH.ROTATE:-1;}
  if(brushRing){const c=tool==='water'?0xa2dae1:tool==='clear'?0xc5d79c:0xffad76;brushRing.material.color.setHex(c);brushDisc.material.color.setHex(c);brushRing.visible=brushDisc.visible=tool!=='observe'&&!!brushPoint;}
}

function syncSimulationControl(){sim?.setControl(state.paused,state.speed,!document.hidden&&!contextLost);}
function setPaused(value){state.paused=value;syncSimulationControl();$('pause').setAttribute('aria-label',value?'Resume simulation':'Pause simulation');$('pause').innerHTML=`<svg><use href="#i-${value?'play':'pause'}"/></svg>`;$('run-state').textContent=value?'SIMULATION PAUSED':'SIMULATION LIVE';document.body.classList.toggle('paused',value);}
function applyPreset(value){
  const p={dry:[14,.18,0],balanced:[8,.4,0],windy:[42,.08,0],rain:[20,.65,1]}[value];
  [state.windSpeed,state.moisture,state.rain]=p;weatherChanged();notify({dry:'Dry fuel. Watch the wind carry the fire.',balanced:'Cooler, damper forest conditions.',windy:'Strong winds. Embers can start spot fires.',rain:'Rain is soaking fuel and cooling the forest.'}[value]);
}
async function resetWorld(newSeed){
  if(resetPending||!sim)return;
  resetPending=true;holding=false;brushPoint=null;updateBrush();setPaused(true);$('reset').disabled=$('regenerate').disabled=$('scenario').disabled=$('seed').disabled=true;
  notify('Regenerating the forest…');
  try{
    seed=newSeed;
    await sim.reset(seed,{weather:state,scenario:state.scenario});
    controls.target.set(0,sim.height(0,0)+2,0);camera.position.set(60,78,95);controls.update();camera.updateMatrixWorld();
    sun.position.set(-65,controls.target.y+85,-45);sun.target.position.copy(controls.target);renderer.shadowMap.needsUpdate=true;
    forest.sync(true);fire.lastRefresh=-Infinity;$('seed').value=seed;lastSequence=-1;lastRevision=-1;visualTime=0;
    if(history.replaceState)history.replaceState(null,'',`${location.pathname}?seed=${seed}`);
    setPaused(false);updateUI();notify(`Forest restored · seed ${seed}`);
  }catch(error){notify(error.message);console.error('Forest reset failed:',error);}
  finally{resetPending=false;$('reset').disabled=$('regenerate').disabled=$('scenario').disabled=$('seed').disabled=false;}
}

function resizeGraphics(){
  if(!renderer)return;
  const ratios=compatibility?[.75,1,1.25]:[.85,1.15,1.5];
  pixelRatio=Math.min(devicePixelRatio,ratios[qualityLevel]);
  camera.aspect=innerWidth/innerHeight;camera.updateProjectionMatrix();
  renderer.setPixelRatio(pixelRatio);renderer.setSize(innerWidth,innerHeight);
  composer.setPixelRatio?.(pixelRatio);composer.setSize(innerWidth,innerHeight);
  fire.setViewport?.(innerWidth,innerHeight,pixelRatio);
}
function applyQuality(level){
  qualityLevel=clamp(level,0,2);
  const name=qualityNames[qualityLevel];
  forest?.setQuality?.(name);fire?.setQuality?.(name);renderer?.setQuality?.(name);
  if(renderer){renderer.shadowMap.enabled=!compatibility&&qualityLevel>0;renderer.shadowMap.needsUpdate=true;}
  if(bloom)bloom.enabled=qualityLevel>0;
  if(sun){const size=qualityLevel===2?2048:1024;if(sun.shadow.mapSize.x!==size){sun.shadow.mapSize.set(size,size);sun.shadow.map?.dispose();sun.shadow.map=null;}}
  if(composer)resizeGraphics();
  $('quality-current').textContent=(state.quality==='auto'?'Auto · ':'')+qualityLabels[qualityLevel];
  document.body.dataset.quality=name;
}
function setOverlay(value){
  state.overlay=value;forest?.setOverlay?.(value);forest?.sync();renderer?.setOverlay?.(value);
  const legend=$('overlay-legend');legend.hidden=value==='natural';
  legend.className='overlay-legend '+value;
  $('overlay-low').textContent=value==='heat'?'Cool':'Consumed';
  $('overlay-high').textContent=value==='heat'?'Burning':'Full fuel';
}
function trackPerformance(realDt,workMs,renderMs){
  if(realDt>0&&realDt<5){frameSamples[sampleCursor]=realDt*1000;workSamples[sampleCursor]=workMs;sampleCursor=(sampleCursor+1)%120;sampleCount=Math.min(120,sampleCount+1);}
  if(realDt>.05)performanceStats.longFrames++;
  performanceStats.renderMs=renderMs;frameCount++;fpsClock+=realDt;qualityClock+=realDt;
  if(fpsClock>=1){
    performanceStats.fps=frameCount/fpsClock;$('fps').textContent=`${Math.round(performanceStats.fps)} FPS`;
    frameCount=0;fpsClock=0;
    if(sampleCount){const samples=Array.from(frameSamples.subarray(0,sampleCount)).sort((a,b)=>a-b);performanceStats.frameMs=samples.reduce((a,b)=>a+b,0)/sampleCount;performanceStats.p95Ms=samples[Math.min(sampleCount-1,Math.floor(sampleCount*.95))];performanceStats.workMs=Array.from(workSamples.subarray(0,sampleCount)).reduce((a,b)=>a+b,0)/sampleCount;}
  }
  if(state.quality==='auto'&&qualityClock>3&&sampleCount>=45){
    qualityClock=0;
    const overloaded=(performanceStats.frameMs>27&&performanceStats.frameMs<250)||performanceStats.workMs>20;
    slowWindows=overloaded?slowWindows+1:0;
    fastWindows=performanceStats.frameMs<18.5&&performanceStats.workMs<9?fastWindows+1:0;
    if(slowWindows>=2&&qualityLevel>0){applyQuality(qualityLevel-1);slowWindows=fastWindows=0;}
    else if(fastWindows>=5&&qualityLevel<2){applyQuality(qualityLevel+1);slowWindows=fastWindows=0;}
  }
}

function setupUI(){
  $('seed').value=seed;if(mobile)setPanel(false);
  $('environment-toggle').onclick=()=>setPanel($('environment-toggle').getAttribute('aria-expanded')!=='true');
  $('close-environment').onclick=()=>setPanel(false);
  document.querySelectorAll('[data-tool]').forEach(b=>b.onclick=()=>setTool(b.dataset.tool));
  $('pause').onclick=()=>setPaused(!state.paused);
  $('speed').onclick=()=>{const speeds=[1,3,6];state.speed=speeds[(speeds.indexOf(state.speed)+1)%speeds.length];$('speed').textContent=`${state.speed}×`;syncSimulationControl();notify(`Simulation speed ${state.speed}×`);};
  $('reset').onclick=()=>resetWorld(seed);
  $('quality').onchange=e=>{state.quality=e.target.value;slowWindows=fastWindows=0;applyQuality(state.quality==='auto'?(mobile?0:1):qualityNames.indexOf(state.quality));};
  $('overlay').onchange=e=>setOverlay(e.target.value);
  $('scenario').onchange=e=>{state.scenario=e.target.value;resetWorld(seed);};
  $('wind-speed').oninput=e=>{state.windSpeed=Number(e.target.value);weatherChanged();};
  $('moisture').oninput=e=>{state.moisture=Number(e.target.value)/100;weatherChanged();};
  $('wind-direction').onclick=()=>{state.windAngle+=Math.PI/4;weatherChanged();};
  $('rain').onchange=e=>{state.rain=e.target.checked?1:0;weatherChanged();notify(state.rain?'Rain is cooling the canopy.':'Rain has stopped.');};
  $('night').onchange=e=>{state.night=e.target.checked;setLighting();};
  $('preset').onchange=e=>applyPreset(e.target.value);
  $('regenerate').onclick=()=>{const value=clamp(Number($('seed').value)||2049,1,2147483647);resetWorld(value>>>0);};
  $('seed').onkeydown=e=>{if(e.key==='Enter')$('regenerate').click();};
  $('help').onclick=()=>$('help-dialog').showModal();
  $('close-help').onclick=$('start-exploring').onclick=()=>$('help-dialog').close();
  $('help-dialog').addEventListener('click',e=>{if(e.target===$('help-dialog')){const r=e.target.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)e.target.close();}});
  $('fullscreen').onclick=async()=>{try{if(!document.fullscreenElement)await document.documentElement.requestFullscreen();else await document.exitFullscreen();}catch{notify('Full screen is not available in this view.');}};
  $('sound').onclick=toggleSound;
  window.addEventListener('keydown',e=>{
    if(/INPUT|SELECT|TEXTAREA/.test(e.target.tagName)||$('help-dialog').open)return;
    const key=e.key.toLowerCase();keys.add(key);
    if([' ','arrowup','arrowdown','arrowleft','arrowright'].includes(key))e.preventDefault();
    if(e.repeat)return;
    if(key===' ')setPaused(!state.paused);
    if(['1','2','3','4'].includes(key))setTool(['observe','ignite','water','clear'][Number(key)-1]);
    if(key==='['||key===']'){state.brush=clamp(state.brush+(key===']'?2:-2),4,26);$('brush-value').textContent=`${state.brush} m`;updateBrush();}
    if(key==='escape'){setTool('observe');setPanel(false);}
    if(key==='h')$('help-dialog').showModal();
  });
  window.addEventListener('keyup',e=>keys.delete(e.key.toLowerCase()));
  window.addEventListener('blur',()=>{keys.clear();holding=false;});
  document.addEventListener('visibilitychange',()=>{lastTime=performance.now();keys.clear();holding=false;syncSimulationControl();});
}

function setLighting(){
  const night=state.night;
  scene.background.set(night?0x101d24:0x4b5c53);
  scene.fog.color.copy(scene.background);scene.fog.density=night?.0068:.0062;
  sun.color.setHex(night?0xa9c6eb:0xffd49b);sun.intensity=night?.45:3.1;
  hemi.color.setHex(night?0x577a9b:0xb7cbd1);hemi.groundColor.setHex(night?0x202b20:0x3b4530);hemi.intensity=night?.75:1.55;
  fillLight.intensity=night?.12:.55;
  renderer.toneMappingExposure=night?1.1:1.12;
  bloom.strength=night?.7:.44;
}

function makeRain(){
  const count=2600,positions=new Float32Array(count*3);
  for(let i=0;i<count;i++){positions[i*3]=Math.random()*180-90;positions[i*3+1]=Math.random()*70;positions[i*3+2]=Math.random()*180-90;}
  const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.BufferAttribute(positions,3));
  const m=new THREE.ShaderMaterial({transparent:true,depthWrite:false,uniforms:{uTime:{value:0},uFocus:{value:new THREE.Vector3()},uWind:{value:new THREE.Vector2()}},vertexShader:`uniform float uTime;uniform vec3 uFocus;uniform vec2 uWind;varying float vAlpha;void main(){vec3 p=position;p.y=mod(p.y-uTime*27.,70.);p.xz+=uFocus.xz+uWind*(70.-p.y)*.04;p.y+=uFocus.y;vec4 mv=modelViewMatrix*vec4(p,1.);gl_Position=projectionMatrix*mv;gl_PointSize=clamp(120./-mv.z,1.,2.5);vAlpha=.3;}`,fragmentShader:`varying float vAlpha;void main(){gl_FragColor=vec4(.7,.82,.84,vAlpha);}`});
  const rain=new THREE.Points(g,m);rain.frustumCulled=false;rain.visible=false;scene.add(rain);return rain;
}

function setupScene(){
  scene=new THREE.Scene();scene.background=new THREE.Color(0x4b5c53);scene.fog=new THREE.FogExp2(0x4b5c53,.0062);
  camera=new THREE.PerspectiveCamera(43,innerWidth/innerHeight,.4,900);camera.position.set(60,78,95);
  const canvas=document.createElement('canvas');
  const context=canvas.getContext('webgl2',{antialias:true,powerPreference:'high-performance',alpha:false});
  if(context){renderer=new THREE.WebGLRenderer({canvas,context,antialias:true,powerPreference:'high-performance'});}
  else {renderer=new CompatibilityRenderer(sim);compatibility=true;$('render-mode').textContent='COMPATIBILITY VIEW';$('render-mode').title='WebGL is unavailable in this browser. Rust simulation remains fully active.';}
  renderer.setPixelRatio(Math.min(devicePixelRatio,compatibility?1:mobile?1.25:1.5));renderer.setSize(innerWidth,innerHeight);
  renderer.shadowMap.enabled=true;renderer.shadowMap.type=THREE.PCFSoftShadowMap;renderer.shadowMap.autoUpdate=false;
  renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=1.12;renderer.outputColorSpace=THREE.SRGBColorSpace;
  renderer.domElement.setAttribute('aria-label','Forest viewport — drag to orbit, scroll to zoom, WASD to travel');
  renderer.domElement.setAttribute('tabindex','0');$('world').appendChild(renderer.domElement);
  hemi=new THREE.HemisphereLight(0xb7cbd1,0x3b4530,1.55);scene.add(hemi);
  sun=new THREE.DirectionalLight(0xffd49b,3.1);sun.position.set(-65,85,-45);sun.castShadow=true;sun.shadow.mapSize.set(mobile?1024:2048,mobile?1024:2048);
  Object.assign(sun.shadow.camera,{left:-110,right:110,top:110,bottom:-110,near:.5,far:360});sun.shadow.bias=-.0003;sun.shadow.normalBias=.65;sun.shadow.radius=3;scene.add(sun,sun.target);
  fillLight=new THREE.DirectionalLight(0xd2d5b0,.55);fillLight.position.set(60,28,70);scene.add(fillLight);
  controls=new OrbitControls(camera,renderer.domElement);controls.target.set(0,sim.height(0,0)+2,0);controls.enableDamping=true;controls.dampingFactor=.075;controls.minDistance=17;controls.maxDistance=225;controls.minPolarAngle=.18;controls.maxPolarAngle=Math.PI/2-.18;controls.screenSpacePanning=false;controls.panSpeed=.8;controls.rotateSpeed=.6;controls.zoomSpeed=.75;
  controls.update();
  forest=compatibility?{sync(){},update(){},terrainMeshes:[]}:new ForestView(scene,sim);
  fire=compatibility?{lastRefresh:-Infinity,update(){},counts:{}}:new FireEffects(scene,camera);rainfall=makeRain();
  brushRing=new THREE.Mesh(new THREE.RingGeometry(.97,1,64),new THREE.MeshBasicMaterial({color:0xffad76,transparent:true,opacity:.92,side:THREE.DoubleSide,depthWrite:false}));brushRing.rotation.x=-Math.PI/2;brushRing.renderOrder=6;brushRing.visible=false;scene.add(brushRing);
  brushDisc=new THREE.Mesh(new THREE.CircleGeometry(1,48),new THREE.MeshBasicMaterial({color:0xffad76,transparent:true,opacity:.075,side:THREE.DoubleSide,depthWrite:false}));brushDisc.rotation.x=-Math.PI/2;brushDisc.renderOrder=5;brushDisc.visible=false;scene.add(brushDisc);
  if(!compatibility){composer=new EffectComposer(renderer);composer.addPass(new RenderPass(scene,camera));bloom=new UnrealBloomPass(new THREE.Vector2(innerWidth,innerHeight),.44,.72,.88);composer.addPass(bloom);composer.addPass(new OutputPass());}
  else {composer={render:()=>renderer.render(scene,camera),setSize:()=>{}};bloom={strength:0};}
  renderer.shadowMap.needsUpdate=true;
  renderer.domElement.addEventListener('webglcontextlost',e=>{e.preventDefault();contextLost=true;syncSimulationControl();document.body.classList.add('context-lost');});
  renderer.domElement.addEventListener('webglcontextrestored',()=>{contextLost=false;syncSimulationControl();renderer.shadowMap.needsUpdate=true;document.body.classList.remove('context-lost');notify('Graphics restored.');});
  renderer.domElement.addEventListener('contextmenu',e=>e.preventDefault());
  renderer.domElement.addEventListener('pointermove',e=>{pointerMoved=true;setPointer(e);if(state.tool!=='observe'){pickTerrain();updateBrush();if(holding)paint();}});
  renderer.domElement.addEventListener('pointerdown',e=>{if(e.button!==0||state.tool==='observe')return;holding=true;setPointer(e);pickTerrain();updateBrush();paint(true);renderer.domElement.setPointerCapture(e.pointerId);});
  renderer.domElement.addEventListener('pointerup',()=>holding=false);
  renderer.domElement.addEventListener('pointercancel',()=>holding=false);
  renderer.domElement.addEventListener('pointerleave',()=>{if(!holding){brushPoint=null;brushRing.visible=brushDisc.visible=false;}});
  window.addEventListener('resize',resizeGraphics);
  setTool('observe');
}

function setPointer(e){const r=renderer.domElement.getBoundingClientRect();cursor.set((e.clientX-r.left)/r.width*2-1,-(e.clientY-r.top)/r.height*2+1);}
function pickTerrain(){
  raycaster.setFromCamera(cursor,camera);const ray=raycaster.ray;
  brushPoint=null;if(ray.direction.y>=0)return;
  let previous=0;
  for(let distance=4;distance<900;distance+=4){
    const x=ray.origin.x+ray.direction.x*distance,y=ray.origin.y+ray.direction.y*distance,z=ray.origin.z+ray.direction.z*distance;
    if(y<=sim.height(x,z)){
      let low=previous,high=distance;
      for(let j=0;j<9;j++){const mid=(low+high)*.5,mx=ray.origin.x+ray.direction.x*mid,mz=ray.origin.z+ray.direction.z*mid;if(ray.origin.y+ray.direction.y*mid>sim.height(mx,mz))low=mid;else high=mid;}
      brushPoint=ray.at((low+high)*.5,new THREE.Vector3());return;
    }
    previous=distance;
  }
}
function updateBrush(){
  if(!brushRing)return;const visible=!!brushPoint&&state.tool!=='observe';brushRing.visible=brushDisc.visible=visible;
  if(visible){brushRing.position.copy(brushPoint);brushRing.position.y+=.19;brushDisc.position.copy(brushPoint);brushDisc.position.y+=.13;brushRing.scale.setScalar(state.brush);brushDisc.scale.setScalar(state.brush);}
}
function paint(force=false){
  const now=performance.now();if(resetPending||!brushPoint||(!force&&now-lastPaint<90))return;lastPaint=now;
  sim[state.tool](brushPoint.x,brushPoint.z,state.brush);
  if(state.tool==='clear')renderer.shadowMap.needsUpdate=true;
}

function moveCamera(dt){
  let x=0,z=0;
  if(keys.has('w')||keys.has('arrowup'))z+=1;
  if(keys.has('s')||keys.has('arrowdown'))z-=1;
  if(keys.has('d')||keys.has('arrowright'))x+=1;
  if(keys.has('a')||keys.has('arrowleft'))x-=1;
  if(x||z){camera.getWorldDirection(forward);forward.y=0;forward.normalize();right.crossVectors(forward,up).normalize();movement.copy(forward).multiplyScalar(z).addScaledVector(right,x).normalize().multiplyScalar(dt*(keys.has('shift')?90:32));camera.position.add(movement);controls.target.add(movement);}
  const ground=sim.height(controls.target.x,controls.target.z);const dy=(ground+2-controls.target.y)*Math.min(1,dt*3);controls.target.y+=dy;camera.position.y+=dy;
  const cameraGround=sim.height(camera.position.x,camera.position.z);if(camera.position.y<cameraGround+4)camera.position.y=cameraGround+4;
  controls.update();
  camera.updateMatrixWorld();
}

function drawMap(data){
  const ctx=$('minimap').getContext('2d'),w=240,scale=.84,tx=controls.target.x,tz=controls.target.z;
  ctx.clearRect(0,0,w,w);ctx.fillStyle='#182b21';ctx.fillRect(0,0,w,w);
  ctx.strokeStyle='#a4b89814';ctx.lineWidth=1;ctx.beginPath();ctx.arc(120,120,76,0,Math.PI*2);ctx.stroke();ctx.beginPath();ctx.moveTo(120,14);ctx.lineTo(120,226);ctx.moveTo(14,120);ctx.lineTo(226,120);ctx.stroke();
  for(let i=0;i<data.length;i+=10){const x=120+(data[i]-tx)*scale,z=120+(data[i+2]-tz)*scale;if(x<0||x>240||z<0||z>240)continue;const heat=data[i+6],burn=data[i+7];ctx.fillStyle=heat>=.65?'#ef9c5f':burn>.65?'#615342':'#667c4d';ctx.globalAlpha=heat>=.65?.95:.48;const size=heat>=.65?4.8:2.2;ctx.fillRect(x-size/2,z-size/2,size,size);}
  ctx.globalAlpha=1;ctx.fillStyle='#dae7c2';ctx.beginPath();ctx.arc(120,120,3,0,Math.PI*2);ctx.fill();
  const vx=camera.position.x-tx,vz=camera.position.z-tz,angle=Math.atan2(vx,vz);ctx.save();ctx.translate(120,120);ctx.rotate(-angle);ctx.fillStyle='#a8c29625';ctx.beginPath();ctx.moveTo(0,0);ctx.lineTo(-22,45);ctx.lineTo(22,45);ctx.closePath();ctx.fill();ctx.restore();
}
function updateUI(){
  if(!sim)return;const s=sim.stats(),data=sim.trees(),phases=sim.fireStates();
  let surface=0,crown=0,smolder=0;for(let i=0;i<phases.length;i+=4){if(phases[i]>.01)surface++;if(phases[i+1]>.01)crown++;if(phases[i+2]>.01)smolder++;}
  $('surface-count').textContent=surface.toLocaleString();$('crown-count').textContent=crown.toLocaleString();$('smolder-count').textContent=smolder.toLocaleString();
  $('burning').textContent=Math.round(s[1]).toLocaleString();$('burned-area').innerHTML=`${s[4].toFixed(2)}<span> ha</span>`;
  const secs=Math.floor(s[0]);$('elapsed').textContent=`${Math.floor(secs/60).toString().padStart(2,'0')}:${(secs%60).toString().padStart(2,'0')}`;
  const x=Math.round(controls.target.x),z=Math.round(-controls.target.z);$('coordinates').textContent=`${Math.abs(x)} ${x>=0?'E':'W'} · ${Math.abs(z)} ${z>=0?'N':'S'}`;
  document.body.dataset.engine='rust-wasm';document.body.dataset.renderer=compatibility?'canvas-compatibility':'three-webgl2';document.body.dataset.trees=String(Math.round(s[3]));document.body.dataset.chunks=String(Math.round(s[7]));document.body.dataset.revision=String(sim.revision());
  document.body.dataset.smoke=String(sim.smoke().length/8);document.body.dataset.embers=String(sim.embers().length/8);
  if(compatibility&&renderer.visibleParticles){document.body.dataset.smokeVisible=String(renderer.visibleParticles.smoke);document.body.dataset.smokeCandidates=String(renderer.visibleParticles.smokeCandidates);}
  document.body.dataset.thread=sim.thread;document.body.dataset.sequence=String(sim.sequence);document.body.dataset.simulationMs=sim.metrics.stepMs.toFixed(3);document.body.dataset.simulationRate=sim.metrics.actualSpeed.toFixed(2);document.body.dataset.frameP95=performanceStats.p95Ms.toFixed(1);
  $('thread-status').textContent=sim.thread==='worker'?'Physics in worker':'Compatibility scheduling';
  $('perf-frame').textContent=performanceStats.p95Ms.toFixed(1)+' ms';$('perf-physics').textContent=sim.metrics.stepMs.toFixed(2)+' ms / tick';
  $('perf-rate').textContent=state.paused?'Paused':sim.metrics.actualSpeed.toFixed(1)+'× actual';$('perf-particles').textContent=(sim.smoke().length/8).toLocaleString()+' smoke · '+(sim.embers().length/8).toLocaleString()+' embers';
  $('perf-trees').textContent=Math.round(s[3]).toLocaleString()+' trees · '+Math.round(s[7])+' chunks';
  drawMap(data);if(noiseGain)noiseGain.gain.setTargetAtTime(state.sound?clamp(s[1]/55,0,1)*.065:0,audioContext.currentTime,.5);
}

async function toggleSound(){
  try{
    if(!audioContext){
      audioContext=new (window.AudioContext||window.webkitAudioContext)();const buffer=audioContext.createBuffer(1,audioContext.sampleRate*3,audioContext.sampleRate),data=buffer.getChannelData(0);let brown=0;
      for(let i=0;i<data.length;i++){brown=(brown+Math.random()*.04-.02)/1.02;data[i]=brown*4+(Math.random()>.998?(Math.random()-.5)*1.2:0);}
      const source=audioContext.createBufferSource();source.buffer=buffer;source.loop=true;
      const low=audioContext.createBiquadFilter();low.type='lowpass';low.frequency.value=1300;noiseGain=audioContext.createGain();noiseGain.gain.value=0;source.connect(low);low.connect(noiseGain);noiseGain.connect(audioContext.destination);
      const wind=audioContext.createBiquadFilter();wind.type='lowpass';wind.frequency.value=250;windGain=audioContext.createGain();windGain.gain.value=0;source.connect(wind);wind.connect(windGain);windGain.connect(audioContext.destination);source.start();
    }
    await audioContext.resume();state.sound=!state.sound;windGain.gain.setTargetAtTime(state.sound?.035:0,audioContext.currentTime,.5);if(!state.sound)noiseGain.gain.setTargetAtTime(0,audioContext.currentTime,.2);$('sound').innerHTML=`<svg><use href="#i-${state.sound?'sound':'mute'}"/></svg>`;$('sound').setAttribute('aria-label',state.sound?'Mute forest and fire audio':'Enable forest and fire audio');notify(state.sound?'Forest sound on':'Sound muted');
  }catch{notify('Audio is unavailable in this browser.');}
}

function frame(now){
  requestAnimationFrame(frame);const started=performance.now(),realDt=Math.max(0,(now-lastTime)/1000),dt=Math.min(.1,realDt);lastTime=now;
  if(contextLost||document.hidden)return;
  if(!resetPending)moveCamera(dt);visualTime+=state.paused?0:dt;
  sim.advanceLocal(realDt);
  uiClock+=realDt;focusClock+=realDt;shadowClock+=realDt;
  if(focusClock>.25&&!resetPending){focusClock=0;const focus=sim.requestedFocus;if(Math.hypot(focus.x-controls.target.x,focus.z-controls.target.z)>24){sim.setFocus(controls.target.x,controls.target.z);sun.position.set(controls.target.x-65,controls.target.y+85,controls.target.z-45);sun.target.position.copy(controls.target);renderer.shadowMap.needsUpdate=true;}}
  if(sim.sequence!==lastSequence){
    lastSequence=sim.sequence;forest.sync();
    if(lastRevision!==sim.revision()){lastRevision=sim.revision();fire.lastRefresh=-Infinity;renderer.shadowMap.needsUpdate=true;}
    if(shadowClock>(qualityLevel===2?.5:1)){shadowClock=0;renderer.shadowMap.needsUpdate=true;}
  }
  forest.update(visualTime,state.windSpeed,state.windAngle,camera);
  fire.update(visualTime,dt,sim.trees(),state,sim.smoke(),sim.embers(),sim.fireStates(),sim.sequence);
  if(rainfall.visible){rainfall.material.uniforms.uTime.value=visualTime;rainfall.material.uniforms.uFocus.value.copy(controls.target);rainfall.material.uniforms.uWind.value.set(Math.cos(state.windAngle)*state.windSpeed/15,Math.sin(state.windAngle)*state.windSpeed/15);}
  if(holding&&state.tool!=='observe'&&!resetPending)paint();
  if(uiClock>.3){uiClock=0;updateUI();}
  if(compatibility){renderer.visualTime=visualTime;renderer.weather=state;renderer.snapshotSequence=sim.sequence;renderer.brush={point:brushPoint,radius:state.brush,tool:state.tool};renderer.smokeParticles=sim.smoke();renderer.emberParticles=sim.embers();renderer.fireStates=sim.fireStates();}
  const renderStart=performance.now();composer.render();const renderMs=performance.now()-renderStart;
  document.body.dataset.renderMs=renderMs.toFixed(1);document.body.dataset.frameDelta=realDt.toFixed(3);
  trackPerformance(realDt,performance.now()-started,renderMs);
}

async function start(){
  try{
    setupUI();$('loading-message').textContent='Starting the Rust simulation worker…';sim=await Simulation.load(seed,{weather:state,scenario:state.scenario});
    sim.onError=error=>{setPaused(true);notify('Simulation paused: '+error.message);};
    $('loading-message').textContent='Growing your forest…';await new Promise(resolve=>requestAnimationFrame(resolve));setupScene();
    forest.sync();weatherChanged();setLighting();applyQuality(mobile?0:1);setOverlay(state.overlay);setPaused(false);updateUI();
    // Read-only diagnostics support reproducible performance and integration checks.
    window.emberfield={diagnostics:()=>({engine:'Rust WebAssembly',thread:sim.thread,metrics:{...sim.metrics},performance:{...performanceStats},quality:qualityNames[qualityLevel],sequence:sim.sequence,renderer:compatibility?'Canvas compatibility':'Three.js WebGL 2',seed,stats:Array.from(sim.stats()),smokeCount:sim.smoke().length/8,emberCount:sim.embers().length/8,revision:sim.revision(),focus:{...sim.focus},camera:camera.position.toArray(),target:controls.target.toArray(),state:{...state},effects:{...fire.counts},render:{calls:renderer.info.render.calls,triangles:renderer.info.render.triangles,geometries:renderer.info.memory.geometries,textures:renderer.info.memory.textures}})};
    lastTime=performance.now();requestAnimationFrame(frame);setTimeout(()=>{$('loading').classList.add('hidden');setTimeout(()=>$('loading').remove(),700);},500);
  }catch(error){console.error('Emberfield startup failed:',error);$('loading-message').textContent=error.message||'The forest could not start. Please reload this page.';const button=document.createElement('button');button.className='error-button';button.textContent='Reload forest';button.onclick=()=>location.reload();$('loading').appendChild(button);}
}
start();
