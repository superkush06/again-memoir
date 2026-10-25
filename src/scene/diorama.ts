import * as THREE from 'three';
import type { Memory, Participant, SceneSpec } from '../types';

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));
export const safeColor = (value: string | undefined, fallback: string) => /^#[0-9a-f]{6}$/i.test(value ?? '') ? value! : fallback;

function seededRandom(seed: string) {
  let state = [...seed].reduce((n, letter) => (n * 31 + letter.charCodeAt(0)) | 0, 917);
  return () => { state = (Math.imul(state, 1664525) + 1013904223) | 0; return (state >>> 0) / 4294967296; };
}

function mesh(geometry: THREE.BufferGeometry, color: string | number, roughness = .9) {
  const result = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color, roughness }));
  result.castShadow = true;
  result.receiveShadow = true;
  return result;
}

function tree(color: string, random: () => number) {
  const group = new THREE.Group();
  const trunk = mesh(new THREE.CylinderGeometry(.07, .12, 2.5, 7), '#665d42');
  trunk.position.y = 1.25;
  group.add(trunk);
  for (let i = 0; i < 3; i++) {
    const crown = mesh(new THREE.ConeGeometry(1.05 - i * .22, 1.8 - i * .18, 7), new THREE.Color(color).multiplyScalar(.8 + i * .13).getHex());
    crown.position.y = 1.65 + i * .66;
    crown.rotation.y = random();
    group.add(crown);
  }
  return group;
}

function flower(color: string, random: () => number) {
  const group = new THREE.Group();
  for (let i = 0; i < 5; i++) {
    const x = (random() - .5) * .65;
    const z = (random() - .5) * .65;
    const h = .18 + random() * .3;
    const stem = mesh(new THREE.CylinderGeometry(.012, .014, h, 4), '#6e8053');
    stem.position.set(x, h / 2, z);
    const bloom = mesh(new THREE.IcosahedronGeometry(.08 + random() * .04), color);
    bloom.position.set(x, h, z);
    group.add(stem, bloom);
  }
  return group;
}

function lantern(color: string) {
  const group = new THREE.Group();
  const base = mesh(new THREE.CylinderGeometry(.14, .18, .12, 8), '#665b43');
  base.position.y = .06;
  const glass = new THREE.Mesh(new THREE.CylinderGeometry(.11, .11, .25, 8), new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 1.1, roughness: .2 }));
  glass.position.y = .24;
  const lid = mesh(new THREE.ConeGeometry(.17, .1, 8), '#71644a');
  lid.position.y = .41;
  group.add(base, glass, lid);
  return group;
}

function object(type: string, color: string, random: () => number): THREE.Object3D {
  if (type === 'tree') return tree(color, random);
  if (type === 'flower') return flower(color, random);
  if (type === 'lantern') return lantern(color);
  if (type === 'building') {
    const group = new THREE.Group();
    const h = 1.6 + random() * 2;
    const building = mesh(new THREE.BoxGeometry(.9, h, .9), color);
    building.position.y = h / 2;
    group.add(building);
    for (let y = .4; y < h - .2; y += .5) {
      const window = mesh(new THREE.PlaneGeometry(.43, .18), '#d6be8c');
      window.position.set(0, y, .456);
      group.add(window);
    }
    return group;
  }
  if (type === 'mountain') {
    const mountain = mesh(new THREE.ConeGeometry(2.7, 4.5, 5), color);
    mountain.position.y = 2.1;
    return mountain;
  }
  const rock = mesh(new THREE.DodecahedronGeometry(.5, 0), color);
  rock.scale.set(1.3, .7, 1);
  rock.position.y = .2;
  return rock;
}

export function makeLabel(text: string, color = '#f5ead2', size = 32) {
  const canvas = document.createElement('canvas');
  canvas.width = 1024;
  canvas.height = 128;
  const context = canvas.getContext('2d');
  if (context) {
    context.font = `${size}px Georgia, serif`;
    context.fillStyle = color;
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText(text.slice(0, 84), 512, 64, 990);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const label = new THREE.Mesh(new THREE.PlaneGeometry(5, .625), new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false, side: THREE.DoubleSide }));
  return label;
}

export function buildDiorama(world: THREE.Scene, spec: SceneSpec | null, memory: Memory | null) {
  const random = seededRandom(memory?.id ?? 'memoir');
  const palette = {
    sky: safeColor(spec?.skyColor, '#233b31'),
    floor: safeColor(spec?.floorColor, '#475e42'),
    accent: safeColor(spec?.accentColor, '#d0aa73'),
  };
  world.background = new THREE.Color(palette.sky);
  world.fog = new THREE.FogExp2(palette.sky, .026);
  world.add(new THREE.HemisphereLight('#fff3d3', '#2c493c', clamp(spec?.ambientLight ?? 2.1, .5, 3)));
  const sunlight = new THREE.DirectionalLight('#ffe3ae', 3.8);
  sunlight.position.set(-5, 10, 5);
  sunlight.castShadow = true;
  sunlight.shadow.mapSize.set(1024, 1024);
  Object.assign(sunlight.shadow.camera, { left: -12, right: 12, top: 12, bottom: -12, near: .1, far: 40 });
  sunlight.shadow.bias = -.001;
  sunlight.shadow.normalBias = .035;
  world.add(sunlight);
  const rim = new THREE.DirectionalLight('#a0ba98', 1.8);
  rim.position.set(5, 5, -8);
  world.add(rim);

  const ground = mesh(new THREE.PlaneGeometry(150, 150), palette.floor);
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -.32;
  ground.castShadow = false;
  world.add(ground);
  const stage = mesh(new THREE.CylinderGeometry(7.6, 7.8, .22, 96), new THREE.Color(palette.floor).multiplyScalar(.85).getHex());
  stage.position.y = -.16;
  world.add(stage);
  const platform = mesh(new THREE.CylinderGeometry(4.5, 4.65, .1, 96), '#b7b091');
  platform.position.set(0, -.03, -.3);
  world.add(platform);
  const platformTop = mesh(new THREE.CylinderGeometry(4.44, 4.44, .025, 96), '#a9a68a');
  platformTop.position.set(0, .03, -.3);
  world.add(platformTop);
  const circle = new THREE.Mesh(new THREE.RingGeometry(4.13, 4.15, 128), new THREE.MeshBasicMaterial({ color: '#d1c3a0', side: THREE.DoubleSide }));
  circle.rotation.x = -Math.PI / 2;
  circle.position.set(0, .048, -.3);
  world.add(circle);

  const photoGroup = new THREE.Group();
  photoGroup.position.set(0, 2.65, -1.7);
  const ratio = memory?.width && memory?.height ? memory.width / memory.height : 1.5;
  const photoWidth = Math.min(5.4, 3.4 * ratio);
  const photoHeight = Math.min(3.4, 5.4 / ratio);
  const frame = mesh(new THREE.BoxGeometry(photoWidth + .18, photoHeight + .18, .13), palette.accent, .4);
  const inset = mesh(new THREE.BoxGeometry(photoWidth + .045, photoHeight + .045, .018), '#f0e4c8');
  inset.position.z = .075;
  const imageMaterial = new THREE.MeshBasicMaterial({ color: '#b5b399', side: THREE.DoubleSide, toneMapped: false });
  const photograph = new THREE.Mesh(new THREE.PlaneGeometry(photoWidth, photoHeight), imageMaterial);
  photograph.position.z = .09;
  photograph.userData.memoryId = memory?.id;
  photoGroup.add(frame, inset, photograph);
  for (const x of [-photoWidth * .36, photoWidth * .36]) {
    const stand = mesh(new THREE.CylinderGeometry(.035, .035, 2.65, 8), palette.accent, .35);
    stand.position.set(x, -1.325, -.02);
    photoGroup.add(stand);
  }
  world.add(photoGroup);

  const title = makeLabel(memory?.title ?? 'A place for your memories', '#f8e9ce', 38);
  title.position.set(0, .52, -1.55);
  world.add(title);
  const location = makeLabel(memory?.location || 'Your life, a little closer.', '#c9c6ac', 23);
  location.position.set(0, .28, -1.54);
  world.add(location);

  const environment = spec?.environment ?? 'forest';
  for (let i = 0; i < 29; i++) {
    const angle = random() * Math.PI * 2;
    const radius = 7 + random() * 13;
    const x = Math.cos(angle) * radius;
    const z = Math.sin(angle) * radius - 4;
    if (z > 2 && Math.abs(x) < 6) continue;
    const type = environment === 'city' ? 'building' : environment === 'mountain' && i % 3 === 0 ? 'mountain' : environment === 'beach' ? 'rock' : 'tree';
    const color = type === 'building' ? '#687466' : type === 'rock' ? '#a39978' : type === 'mountain' ? '#4c6556' : '#365d40';
    const prop = object(type, color, random);
    prop.position.set(x, -.2, z);
    prop.scale.setScalar(type === 'rock' ? 1 + random() * 2 : .65 + random() * 1.4);
    prop.rotation.y = random() * Math.PI * 2;
    world.add(prop);
  }
  for (let i = 0; i < 22; i++) {
    const angle = random() * Math.PI * 2;
    const radius = 4.8 + random() * 1.9;
    const prop = i % 5 === 0 ? lantern(palette.accent) : i % 3 === 0 ? object('rock', '#737c61', random) : flower(i % 2 ? '#c1b98a' : palette.accent, random);
    prop.position.set(Math.cos(angle) * radius, -.03, Math.sin(angle) * radius - .3);
    world.add(prop);
  }

  for (const item of (spec?.objects ?? []).slice(0, 40)) {
    if (!item.position?.every(Number.isFinite)) continue;
    const defaultColor = item.type === 'tree' ? '#426343' : palette.accent;
    const prop = object(item.type, safeColor(item.color, defaultColor), random);
    prop.position.set(clamp(item.position[0], -20, 20), clamp(item.position[1], -.2, 10), clamp(item.position[2], -22, 12));
    prop.scale.setScalar(clamp(item.scale ?? 1, .15, 4));
    world.add(prop);
  }

  const motes = new Float32Array(100 * 3);
  for (let i = 0; i < motes.length; i += 3) {
    motes[i] = (random() - .5) * 30;
    motes[i + 1] = .5 + random() * 8;
    motes[i + 2] = (random() - .5) * 22 - 3;
  }
  const particlesGeometry = new THREE.BufferGeometry();
  particlesGeometry.setAttribute('position', new THREE.BufferAttribute(motes, 3));
  const particles = new THREE.Points(particlesGeometry, new THREE.PointsMaterial({ color: '#efdb9f', size: .025, transparent: true, opacity: .55, depthWrite: false }));
  world.add(particles);
  return { photograph, imageMaterial, particles, photoWidth, photoHeight };
}

export function buildAvatar(participant: Participant) {
  const avatar = new THREE.Group();
  const color = safeColor(participant.color, '#d6b081');
  const head = mesh(new THREE.SphereGeometry(.13, 16, 12), color, .5);
  const visor = mesh(new THREE.BoxGeometry(.18, .065, .045), '#243a32', .2);
  visor.position.set(0, .01, -.12);
  const nose = mesh(new THREE.ConeGeometry(.028, .08, 8), color);
  nose.rotation.x = -Math.PI / 2;
  nose.position.z = -.18;
  const body = mesh(new THREE.CylinderGeometry(.1, .16, .25, 12), color);
  body.position.y = -.28;
  const label = makeLabel(participant.name.slice(0, 40), '#f8edce', 48);
  label.scale.setScalar(.18);
  label.position.y = .3;
  label.userData.isNameLabel = true;
  avatar.add(head, visor, nose, body, label);
  avatar.userData.label = label;
  return avatar;
}

export function disposeObject(root: THREE.Object3D) {
  const textures = new Set<THREE.Texture>();
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  root.traverse(object => {
    if (object instanceof THREE.DirectionalLight || object instanceof THREE.SpotLight || object instanceof THREE.PointLight) object.shadow.dispose();
    const drawable = object as THREE.Mesh;
    if (drawable.geometry) geometries.add(drawable.geometry);
    const list = Array.isArray(drawable.material) ? drawable.material : drawable.material ? [drawable.material] : [];
    for (const material of list) {
      materials.add(material);
      for (const value of Object.values(material)) if (value instanceof THREE.Texture) textures.add(value);
    }
  });
  textures.forEach(texture => texture.dispose());
  geometries.forEach(geometry => geometry.dispose());
  materials.forEach(material => material.dispose());
}
