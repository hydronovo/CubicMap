import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import {
  PHI, CANVAS_WIDTH_MM, TIERS, maxQueryTier, buildOverpassQuery,
  processWays, autoTier, buildSVG, buildMesh, toSTL,
} from './lib.js';

const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];

const $ = (id) => document.getElementById(id);

const state = {
  orientation: 'landscape',
  frameScale: 0.7,
  frameRect: null, // 选框在地图容器中的像素位置
  data: null, // processWays 的结果
  svg: null,
  mesh: null,
};

// ---------- 地图与选框 ----------

const map = L.map('map', { zoomControl: true, worldCopyJump: true }).setView([31.2397, 121.4998], 14);
L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
  maxZoom: 19,
  subdomains: 'abcd',
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
}).addTo(map);

const frameEl = $('frame');
const aspect = () => (state.orientation === 'landscape' ? PHI : 1 / PHI);

function layoutFrame() {
  const c = map.getSize();
  const a = aspect();
  const s = state.frameScale;
  let w = c.x * s, h = w / a;
  if (h > c.y * s) { h = c.y * s; w = h * a; }
  const l = (c.x - w) / 2, t = (c.y - h) / 2;
  state.frameRect = { l, t, w, h };
  Object.assign(frameEl.style, { left: l + 'px', top: t + 'px', width: w + 'px', height: h + 'px' });
  frameEl.classList.toggle('portrait', state.orientation === 'portrait');
  updateFrameInfo();
}

function selectionBounds() {
  const { l, t, w, h } = state.frameRect;
  const nw = map.containerPointToLatLng([l, t]);
  const se = map.containerPointToLatLng([l + w, t + h]);
  return { north: nw.lat, west: nw.lng, south: se.lat, east: se.lng };
}

function groundSize(b) {
  const mid = (b.north + b.south) / 2;
  const w = map.distance([mid, b.west], [mid, b.east]);
  const h = map.distance([b.north, b.west], [b.south, b.west]);
  return { w, h };
}

const fmtDist = (m) => (m >= 1000 ? (m / 1000).toFixed(m >= 10000 ? 0 : 2) + ' km' : Math.round(m) + ' m');

function updateFrameInfo() {
  const { w, h } = groundSize(selectionBounds());
  $('frame-info').textContent = `${fmtDist(w)} × ${fmtDist(h)} · 1 : 1.618`;
}

map.on('move zoom resize', updateFrameInfo);
map.on('resize', layoutFrame);
new ResizeObserver(() => { map.invalidateSize(); layoutFrame(); }).observe(document.querySelector('.map-wrap'));

document.querySelectorAll('[data-orient]').forEach((btn) => {
  btn.addEventListener('click', () => {
    state.orientation = btn.dataset.orient;
    document.querySelectorAll('[data-orient]').forEach((b) => b.classList.toggle('active', b === btn));
    layoutFrame();
  });
});
$('frame-scale').addEventListener('input', (e) => {
  state.frameScale = e.target.value / 100;
  layoutFrame();
});

$('search').addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = $('search-input').value.trim();
  if (!q) return;
  try {
    const res = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(q)}`, {
      headers: { 'Accept-Language': 'zh-CN,zh,en' },
    });
    const list = await res.json();
    if (!list.length) return setStatus(`没有找到“${q}”`, true);
    const [s, n, w, ea] = list[0].boundingbox.map(Number);
    map.fitBounds([[s, w], [n, ea]], { maxZoom: 16 });
    setStatus(null);
  } catch (err) {
    setStatus('搜索失败：' + err.message, true);
  }
});

// ---------- 状态提示 ----------

function setStatus(msg, isError = false) {
  const el = $('status');
  el.hidden = !msg;
  el.textContent = msg || '';
  el.classList.toggle('error', isError);
}

// ---------- 生成二维图 ----------

async function fetchOverpass(query) {
  let lastErr;
  for (const url of OVERPASS_ENDPOINTS) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        body: 'data=' + encodeURIComponent(query),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

$('btn-generate').addEventListener('click', async () => {
  const b = selectionBounds();
  const { w, h } = groundSize(b);
  const maxTier = maxQueryTier((w * h) / 1e6);
  if (maxTier < 0) return setStatus('选区太大了，请放大地图后再生成。', true);

  const btn = $('btn-generate');
  btn.disabled = true;
  setStatus('正在获取路网数据…');
  try {
    const json = await fetchOverpass(buildOverpassQuery(b, maxTier));
    const W = CANVAS_WIDTH_MM, H = W / aspect();
    state.data = processWays(json.elements || [], b, W, H);
    if (!state.data.runs.length) {
      setStatus('这个区域没有找到道路，换个地方试试。', true);
      return;
    }
    fillDensityOptions();
    setStatus(null);
    $('sec-2d').hidden = false;
    $('sec-3d').hidden = true;
    render2D();
    $('sec-2d').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    setStatus('获取路网失败（' + err.message + '），请稍后重试。', true);
  } finally {
    btn.disabled = false;
  }
});

function fillDensityOptions() {
  const sel = $('density');
  sel.length = 1;
  TIERS.forEach((t, i) => {
    if (!state.data.lengths[i]) return;
    const opt = document.createElement('option');
    opt.value = String(i);
    opt.textContent = '显示到：' + t.name;
    sel.appendChild(opt);
  });
  sel.value = 'auto';
}

function styleOpts() {
  const lineMul = $('line-mul').value / 100;
  const d = $('density').value;
  const maxTier = d === 'auto' ? autoTier(state.data.lengths, state.data.W, state.data.H, lineMul) : Number(d);
  return {
    maxTier,
    lineMul,
    roadColor: $('road-color').value,
    borderColor: $('border-color').value,
    bgColor: $('bg-color').value,
    borderWidth: clamp(Number($('border-width').value) || 2, 0.5, 8),
  };
}

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

function render2D() {
  const opts = styleOpts();
  state.svg = buildSVG(state.data, opts);
  $('preview').innerHTML = state.svg;
  const shown = state.data.runs.filter((r) => r.tier <= opts.maxTier).length;
  $('stats').textContent = `显示 ${shown} 段道路（${TIERS[0].name} → ${TIERS[opts.maxTier].name}）· 画幅 ${state.data.W} × ${state.data.H.toFixed(1)} mm`;
}

['density', 'line-mul', 'road-color', 'border-color', 'bg-color', 'border-width'].forEach((id) => {
  $(id).addEventListener('input', () => {
    if (!state.data) return;
    render2D();
    if (!$('sec-3d').hidden) build3D();
  });
});

function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

$('dl-svg').addEventListener('click', () => {
  download(new Blob([state.svg], { type: 'image/svg+xml' }), 'cubicmap.svg');
});

$('dl-png').addEventListener('click', () => {
  const img = new Image();
  const url = URL.createObjectURL(new Blob([state.svg], { type: 'image/svg+xml' }));
  img.onload = () => {
    const pxW = 3000; // 100mm ≈ 762 dpi
    const canvas = document.createElement('canvas');
    canvas.width = pxW;
    canvas.height = Math.round(pxW * state.data.H / state.data.W);
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    URL.revokeObjectURL(url);
    canvas.toBlob((b) => download(b, 'cubicmap.png'), 'image/png');
  };
  img.src = url;
});

// ---------- 三维 ----------

let three = null;

function initThree() {
  const el = $('view3d');
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  el.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xeceae4);
  const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 5000);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8578, 1.6));
  const sun = new THREE.DirectionalLight(0xffffff, 1.6);
  sun.position.set(-0.6, -0.8, 1.4);
  scene.add(sun);
  const baseMaterial = new THREE.MeshStandardMaterial({ color: 0xf2efe8, roughness: 0.8 });
  const material = new THREE.MeshStandardMaterial({ color: 0x2a2a2a, roughness: 0.65, metalness: 0.05 });
  const mesh = new THREE.Mesh(new THREE.BufferGeometry(), [baseMaterial, material]);
  scene.add(mesh);

  const resize = () => {
    const w = el.clientWidth, h = el.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  new ResizeObserver(resize).observe(el);
  resize();
  renderer.setAnimationLoop(() => {
    controls.update();
    renderer.render(scene, camera);
  });
  three = { camera, controls, mesh, material, baseMaterial };
}

function build3D() {
  const width = clamp(Number($('w3d').value) || 100, 20, 400);
  const thickness = clamp(Number($('thick').value) || 5, 1, 30);
  const base = clamp(Number($('base').value) || 0, 0, thickness - 0.4);
  const minLine = clamp(Number($('min-line').value) || 0.6, 0.2, 3);
  const opts = { ...styleOpts(), width, thickness, base, minLine };

  const firstTime = !three;
  if (firstTime) initThree();
  state.mesh = buildMesh(state.data, opts);

  const geo = new THREE.BufferGeometry();
  // 复制一份用于预览居中，STL 保留原始坐标（原点在左下角）
  geo.setAttribute('position', new THREE.BufferAttribute(state.mesh.positions.slice(), 3));
  geo.computeVertexNormals();
  const total = state.mesh.positions.length / 3;
  geo.addGroup(0, state.mesh.baseCount, 0);
  geo.addGroup(state.mesh.baseCount, total - state.mesh.baseCount, 1);
  geo.translate(-state.mesh.width / 2, -state.mesh.height / 2, 0);
  three.mesh.geometry.dispose();
  three.mesh.geometry = geo;
  three.material.color.set(opts.roadColor === '#000000' ? '#2a2a2a' : opts.roadColor);
  three.baseMaterial.color.set(opts.bgColor);

  if (firstTime) {
    const d = Math.max(state.mesh.width, state.mesh.height);
    three.camera.position.set(0, -d * 1.1, d * 1.0);
    three.camera.up.set(0, 0, 1);
    three.controls.target.set(0, 0, 0);
  }

  const tris = state.mesh.positions.length / 9;
  $('stats3d').textContent = `${state.mesh.width.toFixed(1)} × ${state.mesh.height.toFixed(1)} × ${thickness} mm · 底板 ${base} mm · ${tris.toLocaleString()} 个三角面`;
}

$('btn-3d').addEventListener('click', () => {
  $('sec-3d').hidden = false;
  // 等布局完成再初始化 WebGL，保证画布尺寸正确
  requestAnimationFrame(() => {
    build3D();
    $('sec-3d').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
});
$('btn-rebuild').addEventListener('click', build3D);
['w3d', 'thick', 'base', 'min-line'].forEach((id) => $(id).addEventListener('change', build3D));

$('dl-stl').addEventListener('click', () => {
  if (!state.mesh) return;
  download(new Blob([toSTL(state.mesh.positions)], { type: 'model/stl' }), 'cubicmap.stl');
});

layoutFrame();
