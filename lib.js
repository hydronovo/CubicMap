// 纯计算逻辑：投影、裁剪、简化、密度选择、SVG 与三维网格生成。
// 不依赖 DOM / Leaflet / three.js，可在 Node 中直接测试。

export const PHI = (1 + Math.sqrt(5)) / 2;

// 二维图的画布宽度（mm），高度 = 宽 / 宽高比
export const CANVAS_WIDTH_MM = 100;

// 道路分级：从主到次。width 为 100mm 宽画布上的线宽（mm）
export const TIERS = [
  { name: '高速 / 快速路', types: ['motorway', 'trunk', 'motorway_link', 'trunk_link'], width: 1.1 },
  { name: '主干道', types: ['primary', 'primary_link'], width: 0.9 },
  { name: '次干道', types: ['secondary', 'secondary_link'], width: 0.7 },
  { name: '支路', types: ['tertiary', 'tertiary_link'], width: 0.55 },
  { name: '街道', types: ['residential', 'unclassified', 'living_street', 'road'], width: 0.4 },
  { name: '服务道路', types: ['service', 'pedestrian', 'track', 'busway'], width: 0.3 },
  { name: '步行 / 骑行', types: ['footway', 'path', 'cycleway', 'steps', 'bridleway'], width: 0.22 },
];

const TYPE_TO_TIER = {};
TIERS.forEach((t, i) => t.types.forEach((ty) => { TYPE_TO_TIER[ty] = i; }));

// 自动模式下道路墨迹覆盖率的目标值（道路总面积 / 画布面积）
export const TARGET_COVERAGE = 0.14;
// 覆盖率低于该值时，即使超过目标也继续加入下一级，避免画面过空
export const MIN_COVERAGE = 0.05;

const mercY = (lat) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));

// 选区越大，只请求越主要的道路，避免 Overpass 返回过多数据。返回可请求的最低层级，-1 表示区域过大
export function maxQueryTier(areaKm2) {
  if (areaKm2 <= 4) return 6;
  if (areaKm2 <= 30) return 5;
  if (areaKm2 <= 200) return 4;
  if (areaKm2 <= 1500) return 3;
  if (areaKm2 <= 10000) return 2;
  if (areaKm2 <= 80000) return 1;
  if (areaKm2 <= 600000) return 0;
  return -1;
}

export function buildOverpassQuery(b, maxTier) {
  const types = TIERS.slice(0, maxTier + 1).flatMap((t) => t.types);
  const bbox = [b.south, b.west, b.north, b.east].map((v) => v.toFixed(6)).join(',');
  return `[out:json][timeout:90];way["highway"~"^(${types.join('|')})$"](${bbox});out geom;`;
}

// Liang–Barsky 线段裁剪，返回 [t0, t1] 或 null
function clipSegment(x0, y0, x1, y1, W, H) {
  const dx = x1 - x0, dy = y1 - y0;
  const p = [-dx, dx, -dy, dy];
  const q = [x0, W - x0, y0, H - y0];
  let t0 = 0, t1 = 1;
  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) {
      if (q[i] < 0) return null;
    } else {
      const r = q[i] / p[i];
      if (p[i] < 0) { if (r > t1) return null; if (r > t0) t0 = r; }
      else { if (r < t0) return null; if (r < t1) t1 = r; }
    }
  }
  return [t0, t1];
}

// 把折线裁剪到 [0,W]×[0,H]，可能拆成多段
export function clipPolyline(pts, W, H) {
  const runs = [];
  let cur = null;
  for (let i = 0; i < pts.length - 1; i++) {
    const [x0, y0] = pts[i], [x1, y1] = pts[i + 1];
    const c = clipSegment(x0, y0, x1, y1, W, H);
    if (!c) { cur = null; continue; }
    const a = [x0 + (x1 - x0) * c[0], y0 + (y1 - y0) * c[0]];
    const b = [x0 + (x1 - x0) * c[1], y0 + (y1 - y0) * c[1]];
    if (!cur || c[0] > 0) {
      cur = [a];
      runs.push(cur);
    }
    cur.push(b);
    if (c[1] < 1) cur = null;
  }
  return runs.filter((r) => r.length >= 2);
}

// Ramer–Douglas–Peucker 简化
export function simplify(pts, eps) {
  if (pts.length <= 2) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  const eps2 = eps * eps;
  while (stack.length) {
    const [s, e] = stack.pop();
    const [ax, ay] = pts[s], [bx, by] = pts[e];
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let maxD = -1, idx = -1;
    for (let i = s + 1; i < e; i++) {
      const [px, py] = pts[i];
      let d2;
      if (len2 === 0) {
        d2 = (px - ax) ** 2 + (py - ay) ** 2;
      } else {
        const cross = dx * (py - ay) - dy * (px - ax);
        d2 = (cross * cross) / len2;
      }
      if (d2 > maxD) { maxD = d2; idx = i; }
    }
    if (maxD > eps2) {
      keep[idx] = 1;
      stack.push([s, idx], [idx, e]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

const polyLength = (pts) => {
  let L = 0;
  for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  return L;
};

// 把 Overpass 返回的 ways 投影到 W×H（mm）画布并裁剪
export function processWays(elements, b, W, H) {
  const yN = mercY(b.north), yS = mercY(b.south);
  const sx = W / (b.east - b.west), sy = H / (yN - yS);
  const runs = [];
  const lengths = new Array(TIERS.length).fill(0);
  for (const el of elements) {
    if (el.type !== 'way' || !el.geometry || !el.tags) continue;
    const tier = TYPE_TO_TIER[el.tags.highway];
    if (tier === undefined || el.tags.area === 'yes') continue;
    const pts = el.geometry.filter(Boolean).map((g) => [(g.lon - b.west) * sx, (yN - mercY(g.lat)) * sy]);
    for (const r of clipPolyline(pts, W, H)) {
      const s = simplify(r, 0.06);
      const L = polyLength(s);
      if (L < 0.05) continue;
      lengths[tier] += L;
      runs.push({ tier, pts: s });
    }
  }
  // 次要道路在前，主要道路后画，压在上面
  runs.sort((a, c) => c.tier - a.tier);
  return { W, H, runs, lengths };
}

// 根据各级道路长度自动选择显示到哪一级：累计覆盖率不超过目标值，但不低于下限
export function autoTier(lengths, W, H, lineMul = 1) {
  const area = W * H;
  let cov = 0, cutoff = -1;
  for (let i = 0; i < TIERS.length; i++) {
    if (!lengths[i]) continue;
    const c = (lengths[i] * TIERS[i].width * lineMul) / area;
    if (cutoff >= 0 && cov >= MIN_COVERAGE && cov + c > TARGET_COVERAGE) break;
    cov += c;
    cutoff = i;
  }
  return cutoff;
}

const fmt = (v) => (Math.round(v * 100) / 100).toString();

export function buildSVG(data, opts) {
  const { W, H, runs } = data;
  const { maxTier, lineMul, roadColor, borderColor, borderWidth, bgColor } = opts;
  const paths = [];
  for (let t = TIERS.length - 1; t >= 0; t--) {
    if (t > maxTier) continue;
    let d = '';
    for (const r of runs) {
      if (r.tier !== t) continue;
      d += 'M' + r.pts.map((p) => fmt(p[0]) + ' ' + fmt(p[1])).join('L');
    }
    if (d) paths.push(`<path stroke-width="${fmt(TIERS[t].width * lineMul)}" d="${d}"/>`);
  }
  const bw = borderWidth;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${fmt(W)}mm" height="${fmt(H)}mm" viewBox="0 0 ${fmt(W)} ${fmt(H)}">`
    + `<defs><clipPath id="cm-clip"><rect width="${fmt(W)}" height="${fmt(H)}"/></clipPath></defs>`
    + `<rect width="${fmt(W)}" height="${fmt(H)}" fill="${bgColor}"/>`
    + `<g clip-path="url(#cm-clip)" fill="none" stroke="${roadColor}" stroke-linecap="round" stroke-linejoin="round">${paths.join('')}</g>`
    + `<rect x="${fmt(bw / 2)}" y="${fmt(bw / 2)}" width="${fmt(W - bw)}" height="${fmt(H - bw)}" fill="none" stroke="${borderColor}" stroke-width="${fmt(bw)}"/>`
    + `</svg>`;
}

// ---------- 三维 ----------

// 生成三角形数组（每个三角形 9 个数），俯视图即二维图：底板 + 凸起的边框和道路
export function buildMesh(data, opts) {
  const { maxTier, lineMul, borderWidth, width, thickness, base, minLine } = opts;
  const s = width / data.W;
  const outW = width, outH = data.H * s;
  const out = [];

  const v = (x, y, z) => out.push(x, y, z);
  // 凸多边形柱体（自动纠正为逆时针）
  function prism(poly, z0, z1) {
    let area = 0;
    for (let i = 0; i < poly.length; i++) {
      const [ax, ay] = poly[i], [bx, by] = poly[(i + 1) % poly.length];
      area += ax * by - bx * ay;
    }
    if (Math.abs(area) < 1e-9) return;
    if (area < 0) poly = poly.slice().reverse();
    const n = poly.length;
    for (let i = 1; i < n - 1; i++) {
      v(poly[0][0], poly[0][1], z1); v(poly[i][0], poly[i][1], z1); v(poly[i + 1][0], poly[i + 1][1], z1);
      v(poly[0][0], poly[0][1], z0); v(poly[i + 1][0], poly[i + 1][1], z0); v(poly[i][0], poly[i][1], z0);
    }
    for (let i = 0; i < n; i++) {
      const a = poly[i], b = poly[(i + 1) % n];
      v(a[0], a[1], z0); v(b[0], b[1], z0); v(b[0], b[1], z1);
      v(a[0], a[1], z0); v(b[0], b[1], z1); v(a[0], a[1], z1);
    }
  }
  const rect = (x0, y0, x1, y1, z0, z1) => prism([[x0, y0], [x1, y0], [x1, y1], [x0, y1]], z0, z1);

  if (base > 0) rect(0, 0, outW, outH, 0, base);
  const baseCount = out.length / 3; // 底板顶点数，用于预览时分色

  const bw = Math.max(borderWidth * s, minLine);
  rect(0, 0, outW, bw, 0, thickness);
  rect(0, outH - bw, outW, outH, 0, thickness);
  rect(0, bw, bw, outH - bw, 0, thickness);
  rect(outW - bw, bw, outW, outH - bw, 0, thickness);

  const JOINT_SIDES = 8;
  const MIN_TURN = Math.cos((8 * Math.PI) / 180);
  for (const r of data.runs) {
    if (r.tier > maxTier) continue;
    const hw = Math.max(TIERS[r.tier].width * lineMul * s, minLine) / 2;
    // 二维 y 向下，三维 y 向上；向内收 hw 再裁剪，保证路的端角不伸出边框
    const pts0 = r.pts.map((p) => [p[0] * s - hw, outH - p[1] * s - hw]);
    for (const clipped of clipPolyline(pts0, outW - 2 * hw, outH - 2 * hw)) {
      roadPrisms(clipped.map((p) => [p[0] + hw, p[1] + hw]), hw);
    }
  }

  function roadPrisms(pts, hw) {
    let prevDir = null;
    for (let i = 0; i < pts.length - 1; i++) {
      const [x0, y0] = pts[i], [x1, y1] = pts[i + 1];
      const len = Math.hypot(x1 - x0, y1 - y0);
      if (len < 1e-6) continue;
      const ux = (x1 - x0) / len, uy = (y1 - y0) / len;
      const nx = -uy * hw, ny = ux * hw;
      prism([[x0 + nx, y0 + ny], [x1 + nx, y1 + ny], [x1 - nx, y1 - ny], [x0 - nx, y0 - ny]], 0, thickness);
      // 转弯处补一个多边形柱，填平接缝
      if (prevDir && prevDir[0] * ux + prevDir[1] * uy < MIN_TURN) {
        const poly = [];
        for (let k = 0; k < JOINT_SIDES; k++) {
          const a = (k / JOINT_SIDES) * Math.PI * 2;
          poly.push([x0 + Math.cos(a) * hw, y0 + Math.sin(a) * hw]);
        }
        prism(poly, 0, thickness);
      }
      prevDir = [ux, uy];
    }
  }
  return { positions: new Float32Array(out), baseCount, width: outW, height: outH };
}

// 二进制 STL
export function toSTL(positions) {
  const n = positions.length / 9;
  const buf = new ArrayBuffer(84 + n * 50);
  const dv = new DataView(buf);
  const header = 'CubicMap STL';
  for (let i = 0; i < header.length; i++) dv.setUint8(i, header.charCodeAt(i));
  dv.setUint32(80, n, true);
  let o = 84;
  for (let t = 0; t < n; t++) {
    const p = positions.subarray(t * 9, t * 9 + 9);
    const ax = p[3] - p[0], ay = p[4] - p[1], az = p[5] - p[2];
    const bx = p[6] - p[0], by = p[7] - p[1], bz = p[8] - p[2];
    let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    dv.setFloat32(o, nx, true); dv.setFloat32(o + 4, ny, true); dv.setFloat32(o + 8, nz, true);
    o += 12;
    for (let k = 0; k < 9; k++) { dv.setFloat32(o, p[k], true); o += 4; }
    dv.setUint16(o, 0, true);
    o += 2;
  }
  return buf;
}
