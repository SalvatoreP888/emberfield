import * as THREE from 'three';

/**
 * Render adapter. Rust owns combustion and every smoke / firebrand trajectory.
 * The shaders add sub-particle density and flame detail; they do not integrate
 * velocity, respawn particles, choose ignition, or decide when crowns ignite.
 * All materials output linear HDR for EffectComposer's final OutputPass.
 */
const MAX_FIRES = 400;
const MAX_FLAMES = MAX_FIRES * 8;
const MAX_SMOKE = 4000;
const MAX_EMBERS = 1800;
const EMPTY = new Float32Array(0);
const TAU = Math.PI * 2;
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const fract = x => x - Math.floor(x);
const ADDITIVE_FOG = /* glsl */`
#ifdef USE_FOG
  #ifdef FOG_EXP2
    float fogFactor = 1.0 - exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
  #else
    float fogFactor = smoothstep(fogNear, fogFar, vFogDepth);
  #endif
  gl_FragColor.rgb *= 1.0 - fogFactor;
#endif
`;
const QUALITY = Object.freeze({
  low: { fires:140, smoke:800, embers:300, area:1.8, densityCap:6, flameArea:.8, minPixels:2.1, layers:2, lights:1, particleInterval:.065, flameInterval:.12, detail:1 },
  medium: { fires:240, smoke:1500, embers:650, area:3.4, densityCap:4, flameArea:1.5, minPixels:1.5, layers:3, lights:2, particleInterval:.035, flameInterval:.085, detail:2 },
  high: { fires:400, smoke:2600, embers:1200, area:5.8, densityCap:2.5, flameArea:2.4, minPixels:1.0, layers:4, lights:3, particleInterval:.025, flameInterval:.065, detail:3 },
});
const NOISE = /* glsl */`
uniform highp sampler3D uNoiseField;
float fieldNoise(vec3 p) {
  return texture(uNoiseField,(p+.5)/32.0).r;
}
float fbm3(vec3 p) {
  float f=fieldNoise(p)*.58;
  #if FX_DETAIL >= 2
    p=p.yzx*2.03+vec3(7.1,2.8,4.3);
    f+=fieldNoise(p)*.28;
    #if FX_DETAIL >= 3
      p=p.zxy*2.11+vec3(1.7,8.2,3.1);
      return f+fieldNoise(p)*.14;
    #else
      return f/.86;
    #endif
  #else
    return f/.58;
  #endif
}
`;
function noiseTexture() {
  // One 32 KiB immutable noise volume replaces dozens of hash evaluations per
  // shaded pixel. WebGL 2 provides filtered R8 3D textures without extensions.
  const data=new Uint8Array(32*32*32);let state=0x6d2b79f5;
  for(let i=0;i<data.length;i++){state^=state<<13;state^=state>>>17;state^=state<<5;data[i]=(state>>>24)&255;}
  const texture=new THREE.Data3DTexture(data,32,32,32);
  texture.format=THREE.RedFormat;texture.type=THREE.UnsignedByteType;
  texture.minFilter=texture.magFilter=THREE.LinearFilter;
  texture.wrapS=texture.wrapT=texture.wrapR=THREE.RepeatWrapping;
  texture.generateMipmaps=false;texture.unpackAlignment=1;
  texture.colorSpace=THREE.NoColorSpace;texture.needsUpdate=true;
  return texture;
}

function billboardGeometry(capacity, verticalSegments = 1) {
  const plane = new THREE.PlaneGeometry(1, 1, 1, verticalSegments);
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.index = plane.index.clone();
  geometry.setAttribute('position', plane.attributes.position.clone());
  geometry.setAttribute('uv', plane.attributes.uv.clone());
  geometry.setAttribute('iOrigin', new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3).setUsage(THREE.DynamicDrawUsage));
  geometry.setAttribute('iShape', new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4).setUsage(THREE.DynamicDrawUsage));
  geometry.setAttribute('iState', new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4).setUsage(THREE.DynamicDrawUsage));
  geometry.instanceCount = 0;
  plane.dispose();
  return geometry;
}
function uniforms(noiseField) {
  const result=THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
    uTime: {value:0}, uWind: {value:new THREE.Vector2()},
    uRight: {value:new THREE.Vector3(1,0,0)},
    uLight: {value:new THREE.Vector3(-.52,.76,.39)},
    uAmbient: {value:1}, uPixelScale: {value:540}, uInterpolation: {value:1},
  }]);
  result.uNoiseField={value:noiseField};
  return result;
}

const flameVertex = /* glsl */`
attribute vec3 iOrigin;
attribute vec4 iShape;
attribute vec4 iState;
uniform float uTime;
uniform vec2 uWind;
uniform vec3 uRight;
varying vec2 vUv;
varying vec3 vWorld;
varying float vSeed;
varying float vIntensity;
varying float vCrown;
#include <fog_pars_vertex>
void main() {
  vUv = uv; vSeed = iShape.z; vIntensity = iShape.w; vCrown = iState.x;
  // Crossed, segmented ribbons have depth when viewed from above or the side.
  vec3 side = uRight * cos(iState.z) + vec3(-uRight.z,0.0,uRight.x) * sin(iState.z);
  float y = uv.y;
  float curl = sin(y*6.2 - uTime*(2.8+iShape.z) + iShape.z*23.0) * .10 * y;
  curl += sin(y*11.0 - uTime*4.1 + iShape.z*71.0) * .035 * y*y;
  float breathe = 1.0 + .07*sin(uTime*4.3+iShape.z*42.0) + .035*sin(uTime*7.9+iShape.z*13.0);
  vec3 p = iOrigin + side * (position.x + curl) * iShape.x;
  p.y += y * iShape.y * breathe;
  p.xz += uWind * y*y * iShape.y * (0.030 + vCrown*.018);
  vWorld = p;
  vec4 mvPosition = modelViewMatrix * vec4(p,1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;
const flameFragment = /* glsl */`
uniform float uTime;
varying vec2 vUv;
varying vec3 vWorld;
varying float vSeed;
varying float vIntensity;
varying float vCrown;
#include <fog_pars_fragment>
${NOISE}
void main() {
  vec2 q = vec2(vUv.x*2.0-1.0, vUv.y);
  // A shared 3D field rolls up through crossed ribbons; there is no triangle mask.
  vec3 flow = vWorld * vec3(1.55,1.20,1.55);
  flow.y -= uTime * (2.4 + vIntensity*2.0);
  flow += vec3(vSeed*4.0,0.0,vSeed*3.0);
  float large = fieldNoise(flow*.62);
  flow.xz += vec2(large-.5, fieldNoise(flow*.67+13.4)-.5) * .7;
  float n = fbm3(flow);
  #if FX_DETAIL >= 2
    float fine=fieldNoise(flow*3.1+vec3(0.0,-uTime*1.3,0.0));
  #else
    float fine=n;
  #endif
  float center = q.x + (large-.5)*(.24+q.y*.55);
  float spread = .30 + .62*(1.0-q.y);
  float radial = exp(-center*center / max(.04,spread*spread));
  float density = radial*(1.0-q.y*.69) + (n-.47)*.95 + (fine-.5)*.12 - .40;
  float mask = smoothstep(-.025,.16,density);
  mask *= smoothstep(0.0,.045,q.y) * (1.0-smoothstep(.86,1.0,q.y));
  // Intermittent holes and detached tips keep upper tongues wispy.
  mask *= mix(1.0,smoothstep(.18,.46,n),q.y*.7);
  float alpha = mask * sqrt(max(0.0,vIntensity)) * .61;
  if(alpha < .012) discard;
  float hot = clamp(density*1.7 + (1.0-q.y)*.22 + fine*.13,0.0,1.0);
  vec3 col = mix(vec3(1.04,.047,.004),vec3(1.85,.29,.018),smoothstep(.03,.45,hot));
  col = mix(col,vec3(2.30,.93,.17),smoothstep(.57,.96,hot));
  col *= .91 + .09*sin(uTime*9.2+vSeed*51.0);
  gl_FragColor = vec4(col,alpha);
  ${ADDITIVE_FOG}
}`;

const smokeVertex = /* glsl */`
attribute vec3 iOrigin;
attribute vec4 iShape;
attribute vec4 iState;
attribute vec4 iFrom;
attribute float iWeight;
uniform float uInterpolation;
varying vec2 vUv;
varying vec2 vRotation;
varying float vWeight;
varying float vSeed;
varying float vOpacity;
varying float vTemperature;
varying float vAge;
#include <fog_pars_vertex>
void main() {
  float blend=uInterpolation;
  vUv=uv;vSeed=iShape.w;vWeight=iWeight;
  vOpacity=mix(iState.y,iShape.y,blend);
  vTemperature=mix(iState.z,iShape.z,blend);
  vAge=mix(iState.w,iState.x,blend);
  // Both endpoints and diameters are received from Rust. New or ambiguous
  // identities use identical endpoints, never an invented velocity.
  vec3 center=mix(iFrom.xyz,iOrigin,blend);
  float diameter=mix(iFrom.w,iShape.x,blend);
  vec4 mvPosition=modelViewMatrix*vec4(center,1.0);
  float angle=iShape.w*23.0+vAge*.8;
  vRotation=vec2(cos(angle),sin(angle));
  vec2 corner=mat2(vRotation.x,-vRotation.y,vRotation.y,vRotation.x)*position.xy;
  mvPosition.xy+=corner*diameter;
  gl_Position=projectionMatrix*mvPosition;
  #include <fog_vertex>
}`;
const smokeFragment = /* glsl */`
uniform float uTime;
uniform vec3 uLight;
uniform float uAmbient;
varying vec2 vUv;
varying vec2 vRotation;
varying float vWeight;
varying float vSeed;
varying float vOpacity;
varying float vTemperature;
varying float vAge;
#include <fog_pars_fragment>
${NOISE}
void main() {
  vec2 q=vUv*2.0-1.0;
  float r2=dot(q,q);
  if(r2>1.02) discard;
  float sphere=sqrt(max(0.0,1.0-r2));
  // Internal density rolls without moving the particle away from its Rust state.
  vec3 p=vec3(q*2.4, sphere*1.1+vSeed*19.0);
  p.xy += vec2(sin(vSeed*43.0+vAge*2.1),cos(vSeed*31.0-vAge*2.8))*.28;
  p.z += uTime*.085;
  float coarse=fieldNoise(p*.85);
  float n=fbm3(p + vec3(coarse*.7,coarse*.5,0.0));
  #if FX_DETAIL >= 2
    float fine=fieldNoise(p*3.8+vec3(0.0,uTime*.08,0.0));
  #else
    float fine=n;
  #endif
  float rim=1.0-smoothstep(.47,1.0,sqrt(r2)+(coarse-.5)*.16);
  float density=smoothstep(.20,.80,n)*(.82+fine*.28)*rim;
  // Rust opacity already integrates optical mass over the projected parcel.
  // Recover that optical depth, then distribute it across the billowy profile.
  // The profile's mean is ~.406, so 2.45 preserves its mean optical depth instead
  // of multiplying by a second soft mask and losing most of the smoke density.
  float opticalDepth=density*(.35+sphere*1.75);
  float parcelDepth=-log(max(.001,1.0-vOpacity));
  // Bounded render-only density compensation represents culled parcels in the
  // same screen region. It never changes Rust opacity or particle motion.
  float alpha=1.0-exp(-parcelDepth*opticalDepth*2.45*vWeight);
  if(alpha<.002) discard;
  vec2 litXY=mat2(vRotation.x,-vRotation.y,vRotation.y,vRotation.x)*q;
  vec3 normal=normalize(vec3(litXY*.75,sphere+.12));
  float diffuse=max(0.0,dot(normal,normalize(uLight)));
  float selfShade=exp(-density*.75);
  float lighting=(.48+diffuse*.52)*(.68+selfShade*.32);
  float fresh=clamp(vTemperature*.86 + (1.0-vAge)*.08,0.0,1.0);
  vec3 soot=mix(vec3(.175,.188,.181),vec3(.047,.043,.035),fresh);
  soot*=lighting*uAmbient;
  soot+=vec3(.065,.019,.002)*vTemperature*max(0.0,1.0-vAge*2.0);
  gl_FragColor=vec4(soot,alpha);
  #include <fog_fragment>
}`;
const emberVertex = /* glsl */`
attribute vec4 aShape;
attribute vec3 aFrom;
uniform float uInterpolation;
uniform float uTime;
uniform float uPixelScale;
varying float vHeat;
varying float vAlpha;
varying float vSeed;
#include <fog_pars_vertex>
void main() {
  // No wrap, upward offset or wind displacement: this is the actual firebrand.
  vec4 mvPosition=modelViewMatrix*vec4(mix(aFrom,position,uInterpolation),1.0);
  gl_Position=projectionMatrix*mvPosition;
  gl_PointSize=clamp(aShape.y*projectionMatrix[1][1]*uPixelScale/max(.1,-mvPosition.z),.9,8.0);
  vHeat=aShape.x; vSeed=aShape.w;
  vAlpha=clamp(aShape.x*1.2,0.0,1.0)*(.83+.17*sin(uTime*13.0+aShape.w*71.0));
  #include <fog_vertex>
}`;
const emberFragment = /* glsl */`
varying float vHeat;
varying float vAlpha;
varying float vSeed;
#include <fog_pars_fragment>
void main() {
  float radius=length(gl_PointCoord-.5)*2.0;
  float glow=exp(-radius*radius*4.2)*(1.0-smoothstep(.72,1.0,radius));
  float alpha=glow*vAlpha;
  if(alpha<.008) discard;
  vec3 col=mix(vec3(.8,.025,.002),vec3(2.1,.58,.065),smoothstep(.1,.9,vHeat));
  gl_FragColor=vec4(col,alpha);
  ${ADDITIVE_FOG}
}`;

// Fixed storage, not Map entries or retained worker views. Duplicate seeds are
// marked ambiguous; interpolation then snaps to the new real particle safely.
class ParticleHistory {
  constructor(seedOffset) {this.seedOffset=seedOffset;this.capacity=0;this.epoch=1;this.ensure(4000);}
  ensure(count) {
    if(count*2<=this.capacity)return;
    let capacity=64;while(capacity<count*2)capacity*=2;
    this.capacity=capacity;this.mask=capacity-1;this.epoch=1;
    this.keys=new Uint32Array(capacity);this.stamps=new Uint32Array(capacity);
    this.status=new Uint8Array(capacity);this.data=new Float32Array(capacity*8);
  }
  clear() {this.epoch=(this.epoch+1)>>>0;if(!this.epoch){this.stamps.fill(0);this.epoch=1;}}
  build(source) {
    this.ensure(source.length/8);this.clear();
    for(let i=0;i+7<source.length;i+=8) {
      const key=(source[i+this.seedOffset]*4294967296)>>>0;
      let slot=Math.imul(key^(key>>>16),0x45d9f3b)&this.mask;
      while(this.stamps[slot]===this.epoch&&this.keys[slot]!==key)slot=(slot+1)&this.mask;
      if(this.stamps[slot]===this.epoch){this.status[slot]=2;continue;}
      this.keys[slot]=key;this.stamps[slot]=this.epoch;this.status[slot]=1;
      const base=slot*8;for(let j=0;j<8;j++)this.data[base+j]=source[i+j];
    }
  }
  find(seed) {
    const key=(seed*4294967296)>>>0;let slot=Math.imul(key^(key>>>16),0x45d9f3b)&this.mask;
    while(this.stamps[slot]===this.epoch) {
      if(this.keys[slot]===key)return this.status[slot]===1?slot*8:-1;
      slot=(slot+1)&this.mask;
    }
    return -1;
  }
}
function radixDepth(order,scratch,bits,count,histogram) {
  // Positive IEEE float depths sort lexicographically as unsigned integers.
  // Four stable byte passes give exact back-to-front order without sort objects.
  let src=order,dst=scratch;
  for(let shift=0;shift<32;shift+=8) {
    histogram.fill(0);
    for(let i=0;i<count;i++)histogram[(bits[src[i]]>>>shift)&255]++;
    let total=0;for(let i=0;i<256;i++){const n=histogram[i];histogram[i]=total;total+=n;}
    for(let i=0;i<count;i++){const id=src[i];dst[histogram[(bits[id]>>>shift)&255]++]=id;}
    const swap=src;src=dst;dst=swap;
  }
}
function attribute(geometry,name,count,size) {
  geometry.setAttribute(name,new THREE.InstancedBufferAttribute(new Float32Array(count*size),size).setUsage(THREE.DynamicDrawUsage));
}

export class FireEffects {
  constructor(scene,camera) {
    this.scene=scene;this.camera=camera;this.lastRefresh=-Infinity;
    this.flameClock=0;this.particleClock=0;this.particleElapsed=1;this.interpolationDuration=.05;
    this.lastFlameSequence=undefined;this.lastParticleSequence=undefined;
    this.flameCamera=new Float64Array(32).fill(Infinity);this.particleCamera=new Float64Array(32).fill(Infinity);
    this.viewportWidth=0;this.viewportHeight=0;this.pixelRatio=0;
    this.viewportDirty=true;this.qualityDirty=true;this.quality='medium';this.settings=QUALITY.medium;
    this.treeCapacity=0;this.smokeCapacity=0;
    this.treeHeads=new Int32Array(128);this.smokeHeads=new Int32Array(128);
    this.tileMass=new Float32Array(48);this.tileSelectedMass=new Float32Array(48);
    this.smokeOrder=new Uint32Array(MAX_SMOKE);this.sortScratch=new Uint32Array(MAX_SMOKE);this.histogram=new Uint32Array(256);
    this.smokeCurrent=new ParticleHistory(7);this.smokePrevious=new ParticleHistory(7);
    this.emberCurrent=new ParticleHistory(6);this.emberPrevious=new ParticleHistory(6);
    this.hasParticleHistory=false;
    this.counts={burning:0,flames:0,surfaceFlames:0,crownFlames:0,smoke:0,embers:0};
    this.work={flameRefreshes:0,particleRefreshes:0,treeScans:0,particleScans:0,uploadBytes:0,uploads:0,skippedFrames:0,interpolatedSmoke:0,interpolatedEmbers:0,smokeCoverage:0,densityCompensationMax:1};
    this.right=new THREE.Vector3();this.sunDirection=new THREE.Vector3(-65,85,-45).normalize();this.viewLight=new THREE.Vector3();
    this.lightTargets=Array.from({length:3},()=>new THREE.Vector3());this.lightStrengths=new Float32Array(3);
    this.noiseField=noiseTexture();
    this.flameGeometry=billboardGeometry(MAX_FLAMES,4);
    this.flameMaterial=new THREE.ShaderMaterial({uniforms:uniforms(this.noiseField),defines:{FX_DETAIL:2},vertexShader:flameVertex,fragmentShader:flameFragment,transparent:true,depthWrite:false,depthTest:true,blending:THREE.AdditiveBlending,side:THREE.DoubleSide,forceSinglePass:true,fog:true,toneMapped:false});
    this.flames=new THREE.Mesh(this.flameGeometry,this.flameMaterial);this.flames.frustumCulled=false;this.flames.renderOrder=2;
    this.flames.name='Surface fire and delayed crown flames';scene.add(this.flames);
    this.smokeGeometry=billboardGeometry(MAX_SMOKE);attribute(this.smokeGeometry,'iFrom',MAX_SMOKE,4);attribute(this.smokeGeometry,'iWeight',MAX_SMOKE,1);
    this.smokeMaterial=new THREE.ShaderMaterial({uniforms:uniforms(this.noiseField),defines:{FX_DETAIL:2},vertexShader:smokeVertex,fragmentShader:smokeFragment,transparent:true,depthWrite:false,depthTest:true,blending:THREE.NormalBlending,side:THREE.DoubleSide,forceSinglePass:true,fog:true});
    this.smoke=new THREE.Mesh(this.smokeGeometry,this.smokeMaterial);this.smoke.frustumCulled=false;this.smoke.renderOrder=3;
    this.smoke.name='Rust buoyancy and wind smoke parcels';scene.add(this.smoke);
    this.emberGeometry=new THREE.BufferGeometry();
    for(const [name,size] of [['position',3],['aShape',4],['aFrom',3]])this.emberGeometry.setAttribute(name,new THREE.BufferAttribute(new Float32Array(MAX_EMBERS*size),size).setUsage(THREE.DynamicDrawUsage));
    this.emberGeometry.setDrawRange(0,0);
    this.emberMaterial=new THREE.ShaderMaterial({uniforms:uniforms(this.noiseField),vertexShader:emberVertex,fragmentShader:emberFragment,transparent:true,depthWrite:false,depthTest:true,blending:THREE.AdditiveBlending,fog:true,toneMapped:false});
    this.embers=new THREE.Points(this.emberGeometry,this.emberMaterial);this.embers.frustumCulled=false;this.embers.renderOrder=4;
    this.embers.name='Rust firebrand trajectories';scene.add(this.embers);
    this.materials=[this.flameMaterial,this.smokeMaterial,this.emberMaterial];
    this.lights=Array.from({length:3},(_,i)=>{const light=new THREE.PointLight(0xff7727,0,34,1.65);light.castShadow=false;light.visible=i<this.settings.lights;scene.add(light);return light;});
    this.setViewport(globalThis.innerWidth||1280,globalThis.innerHeight||720,1);
  }

  setQuality(level) {
    if(!Object.hasOwn(QUALITY,level))throw new RangeError(`Unknown effects quality: ${level}`);
    if(level===this.quality)return;
    this.quality=level;this.settings=QUALITY[level];this.qualityDirty=true;
    this.flameMaterial.defines.FX_DETAIL=this.settings.detail;this.smokeMaterial.defines.FX_DETAIL=this.settings.detail;
    this.flameMaterial.needsUpdate=this.smokeMaterial.needsUpdate=true;
    for(let i=0;i<3;i++){this.lights[i].visible=i<this.settings.lights;if(i>=this.settings.lights)this.lights[i].intensity=this.lightStrengths[i]=0;}
  }
  setViewport(width,height,pixelRatio=1) {
    width=Math.max(1,width);height=Math.max(1,height);pixelRatio=Math.max(.5,pixelRatio);
    if(width===this.viewportWidth&&height===this.viewportHeight&&pixelRatio===this.pixelRatio)return;
    this.viewportWidth=width;this.viewportHeight=height;this.pixelRatio=pixelRatio;this.viewportDirty=true;
    const scale=height*pixelRatio*.5;for(let i=0;i<3;i++)this.materials[i].uniforms.uPixelScale.value=scale;
  }
  _cameraChanged(saved) {
    const m=this.camera.matrixWorldInverse.elements,p=this.camera.projectionMatrix.elements;
    for(let i=0;i<16;i++)if(Math.abs(saved[i]-m[i])>1e-4||Math.abs(saved[i+16]-p[i])>1e-5)return true;
    return false;
  }
  _captureCamera(saved) {saved.set(this.camera.matrixWorldInverse.elements);saved.set(this.camera.projectionMatrix.elements,16);}
  _resetHistory() {
    this.smokeCurrent.clear();this.smokePrevious.clear();this.emberCurrent.clear();this.emberPrevious.clear();
    this.hasParticleHistory=false;this.particleElapsed=1;
  }
  _upload(attr,count) {
    if(!count)return;
    attr.clearUpdateRanges();attr.addUpdateRange(0,count*attr.itemSize);attr.needsUpdate=true;
    this.work.uploads++;this.work.uploadBytes+=count*attr.itemSize*4;
  }

  update(time,dt,trees,weather,smoke=EMPTY,embers=EMPTY,fireStates=EMPTY,snapshotSequence) {
    const wind=clamp(Number(weather.windSpeed)||0,0,100)/3.6,angle=Number(weather.windAngle)||0;
    this.right.setFromMatrixColumn(this.camera.matrixWorld,0);this.right.y=0;
    if(this.right.lengthSq()<.001)this.right.set(1,0,0);else this.right.normalize();
    this.viewLight.copy(this.sunDirection).transformDirection(this.camera.matrixWorldInverse);
    const wx=Math.cos(angle)*wind,wz=Math.sin(angle)*wind;
    for(let i=0;i<3;i++) {
      const u=this.materials[i].uniforms;u.uTime.value=time;u.uWind.value.set(wx,wz);
      u.uRight.value.copy(this.right);u.uLight.value.copy(this.viewLight);u.uAmbient.value=weather.night?.40:1;
    }
    const step=Math.max(0,Math.min(.25,dt));this.flameClock+=step;this.particleClock+=step;this.particleElapsed+=step;
    const sequenced=Number.isFinite(snapshotSequence);
    const reset=!Number.isFinite(this.lastRefresh)||time<this.lastRefresh||(sequenced&&snapshotSequence<this.lastParticleSequence);
    if(reset)this._resetHistory();
    const forced=reset||this.qualityDirty||this.viewportDirty;
    const flameNew=!sequenced||snapshotSequence!==this.lastFlameSequence;
    const particleNew=!sequenced||snapshotSequence!==this.lastParticleSequence;
    let worked=false;
    if(forced||(this.flameClock>=this.settings.flameInterval&&(flameNew||this._cameraChanged(this.flameCamera)))) {
      this.refreshFlames(trees,fireStates);this._captureCamera(this.flameCamera);this.flameClock=0;
      this.lastFlameSequence=snapshotSequence;this.lastRefresh=time;worked=true;
    }
    if(forced||(this.particleClock>=this.settings.particleInterval&&(particleNew||this._cameraChanged(this.particleCamera)))) {
      const newData=reset||particleNew;
      if(newData) {
        this.interpolationDuration=clamp(this.particleElapsed,.025,.10);this.particleElapsed=0;
      }
      this.refreshParticles(smoke,embers,newData);this._captureCamera(this.particleCamera);this.particleClock=0;
      this.lastParticleSequence=snapshotSequence;worked=true;
    }
    this.qualityDirty=this.viewportDirty=false;
    const blend=weather.paused||!this.hasParticleHistory?1:clamp(this.particleElapsed/this.interpolationDuration,0,1);
    this.smokeMaterial.uniforms.uInterpolation.value=blend;this.emberMaterial.uniforms.uInterpolation.value=blend;
    if(!worked)this.work.skippedFrames++;
    const smoothing=1-Math.exp(-step*5);
    for(let i=0;i<3;i++) {
      const light=this.lights[i];light.position.lerp(this.lightTargets[i],smoothing);
      const flicker=.94+Math.sin(time*6.3+i*3)*.04+Math.sin(time*11.7+i)*.02;
      const target=i<this.settings.lights?this.lightStrengths[i]*flicker:0;
      light.intensity+=(target-light.intensity)*smoothing;
    }
  }

  _ensureTrees(count) {
    if(count<=this.treeCapacity)return;
    let capacity=256;while(capacity<count)capacity*=2;
    this.treeCapacity=capacity;this.treeNext=new Int32Array(capacity);this.treeDepth=new Float32Array(capacity);
  }
  _ensureSmoke(count) {
    if(count<=this.smokeCapacity)return;
    let capacity=256;while(capacity<count)capacity*=2;
    this.smokeCapacity=capacity;this.smokeNext=new Int32Array(capacity);this.smokeDepth=new Float32Array(capacity);
    this.smokeDepthBits=new Uint32Array(this.smokeDepth.buffer);this.smokeArea=new Float32Array(capacity);
    this.smokeTile=new Uint8Array(capacity);this.smokeMass=new Float32Array(capacity);
  }
  refreshFlames(trees,fireStates) {
    const total=Math.floor(trees.length/10);this._ensureTrees(total);this.treeHeads.fill(-1);
    const detailed=fireStates.length>=total*4,q=this.settings,m=this.camera.matrixWorldInverse.elements,p=this.camera.projectionMatrix.elements;
    const focal=this.viewportHeight*p[5]*.5,areaLimit=this.viewportWidth*this.viewportHeight*q.flameArea;
    this.work.flameRefreshes++;this.work.treeScans+=total;
    for(let id=0;id<total;id++) {
      const i=id*10,j=id*4;
      const surface=detailed?clamp(fireStates[j],0,1):(trees[i+6]>=.65?clamp((trees[i+6]-.60)/.40,0,1):0);
      const crown=detailed?clamp(fireStates[j+1],0,1):0;
      if((surface<=.015&&crown<=.015)||trees[i+5]<0)continue;
      const x=trees[i],y=trees[i+1]+trees[i+3]*.4,z=trees[i+2],radius=Math.max(trees[i+4]*2,trees[i+3]*.7);
      const depth=-(m[2]*x+m[6]*y+m[10]*z+m[14]);
      if(depth+radius<this.camera.near||depth-radius>this.camera.far)continue;
      const vx=m[0]*x+m[4]*y+m[8]*z+m[12],vy=m[1]*x+m[5]*y+m[9]*z+m[13];
      if(Math.abs(vx)>Math.max(1,depth)/p[0]+radius||Math.abs(vy)>Math.max(1,depth)/p[5]+radius)continue;
      const pixels=(crown>.015?trees[i+3]:2.3)*focal/Math.max(1,depth);
      if(pixels<q.minPixels)continue;
      const priority=Math.min(127,Math.max(0,(Math.log2(1+pixels*(surface*.55+crown+1))*12)|0));
      this.treeDepth[id]=Math.max(1,depth);this.treeNext[id]=this.treeHeads[priority];this.treeHeads[priority]=id;
    }
    const fo=this.flameGeometry.attributes.iOrigin,fs=this.flameGeometry.attributes.iShape,st=this.flameGeometry.attributes.iState;
    let count=0,surfaceCount=0,crownCount=0,lightCount=0,burning=0,area=0;this.lightStrengths.fill(0);
    outer:for(let bucket=127;bucket>=0;bucket--)for(let id=this.treeHeads[bucket];id>=0;id=this.treeNext[id]) {
      if(burning>=q.fires)break outer;
      const i=id*10,j=id*4,depth=this.treeDepth[id];
      const surface=detailed?clamp(fireStates[j],0,1):clamp((trees[i+6]-.60)/.40,0,1),crown=detailed?clamp(fireStates[j+1],0,1):0;
      const release=detailed?clamp(fireStates[j+3],0,1):surface;
      const x=trees[i],y=trees[i+1],z=trees[i+2],height=trees[i+3],width=trees[i+4],burn=clamp(trees[i+7],0,1);
      const screenScale=focal/depth,projectedHeight=height*screenScale;
      const layers=Math.min(q.layers,projectedHeight<28?1:projectedHeight<60?2:q.layers);
      const cost=Math.min(this.viewportWidth*this.viewportHeight,((surface>.015?2.3:0)+(crown>.015?height*.65:0))*Math.max(1,width)*screenScale*screenScale*layers);
      if(area+cost>areaLimit&&burning>0)continue;area+=cost;burning++;
      const seed=fract(trees[i+9]*.731+x*.173+z*.357);
      if(surface>.015)for(let f=0;f<layers;f++) {
        const phase=fract(seed+f*.381966),angle=phase*TAU,radius=width*(f===0?.06:.26+phase*.18);
        fo.setXYZ(count,x+Math.cos(angle)*radius,y+.08,z+Math.sin(angle)*radius);
        const h=(.55+Math.sqrt(surface)*1.65)*(.72+phase*.55),w=(.58+width*.24)*(.78+phase*.45);
        fs.setXYZW(count,w,h,phase,surface*(.72+phase*.28));st.setXYZW(count,0,burn,(f%2?-.70:.70),release);count++;surfaceCount++;
      }
      if(crown>.015)for(let f=0;f<layers;f++) {
        const phase=fract(seed+f*.2781+.13),anchor=.28+(layers>1?f/(layers-1)*.48:.22),radius=width*(.22+(1-anchor)*.25);
        fo.setXYZ(count,x+Math.cos(phase*TAU)*radius,y+height*anchor,z+Math.sin(phase*TAU)*radius);
        const h=height*(.22+phase*.20)*(.50+Math.sqrt(crown)*.65),w=width*(.62+phase*.45)*(1-anchor*.33);
        fs.setXYZW(count,Math.max(.7,w),Math.max(.8,h),phase,crown*(.72+phase*.28));st.setXYZW(count,1,burn,(f%2?-.62:.62),release);count++;crownCount++;
      }
      if(lightCount<q.lights&&release>.035) {
        let separate=true;for(let k=0;k<lightCount;k++){const lp=this.lightTargets[k];if((lp.x-x)**2+(lp.z-z)**2<225)separate=false;}
        if(separate){this.lightTargets[lightCount].set(x,y+1.8+crown*height*.33,z);this.lightStrengths[lightCount]=170*release;lightCount++;}
      }
    }
    this.flameGeometry.instanceCount=count;this._upload(fo,count);this._upload(fs,count);this._upload(st,count);
    this.counts.burning=burning;this.counts.flames=count;this.counts.surfaceFlames=surfaceCount;this.counts.crownFlames=crownCount;
  }

  refreshParticles(smoke,embers,newSnapshot=true) {
    const total=Math.floor(smoke.length/8);this._ensureSmoke(total);this.smokeHeads.fill(-1);
    this.tileMass.fill(0);this.tileSelectedMass.fill(0);
    this.work.particleRefreshes++;this.work.particleScans+=total+Math.floor(embers.length/8);
    if(newSnapshot) {
      let swap=this.smokePrevious;this.smokePrevious=this.smokeCurrent;this.smokeCurrent=swap;this.smokeCurrent.build(smoke);
      swap=this.emberPrevious;this.emberPrevious=this.emberCurrent;this.emberCurrent=swap;this.emberCurrent.build(embers);
      this.hasParticleHistory=true;
    }
    const q=this.settings,m=this.camera.matrixWorldInverse.elements,p=this.camera.projectionMatrix.elements;
    const viewportArea=this.viewportWidth*this.viewportHeight,focal=this.viewportHeight*p[5]*.5,budget=viewportArea*q.area;
    for(let id=0;id<total;id++) {
      const i=id*8,opacity=smoke[i+4],diameter=smoke[i+3];if(opacity<.002||diameter<=0)continue;
      const x=smoke[i],y=smoke[i+1],z=smoke[i+2],depth=-(m[2]*x+m[6]*y+m[10]*z+m[14]);
      if(depth<this.camera.near||depth>this.camera.far)continue;
      const vx=m[0]*x+m[4]*y+m[8]*z+m[12],vy=m[1]*x+m[5]*y+m[9]*z+m[13],radius=diameter*.72;
      if(Math.abs(vx)>depth/p[0]+radius||Math.abs(vy)>depth/p[5]+radius)continue;
      const pixels=diameter*focal/depth;if(pixels<q.minPixels)continue;
      const area=Math.min(viewportArea,pixels*pixels*.8);
      const mass=area*(-Math.log1p(-Math.min(.98,opacity)));
      const tile=clamp(Math.floor((vx/depth*p[0]*.5+.5)*8),0,7)+clamp(Math.floor((vy/depth*p[5]*.5+.5)*6),0,5)*8;
      this.smokeTile[id]=tile;this.smokeMass[id]=mass;this.tileMass[tile]+=mass;
      const contribution=mass*(.85+clamp(smoke[i+5],0,1)*.35);
      const priority=Math.min(127,Math.max(0,(Math.log2(1+contribution)*8)|0));
      this.smokeDepth[id]=depth;this.smokeArea[id]=area;this.smokeNext[id]=this.smokeHeads[priority];this.smokeHeads[priority]=id;
    }
    let count=0,coverage=0;
    outer:for(let bucket=127;bucket>=0;bucket--)for(let id=this.smokeHeads[bucket];id>=0;id=this.smokeNext[id]) {
      if(count>=q.smoke)break outer;
      const area=this.smokeArea[id];if(coverage+area>budget)continue;
      this.smokeOrder[count++]=id;coverage+=area;this.tileSelectedMass[this.smokeTile[id]]+=this.smokeMass[id];
    }
    radixDepth(this.smokeOrder,this.sortScratch,this.smokeDepthBits,count,this.histogram);
    const so=this.smokeGeometry.attributes.iOrigin,ss=this.smokeGeometry.attributes.iShape,st=this.smokeGeometry.attributes.iState,sf=this.smokeGeometry.attributes.iFrom,sw=this.smokeGeometry.attributes.iWeight;
    const previous=this.smokePrevious.data;
    let interpolated=0,maxWeight=1;
    for(let out=0;out<count;out++) {
      const id=this.smokeOrder[count-out-1],tile=this.smokeTile[id];
      const weight=clamp(this.tileMass[tile]/Math.max(.001,this.tileSelectedMass[tile]),1,q.densityCap);
      sw.setX(out,weight);maxWeight=Math.max(maxWeight,weight);
      const i=id*8,x=smoke[i],y=smoke[i+1],z=smoke[i+2],size=smoke[i+3],age=smoke[i+6],seed=smoke[i+7];
      so.setXYZ(out,x,y,z);ss.setXYZW(out,size,clamp(smoke[i+4],0,1),clamp(smoke[i+5],0,1),fract(seed));
      const old=this.smokePrevious.find(seed),limit=Math.max(6,size*2+this.interpolationDuration*140);
      const matches=old>=0&&this.smokeCurrent.find(seed)>=0&&age>=previous[old+6]-.003&&age-previous[old+6]<.20&&(previous[old]-x)**2+(previous[old+1]-y)**2+(previous[old+2]-z)**2<limit*limit;
      if(matches){sf.setXYZW(out,previous[old],previous[old+1],previous[old+2],previous[old+3]);st.setXYZW(out,clamp(age,0,1),previous[old+4],previous[old+5],previous[old+6]);interpolated++;}
      else {sf.setXYZW(out,x,y,z,size);st.setXYZW(out,clamp(age,0,1),smoke[i+4],smoke[i+5],age);}
    }
    this.smokeGeometry.instanceCount=count;this._upload(so,count);this._upload(ss,count);this._upload(st,count);this._upload(sf,count);this._upload(sw,count);
    this.counts.smoke=count;this.work.smokeCoverage=coverage/viewportArea;this.work.interpolatedSmoke=interpolated;this.work.densityCompensationMax=maxWeight;
    const ep=this.emberGeometry.attributes.position,es=this.emberGeometry.attributes.aShape,ef=this.emberGeometry.attributes.aFrom,oldEmber=this.emberPrevious.data;
    count=0;interpolated=0;
    for(let i=0;i+7<embers.length&&count<q.embers;i+=8) {
      if(embers[i+3]<.005||embers[i+4]<=0)continue;
      const x=embers[i],y=embers[i+1],z=embers[i+2],depth=-(m[2]*x+m[6]*y+m[10]*z+m[14]);
      if(depth<this.camera.near||depth>this.camera.far)continue;
      const vx=m[0]*x+m[4]*y+m[8]*z+m[12],vy=m[1]*x+m[5]*y+m[9]*z+m[13];
      if(Math.abs(vx)>depth/p[0]+.5||Math.abs(vy)>depth/p[5]+.5)continue;
      ep.setXYZ(count,x,y,z);es.setXYZW(count,clamp(embers[i+3],0,1),embers[i+4],clamp(embers[i+5],0,1),fract(embers[i+6]));
      const old=this.emberPrevious.find(embers[i+6]),limit=12+this.interpolationDuration*240;
      const matches=old>=0&&this.emberCurrent.find(embers[i+6])>=0&&embers[i+5]>=oldEmber[old+5]-.005&&embers[i+5]-oldEmber[old+5]<.45&&(oldEmber[old]-x)**2+(oldEmber[old+1]-y)**2+(oldEmber[old+2]-z)**2<limit*limit;
      if(matches){ef.setXYZ(count,oldEmber[old],oldEmber[old+1],oldEmber[old+2]);interpolated++;}else ef.setXYZ(count,x,y,z);
      count++;
    }
    this.emberGeometry.setDrawRange(0,count);this._upload(ep,count);this._upload(es,count);this._upload(ef,count);
    this.counts.embers=count;this.work.interpolatedEmbers=interpolated;
  }

  dispose() {
    for(let i=0;i<3;i++){const mesh=i===0?this.flames:i===1?this.smoke:this.embers;this.scene.remove(mesh);mesh.geometry.dispose();mesh.material.dispose();this.scene.remove(this.lights[i]);}
    this.noiseField.dispose();this._resetHistory();
  }
}
