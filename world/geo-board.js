/**
 * geo-board.js — Tecland: a 3D world of job centers.
 *
 * One island per job center. Island size = roles hired there. Islands are placed by
 * projected lat/long and then force-relaxed so nothing touches, which keeps east-west
 * and rough north-south order — all the geography a reader needs.
 *
 * Inside an island, companies are spiral-packed villages: footprint = its roles in that
 * center, height = company momentum (unchanged from the island board), one building per
 * function, ground tint = sector. Low-precision centers (a country, not a city) get a
 * half-height rim: precision as texture.
 *
 * Bare `Remote` is a center too — no land, a flotilla of rigs and ships in open water.
 *
 * Exposes window.createGeoBoard. Requires three.js >= 0.160.
 */
import * as THREE from 'https://esm.sh/three@0.169.0';
import { OrbitControls } from 'https://esm.sh/three@0.169.0/examples/jsm/controls/OrbitControls.js';
import { normalizeBoardData, fetchBoardData, CENTERS } from './geo-data.js';
import { SECTOR_TERRAIN, makeSectorFeature, sectorTint } from './assets/sector-terrain.js';

export const FUNCTION_COLORS = {
  engineering: '#fb5b60', product: '#1e83c4', design: '#fecd44', research: '#6a4f96',
  sales: '#8cc63e', marketing: '#f5893c', operations: '#33b0a6', other: '#54505c',
};

export const SECTOR_TINTS = [
  [/agent|^ai$|ai /i, 'AI & agents', 0xbdd6e8],
  [/infra|dev tools|devops|construction/i, 'Infra & dev tools', 0xd2e3b4],
  [/consumer|media|creator|gaming|sports/i, 'Consumer & media', 0xfbc5c2],
  [/commerce|marketplace|fintech|financial/i, 'Commerce & fintech', 0xfde7ad],
  [/enterprise|sales|gtm|hr tech|talent|saas|edtech|adtech/i, 'Enterprise & GTM', 0xd6c9e5],
];

/**
 * Sector encoding, a peer of day/night. `tint` is the shipped pastel-only board;
 * `terrain` moves the sector into the silhouette (peaks, terraces, orchard, fields,
 * conifers, scrub) and lets the cap tint saturate. See LAYOUT_AND_ICONS.md 4.5.
 */
export const SECTOR_STYLES = {
  tint: { label: 'Flat', grassMix: 0.58, features: false, nightCapMix: 1 },
  terrain: { label: 'Terrain', grassMix: 0.22, features: true, nightCapMix: 0.5 },
};

const THEME = {
  day: {
    bg: 0xfff2ee, hemi: 0xffffff, hemiGround: 0xd8c8c2, hemiI: 0.75,
    key: 0xffffff, keyI: 2.1, fillI: 0.35,
    sea: 0x79cfe0, waterSide: 0x6fbccb, side: 0xc0a493, wall: 0xfbf4f0, capMix: null,
    grid: 0xffffff, gridOpacity: 0.34,
  },
  night: {
    bg: 0x141b24, hemi: 0x9fb6cc, hemiGround: 0x1b2530, hemiI: 0.45,
    key: 0xdce8f6, keyI: 1.35, fillI: 0.18,
    sea: 0x2f7f92, waterSide: 0x3a7c8c, side: 0x8ea3b5, wall: 0xe9eef4,
    capMix: { color: 0xeaf3fb, amount: 0.72 },
    grid: 0x9fd8e8, gridOpacity: 0.2,
  },
};

const GRASS = 0xbfe07d, GRASS_MIX = 0.58;
const LAND_H = 0.62, SEA_Y = 0.3, RIM_H = 0.5, HAZY_H = 0.4;
const HEIGHT_SWING = 0.55, VALLEY_SWING = 0.2;
const DECK_H = 0.72;
const SELECT_GLOW = 0xfb5b60;
const SPACING = Math.sqrt(3);           // hex centre-to-centre at radius 1
const GAP = 1.9;                        // open water between island rims, in hex radii

const rand = (s) => { const x = Math.sin(s * 12.9898) * 43758.5453; return x - Math.floor(x); };
const hexPos = (q, r) => ({ x: SPACING * (q + r / 2), z: 1.5 * r });
const ringOf = (c) => Math.max(Math.abs(c.q), Math.abs(c.r), Math.abs(c.q + c.r));
const NBR = [[1, 0], [0, 1], [-1, 1], [-1, 0], [0, -1], [1, -1]];
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

function spiral(radius) {
  const out = [{ q: 0, r: 0 }];
  for (let k = 1; k <= radius; k++) {
    let q = -k, r = k;
    for (let d = 0; d < 6; d++) for (let i = 0; i < k; i++) { out.push({ q, r }); q += NBR[d][0]; r += NBR[d][1]; }
  }
  return out;
}

export function sectorOf(industry) {
  const s = industry || 'Other';
  for (const [re, key, tint] of SECTOR_TINTS) if (re.test(s)) return { key, tint };
  return { key: 'Other', tint: 0xe2dcd6 };
}

/** hex count for one company's village — area ∝ √roles, readable cap */
export function footprintFor(roles) {
  return Math.min(9, 1 + Math.round(Math.sqrt(Math.max(0, roles - 1))));
}
/** square-root sizing: linear would make SF 49x a one-role center */
export function islandTarget(roles) {
  return clamp(Math.round(2.2 * Math.sqrt(roles)), 3, 40);
}

export function createGeoBoard({ mount, labelLayer, data, onSelect, theme = 'day', sectorStyle = 'tint', autorotate = true, labelBudget = 15 }) {
  const state = {
    theme, sectorStyle: SECTOR_STYLES[sectorStyle] ? sectorStyle : 'tint',
    dateIndex: data.dates.length - 1,
    selected: null,           // { type:'company'|'island', id }
    touched: false, idle: performance.now(),
    fnFilter: null,           // function keys (multi-select) — desaturate everything that hires none of them
    hqLines: false,           // water-island panel: lines from stations to each company's HQ
  };

  const byName = new Map();
  data.companies.forEach((c) => { c.sector = sectorOf(c.industries && c.industries[0]); byName.set(c.name, c); });

  // ------------------------------------------------------------------ islands
  const islands = data.centers.map((center) => {
    const target = islandTarget(center.roles);
    const isWater = !!center.water;
    const island = { ...center, target, isWater, villages: [], cells: [], vessels: [] };

    if (isWater) {
      island.r = SPACING * Math.sqrt(target / 2.4) + 1.1;
      return island;
    }

    // per-company footprint: coarse curve, scaled up toward the island's sqrt target
    const base = center.companies.map((c) => footprintFor(c.roles));
    const sum = base.reduce((a, b) => a + b, 0) || 1;
    const f = clamp(target / sum, 1, 2.2);
    const wants = center.companies.map((c, i) => clamp(Math.round(base[i] * f), 1, Math.min(16, Math.max(1, Math.ceil(c.roles / 1.2)))));

    const grid = spiral(7);
    const key = (c) => c.q + ',' + c.r;
    const inGrid = new Map(grid.map((c) => [key(c), c]));
    const taken = new Map();

    center.companies.forEach((entry, ci) => {
      const n = wants[ci];
      const seed = grid.find((c) => !taken.has(key(c)));
      if (!seed) return;
      const group = [seed]; taken.set(key(seed), entry.name);
      while (group.length < n) {
        let best = null, bestScore = Infinity;
        for (const g of group) for (const [dq, dr] of NBR) {
          const nb = { q: g.q + dq, r: g.r + dr }, k = key(nb);
          if (taken.has(k) || !inGrid.has(k)) continue;
          const score = ringOf(nb) * 10 + rand(nb.q * 7.1 + nb.r * 3.3 + ci) * 3;
          if (score < bestScore) { bestScore = score; best = nb; }
        }
        if (!best) break;
        taken.set(key(best), entry.name); group.push(best);
      }
      island.villages.push({ co: byName.get(entry.name), name: entry.name, roles: entry.roles, cells: group, tiles: [], island });
    });

    // pad with unowned land up to the sqrt target, then a rim so villages aren't flush to water
    const owned = new Set(taken.keys());
    const filler = [];
    const adjacentFree = () => {
      const out = [];
      for (const c of grid) {
        if (taken.has(key(c))) continue;
        if (NBR.some(([dq, dr]) => taken.has((c.q + dq) + ',' + (c.r + dr)))) out.push(c);
      }
      return out.sort((a, b) => ringOf(a) - ringOf(b) || rand(a.q * 4.3 + a.r * 2.1) - rand(b.q * 4.3 + b.r * 2.1));
    };
    while (owned.size + filler.length < target) {
      const cand = adjacentFree()[0];
      if (!cand) break;
      taken.set(key(cand), '__filler'); filler.push(cand);
    }
    const rim = adjacentFree();
    rim.forEach((c) => taken.set(key(c), '__rim'));

    island.cells = [
      ...island.villages.flatMap((v) => v.cells.map((c) => ({ ...c, kind: 'village', village: v }))),
      ...filler.map((c) => ({ ...c, kind: 'filler' })),
      ...rim.map((c) => ({ ...c, kind: 'rim' })),
    ];
    const local = island.cells.map((c) => hexPos(c.q, c.r));
    const cx = (Math.min(...local.map((p) => p.x)) + Math.max(...local.map((p) => p.x))) / 2;
    const cz = (Math.min(...local.map((p) => p.z)) + Math.max(...local.map((p) => p.z))) / 2;
    island.local = { cx, cz };
    island.r = Math.max(...local.map((p) => Math.hypot(p.x - cx, p.z - cz))) + 1.0;
    return island;
  });

  // ------------------------------------------------------- projection + relax
  const PROJ_X = 0.38, PROJ_Z = 1.35;    // longitude compressed, latitude exaggerated
  const raw = islands.map((is) => ({ x: is.lng * PROJ_X, z: -is.lat * PROJ_Z }));
  let k = 1;
  const needs = [];
  for (let i = 0; i < islands.length; i++) for (let j = i + 1; j < islands.length; j++) {
    const d = Math.hypot(raw[i].x - raw[j].x, raw[i].z - raw[j].z) || 0.001;
    needs.push((islands[i].r + islands[j].r + GAP) / d);
  }
  needs.sort((a, b) => a - b);
  // start tight: most pairs overlap, and relaxation opens each one to exactly GAP,
  // which packs Tecland densely while keeping the geographic order
  k = clamp(needs[Math.floor(needs.length * 0.12)] || 1, 0.5, 5);

  const pos = raw.map((p) => ({ x: p.x * k, z: p.z * k }));
  const home = pos.map((p) => ({ ...p }));
  for (let it = 0; it < 500; it++) {
    for (let i = 0; i < pos.length; i++) for (let j = i + 1; j < pos.length; j++) {
      let dx = pos[j].x - pos[i].x, dz = pos[j].z - pos[i].z;
      let d = Math.hypot(dx, dz) || 0.001;
      const want = islands[i].r + islands[j].r + GAP;
      if (d < want) {
        const push = ((want - d) / d) * 0.5 * 0.7;
        dx *= push; dz *= push;
        pos[i].x -= dx; pos[i].z -= dz; pos[j].x += dx; pos[j].z += dz;
      }
    }
    for (let i = 0; i < pos.length; i++) {     // weak spring home keeps the geography
      pos[i].x += (home[i].x - pos[i].x) * 0.02;
      pos[i].z += (home[i].z - pos[i].z) * 0.02;
    }
  }
  const bx = (Math.min(...pos.map((p) => p.x)) + Math.max(...pos.map((p) => p.x))) / 2;
  const bz = (Math.min(...pos.map((p) => p.z)) + Math.max(...pos.map((p) => p.z))) / 2;
  islands.forEach((is, i) => { is.pos = { x: pos[i].x - bx, z: pos[i].z - bz }; });
  const geo2world = (lat, lng) => ({ x: lng * PROJ_X * k - bx, z: -lat * PROJ_Z * k - bz });

  const worldPos = (is, c) => ({ x: is.pos.x + hexPos(c.q, c.r).x - is.local.cx, z: is.pos.z + hexPos(c.q, c.r).z - is.local.cz });
  const allPts = [];
  islands.forEach((is) => {
    if (is.isWater) { allPts.push({ x: is.pos.x, z: is.pos.z }); return; }
    is.cells.forEach((c) => { const p = worldPos(is, c); c.world = p; allPts.push(p); });
  });
  const extent = Math.max(...allPts.map((p) => Math.hypot(p.x, p.z))) + 6;

  // ------------------------------------------------------------------- scene
  const W0 = mount.clientWidth || 1200, H0 = mount.clientHeight || 700;
  const scene = new THREE.Scene();
  const cam = new THREE.PerspectiveCamera(38, W0 / H0, 0.5, 1200);
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(W0, H0);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  mount.appendChild(renderer.domElement);

  const hemi = new THREE.HemisphereLight(0xffffff, 0xd8c8c2, 0.75); scene.add(hemi);
  const keyLight = new THREE.DirectionalLight(0xffffff, 2.1);
  keyLight.position.set(-extent * 0.5, extent * 1.1, extent * 0.42);
  keyLight.castShadow = true;
  const sh = extent * 1.05;
  Object.assign(keyLight.shadow.camera, { left: -sh, right: sh, top: sh, bottom: -sh, near: 1, far: extent * 4 });
  keyLight.shadow.mapSize.set(2048, 2048); keyLight.shadow.bias = -0.0012;
  scene.add(keyLight);
  const fillLight = new THREE.DirectionalLight(0xffffff, 0.35);
  fillLight.position.set(extent * 0.5, extent * 0.4, -extent * 0.55); scene.add(fillLight);

  const sea = new THREE.Mesh(new THREE.CircleGeometry(extent * 3.2, 96), new THREE.MeshLambertMaterial({ color: THEME.day.sea }));
  sea.rotation.x = -Math.PI / 2; sea.position.y = SEA_Y; sea.receiveShadow = true; scene.add(sea);

  /** faint graticule so the arrangement reads as a world, not a random scatter */
  const gridMat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.34, depthWrite: false });
  const gridPts = [];
  for (let lng = -180; lng <= 180; lng += 20) {
    const a = geo2world(-10, lng), b = geo2world(70, lng);
    if (Math.abs(a.x) > extent * 1.35) continue;
    gridPts.push(a.x, SEA_Y + 0.01, a.z, b.x, SEA_Y + 0.01, b.z);
  }
  for (let lat = -10; lat <= 70; lat += 15) {
    const a = geo2world(lat, -180), b = geo2world(lat, 180);
    if (Math.abs(a.z) > extent * 1.35) continue;
    gridPts.push(clamp(a.x, -extent * 1.3, extent * 1.3), SEA_Y + 0.01, a.z, clamp(b.x, -extent * 1.3, extent * 1.3), SEA_Y + 0.01, b.z);
  }
  const gridGeo = new THREE.BufferGeometry();
  gridGeo.setAttribute('position', new THREE.Float32BufferAttribute(gridPts, 3));
  const graticule = new THREE.LineSegments(gridGeo, gridMat); scene.add(graticule);

  const geoCol = new THREE.CylinderGeometry(0.98, 0.98, 1, 6, 1);
  const geoCap = new THREE.CylinderGeometry(0.94, 0.98, 1, 6, 1);
  const tiles = new THREE.Group(); scene.add(tiles);
  const props = new THREE.Group(); scene.add(props);
  const builds = new THREE.Group(); scene.add(builds);
  const arcs = new THREE.Group(); scene.add(arcs);
  const hqLines = new THREE.Group(); scene.add(hqLines);   // remote view: station → land HQ
  const features = new THREE.Group(); scene.add(features);   // sector landforms, built once
  const tileRecs = [], pickables = [], vessels = [];

  /** cap color: sector tint pulled toward the common grass, by whatever the style says */
  function tintFor(co, cell) {
    if (!co) return cell.kind === 'rim' ? 0xd7dfae : 0xcdd995;
    const style = SECTOR_STYLES[state.sectorStyle];
    return style.features
      ? sectorTint(THREE, co.sector.key, style.grassMix)
      : new THREE.Color(co.sector.tint).lerp(new THREE.Color(GRASS), style.grassMix).getHex();
  }

  function makeTile(is, cell) {
    const p = cell.world;
    const hazy = is.precision !== 'city' && cell.kind === 'rim';
    const co = cell.village ? cell.village.co : null;
    const h = cell.kind === 'village' ? LAND_H : hazy ? HAZY_H : cell.kind === 'rim' ? RIM_H : LAND_H;
    const side = new THREE.Mesh(geoCol, new THREE.MeshLambertMaterial({ color: THEME.day.side, flatShading: true }));
    side.scale.set(1, h, 1); side.position.set(p.x, h / 2, p.z);
    side.castShadow = side.receiveShadow = true;
    const baseTint = tintFor(co, cell);
    const cap = new THREE.Mesh(geoCap, new THREE.MeshLambertMaterial({ color: baseTint, flatShading: true }));
    cap.scale.set(1, 0.14, 1); cap.position.set(p.x, h + 0.07, p.z);
    cap.castShadow = cap.receiveShadow = true;
    tiles.add(side, cap);
    const rec = { cell, island: is, village: cell.village || null, co, side, cap, h, target: h, baseTint, pos: p };
    tileRecs.push(rec);
    cap.userData = side.userData = { co, island: is };
    pickables.push(cap, side);
    if (cell.village) cell.village.tiles.push(rec);
    return rec;
  }

  function scatterProp(is, cell, i) {
    const r = rand(cell.q * 3.1 + cell.r * 7.7 + is.pos.x);
    if (r > 0.42) return;
    const p = cell.world, g = new THREE.Group();
    const y = cell.kind === 'rim' ? (is.precision !== 'city' ? HAZY_H : RIM_H) : LAND_H;
    if (r < 0.2) {
      const rock = new THREE.Mesh(new THREE.IcosahedronGeometry(0.16 + r, 0), new THREE.MeshLambertMaterial({ color: 0xb9aaa4, flatShading: true }));
      rock.position.y = 0.12; rock.rotation.set(r * 3, r * 5, r * 2); g.add(rock);
    } else {
      const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.06, 0.22, 6), new THREE.MeshLambertMaterial({ color: 0xa98d80, flatShading: true }));
      trunk.position.y = 0.11;
      const crown = new THREE.Mesh(new THREE.ConeGeometry(0.24, 0.5, 6), new THREE.MeshLambertMaterial({ color: 0x8fb56a, flatShading: true }));
      crown.position.y = 0.46; g.add(trunk, crown);
    }
    g.traverse((o) => { o.castShadow = o.receiveShadow = true; });
    g.position.set(p.x + (r - 0.3) * 0.5, y + 0.14, p.z + (rand(i * 2.3) - 0.5) * 0.5);
    props.add(g);
  }

  /** one building per function; form encodes the function, size encodes role count */
  function buildingFor(fn, roles, seed) {
    const t = THEME[state.theme];
    const wall = new THREE.MeshLambertMaterial({ color: t.wall, flatShading: true });
    const roof = new THREE.MeshLambertMaterial({ color: new THREE.Color(FUNCTION_COLORS[fn] || FUNCTION_COLORS.other), flatShading: true });
    // n = role count in this function: width + height encode it; height steepens
    // so tall reads as many roles — the count later drives structure evolution
    const n = Math.min(roles, 16), s = 0.28 + n * 0.026, hh = 0.24 + n * 0.045, g = new THREE.Group();
    const box = (w, ht, d, y = 0) => { const m = new THREE.Mesh(new THREE.BoxGeometry(w, ht, d), wall); m.position.y = y + ht / 2; g.add(m); return m; };
    if (fn === 'research') {
      box(s * 0.62, hh * 2.1, s * 0.62);
      const cone = new THREE.Mesh(new THREE.ConeGeometry(s * 0.52, hh * 0.8, 6), roof);
      cone.position.y = hh * 2.5; g.add(cone);
    } else if (fn === 'marketing') {
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, hh * 2, 5), wall);
      pole.position.y = hh; g.add(pole);
      const flag = new THREE.Mesh(new THREE.PlaneGeometry(s * 0.9, hh * 0.6), roof);
      flag.material.side = THREE.DoubleSide; flag.position.set(s * 0.45, hh * 1.6, 0); g.add(flag);
    } else if (fn === 'sales') {
      box(s, hh * 0.7, s * 0.8);
      const awn = new THREE.Mesh(new THREE.BoxGeometry(s * 1.25, 0.05, s * 0.7), roof);
      awn.position.set(0, hh * 0.78, s * 0.42); awn.rotation.x = -0.35; g.add(awn);
    } else if (fn === 'operations') {
      box(s * 1.35, hh * 0.8, s * 0.75);
      const r2 = new THREE.Mesh(new THREE.BoxGeometry(s * 1.45, 0.09, s * 0.85), roof);
      r2.position.y = hh * 0.85; g.add(r2);
    } else if (fn === 'product') {
      box(s * 1.1, hh, s * 0.95);
      const r3 = new THREE.Mesh(new THREE.ConeGeometry(s * 0.92, hh * 0.5, 4), roof);
      r3.rotation.y = Math.PI / 4; r3.position.y = hh * 1.25; g.add(r3);
    } else {
      box(s, hh, s * 0.85);
      const r4 = new THREE.Mesh(new THREE.ConeGeometry(s * 0.86, hh * 0.62, 4), roof);
      r4.rotation.y = Math.PI / 4; r4.position.y = hh * 1.31; g.add(r4);
    }
    g.traverse((o) => { o.castShadow = o.receiveShadow = true; });
    g.rotation.y = (rand(seed) - 0.5) * 0.7;
    return g;
  }

  const flagColorOf = (co) => {
    const top = Object.entries(co.jobs_by_fn || {}).sort((a, b) => b[1] - a[1])[0];
    return new THREE.Color(FUNCTION_COLORS[top ? top[0] : 'other'] || FUNCTION_COLORS.other);
  };

  /** the village flies the company's flag — identical on every island it appears on */
  function makeFlag(village) {
    const rec = village.tiles.slice().sort((a, b) => b.h - a.h)[0];
    if (!rec) return;
    const col = flagColorOf(village.co);
    const g = new THREE.Group();
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 0.78, 5), new THREE.MeshLambertMaterial({ color: 0xf3ece4, flatShading: true }));
    pole.position.y = 0.39;
    const flag = new THREE.Mesh(new THREE.PlaneGeometry(0.34, 0.2), new THREE.MeshLambertMaterial({ color: col, flatShading: true, side: THREE.DoubleSide }));
    flag.position.set(0.17, 0.66, 0);
    g.add(pole, flag);
    g.traverse((o) => { o.castShadow = o.receiveShadow = true; o.userData = { co: village.co, island: village.island }; });
    g.position.set(rec.pos.x + 0.5, rec.h + 0.14, rec.pos.z - 0.44);
    props.add(g);
    pickables.push(flag, pole);
    village.flag = { g, rec, parts: [flag, pole] };
  }

  /** water centers: rigs for the bigger tenants, ships for the smallest */
  function makeFlotilla(is) {
    const n = is.companies.length;
    is.companies.forEach((entry, i) => {
      const co = byName.get(entry.name);
      const ang = (i / Math.max(1, n)) * Math.PI * 2 + rand(i * 5.1) * 0.6;
      const rad = n === 1 ? 0 : is.r * 0.55 * (0.55 + rand(i * 2.7) * 0.6);
      const p = { x: is.pos.x + Math.cos(ang) * rad, z: is.pos.z + Math.sin(ang) * rad };
      const col = flagColorOf(co);
      const steel = new THREE.MeshLambertMaterial({ color: 0x8d8f98, flatShading: true });
      const hullM = new THREE.MeshLambertMaterial({ color: 0x4a5560, flatShading: true });
      const deckM = new THREE.MeshLambertMaterial({ color: new THREE.Color(co.sector.tint), flatShading: true });
      const g = new THREE.Group();
      const parts = [];
      const isRig = entry.roles > 2;
      if (isRig) {
        const deck = new THREE.Mesh(geoCap, deckM);
        deck.scale.set(0.72, 0.16, 0.72); deck.position.y = DECK_H - SEA_Y;
        const legs = new THREE.Group();
        [[0.4, 0.4], [-0.4, 0.4], [0.4, -0.4], [-0.4, -0.4]].forEach(([dx, dz]) => {
          const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, DECK_H, 5), steel);
          leg.position.set(dx, (DECK_H - SEA_Y) / 2, dz); legs.add(leg);
        });
        const crane = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.6, 5), steel);
        crane.position.set(0.46, DECK_H + 0.24, -0.42); crane.rotation.z = 0.28;
        const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.6, 5), steel);
        mast.position.set(-0.2, DECK_H + 0.24, 0.2);
        const flag = new THREE.Mesh(new THREE.PlaneGeometry(0.3, 0.18), new THREE.MeshLambertMaterial({ color: col, flatShading: true, side: THREE.DoubleSide }));
        flag.position.set(-0.05, DECK_H + 0.46, 0.2);
        g.add(deck, legs, crane, mast, flag);
        parts.push(deck, crane, mast, flag);
      } else {
        const hull = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.2, 0.42), hullM); hull.position.y = 0.1;
        const prow = new THREE.Mesh(new THREE.ConeGeometry(0.21, 0.36, 4), hullM);
        prow.rotation.set(0, Math.PI / 4, -Math.PI / 2); prow.position.set(0.6, 0.1, 0);
        const deck = new THREE.Mesh(new THREE.BoxGeometry(0.76, 0.06, 0.32), deckM); deck.position.y = 0.22;
        const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.62, 5), deckM); mast.position.set(-0.12, 0.54, 0);
        const sail = new THREE.Mesh(new THREE.PlaneGeometry(0.4, 0.4), new THREE.MeshLambertMaterial({ color: col, flatShading: true, side: THREE.DoubleSide }));
        sail.position.set(0.06, 0.56, 0);
        g.add(hull, prow, deck, mast, sail);
        parts.push(hull, prow, deck, mast, sail);
      }
      g.traverse((o) => { o.castShadow = o.receiveShadow = true; o.userData = { co, island: is }; });
      g.position.set(p.x, SEA_Y, p.z);
      g.rotation.y = rand(i * 8.3) * Math.PI * 2;
      props.add(g);
      parts.forEach((m) => pickables.push(m));
      const v = { co, island: is, roles: entry.roles, g, parts, base: { x: p.x, z: p.z, y: SEA_Y, rot: g.rotation.y }, phase: rand(i * 9.1) * Math.PI * 2, isRig };
      vessels.push(v); is.vessels.push(v);
      (co.stations = co.stations || []).push(v);
    });
  }

  islands.forEach((is) => {
    if (is.isWater) { makeFlotilla(is); return; }
    is.cells.forEach((c) => makeTile(is, c));
    is.cells.filter((c) => c.kind !== 'village').forEach((c, i) => scatterProp(is, c, i));
    is.villages.forEach((v) => { if (v.cells.length >= 2) makeFlag(v); });
  });

  // company → every place it holds land or water
  data.companies.forEach((co) => {
    co.villages = islands.flatMap((is) => is.villages.filter((v) => v.name === co.name));
    co.locatedRoles = co.villages.reduce((a, v) => a + v.roles, 0) + (co.stations || []).reduce((a, v) => a + v.roles, 0);
    co.villages.forEach((v) => { v.share = v.roles / Math.max(1, co.locatedRoles); });
  });

  // sector landforms, built once: buildings only ever occupy a village's first two tiles
  // (4 functions x 3 slots), so tiles from index 2 on are free ground.
  islands.forEach((is) => is.villages.forEach((v) => {
    if (!v.co) return;
    v.tiles.slice(2).forEach((rec) => {
      const f = makeSectorFeature(THREE, v.co.sector.key, rec.cell.q * 7.1 + rec.cell.r * 3.3);
      f.position.set(rec.pos.x, rec.h + 0.14, rec.pos.z);
      features.add(f);
      (v.features = v.features || []).push({ g: f, rec });
    });
  }));
  features.visible = SECTOR_STYLES[state.sectorStyle].features;

  // ------------------------------------------------------------------ camera
  const controls = new OrbitControls(cam, renderer.domElement);
  controls.enableDamping = true; controls.dampingFactor = 0.08;
  controls.minPolarAngle = 0.15; controls.maxPolarAngle = Math.PI / 2 - 0.08;
  controls.minDistance = 6; controls.maxDistance = extent * 6;
  controls.autoRotateSpeed = 0.35;
  controls.addEventListener('start', () => { state.touched = true; state.idle = performance.now(); controls.autoRotate = false; });
  controls.addEventListener('end', () => { state.idle = performance.now(); });

  const DIR = new THREE.Vector3(0.42, 0.66, 0.62).normalize();
  let camTarget = null, camPos = null;

  function projBox(pts) {
    const W = mount.clientWidth, H = mount.clientHeight, v = new THREE.Vector3();
    let x1 = Infinity, x2 = -Infinity, y1 = Infinity, y2 = -Infinity;
    pts.forEach((p) => {
      v.set(p.x, 0.7, p.z).project(cam);
      const sx = (v.x * 0.5 + 0.5) * W, sy = (-v.y * 0.5 + 0.5) * H;
      x1 = Math.min(x1, sx); x2 = Math.max(x2, sx); y1 = Math.min(y1, sy); y2 = Math.max(y2, sy);
    });
    return { x1, x2, y1, y2, W, H };
  }

  /**
   * A flat board under a pitched camera projects to a trapezoid, so the world-space
   * centre is NOT the screen centre: solve numerically — 8 damped passes.
   */
  function fit(pts, instant, pad = 0.94) {
    if (!pts.length) return;
    const fovV = (cam.fov * Math.PI) / 180;
    const u = new THREE.Vector3(DIR.x, 0, DIR.z).normalize();
    const w = new THREE.Vector3(-u.z, 0, u.x);
    let u1 = Infinity, u2 = -Infinity, w1 = Infinity, w2 = -Infinity;
    pts.forEach((p) => {
      const du = p.x * u.x + p.z * u.z, dw = p.x * w.x + p.z * w.z;
      u1 = Math.min(u1, du); u2 = Math.max(u2, du); w1 = Math.min(w1, dw); w2 = Math.max(w2, dw);
    });
    const cu = (u1 + u2) / 2, cw = (w1 + w2) / 2;
    const target = new THREE.Vector3(u.x * cu + w.x * cw, 0.7, u.z * cu + w.z * cw);
    const rad = Math.max(...pts.map((p) => Math.hypot(p.x - target.x, p.z - target.z))) + 2;
    let d = (rad / Math.tan(fovV / 2)) * 1.1;
    const savedPos = cam.position.clone(), savedTgt = controls.target.clone();
    for (let it = 0; it < 8; it++) {
      cam.position.copy(target).add(DIR.clone().multiplyScalar(d));
      cam.lookAt(target); cam.updateMatrixWorld(true);
      const b = projBox(pts);
      const s = Math.max((b.x2 - b.x1) / (b.W * pad), (b.y2 - b.y1) / (b.H * (pad - 0.06)));
      if (!isFinite(s) || s <= 0) break;
      d *= 0.4 + 0.6 * s;
      const fovH = 2 * Math.atan(Math.tan(fovV / 2) * cam.aspect);
      const oy = ((b.y1 + b.y2) / 2 - b.H / 2) / b.H, ox = ((b.x1 + b.x2) / 2 - b.W / 2) / b.W;
      target.addScaledVector(new THREE.Vector3(-u.x, 0, -u.z), -oy * 2 * d * Math.tan(fovV / 2) * 0.45);
      target.addScaledVector(w, -ox * 2 * d * Math.tan(fovH / 2) * 0.45);
    }
    if (instant) {
      controls.target.copy(target);
      cam.position.copy(target).add(DIR.clone().multiplyScalar(d));
      controls.update();
    } else {
      cam.position.copy(savedPos); controls.target.copy(savedTgt); cam.lookAt(savedTgt);
      camTarget = target.clone();
      camPos = target.clone().add(DIR.clone().multiplyScalar(d));   // solve and destination share one direction
    }
  }

  const PRESETS = {
    world: () => islands,
    na: () => islands.filter((is) => is.lng < -50),
    eu: () => islands.filter((is) => is.lng >= -20 && is.lng < 45),
    asia: () => islands.filter((is) => is.lng >= 45),
  };
  const ptsOf = (list) => list.flatMap((is) => (is.isWater
    ? [{ x: is.pos.x - is.r, z: is.pos.z - is.r }, { x: is.pos.x + is.r, z: is.pos.z + is.r }]
    : is.cells.map((c) => c.world)));

  fit(ptsOf(islands), true);

  // ---------------------------------------------------------- data → board
  function snapAt(co, di) {
    const dt = data.dates[di];
    let cur = null, prev = null;
    for (const h of co.history) if (h.date <= dt) { prev = cur; cur = h; }
    if (!cur) return { founded: false, total: 0, delta: 0, fns: {} };
    return { founded: true, total: cur.smoothed, raw: cur.total_jobs, delta: prev ? cur.smoothed - prev.smoothed : 0, fns: cur.jobs_by_fn || {}, date: cur.date };
  }

  /** locations exist only at the latest scan, so a village's mix is its share of the company's.
   *  Each [fn, count] is the role count in that function at the scrubber date × village
   *  share — the number buildingFor scales from, and later structure evolution keys on. */
  function villageFns(village, snap) {
    const out = [];
    Object.entries(snap.fns || {}).forEach(([fn, n]) => {
      const scaled = n * village.share;
      if (scaled >= 0.5) out.push([fn, Math.max(1, Math.round(scaled))]);
    });
    if (!out.length) {
      const top = Object.entries(snap.fns || {}).sort((a, b) => b[1] - a[1])[0];
      if (top) out.push([top[0], 1]);
    }
    return out.sort((a, b) => b[1] - a[1]).slice(0, 4);
  }

  function applyDate() {
    const di = state.dateIndex;
    builds.clear();
    data.companies.forEach((co, ci) => {
      const sn = snapAt(co, di);
      co.snap = sn;
      const m = clamp(sn.delta / co.maxAbsDelta, -1, 1);
      const h = sn.founded ? LAND_H + (m > 0 ? m * HEIGHT_SWING : m * VALLEY_SWING) : LAND_H - 0.14;
      co.villages.forEach((v, vi) => {
        v.tiles.forEach((rec) => { rec.target = Math.max(0.42, h); });
        v.height = Math.max(0.42, h);
        if (!sn.founded) return;
        const slots = [];
        v.tiles.forEach((rec) => {
          const p = rec.pos;
          slots.push({ p, off: [0, 0] }, { p, off: [0.42, 0.34] }, { p, off: [-0.4, -0.3] });
        });
        villageFns(v, sn).forEach(([fn, count], kk) => {
          const slot = slots[kk % slots.length];
          const g = buildingFor(fn, count, ci * 13 + vi * 7.7 + kk * 5.3);
          g.position.set(slot.p.x + slot.off[0], v.height + 0.14, slot.p.z + slot.off[1]);
          g.userData = { co, island: v.island, village: v };
          builds.add(g);
        });
      });
      (co.stations || []).forEach((v, vi) => {
        v.deckLift = sn.founded ? m * 0.12 : -0.06;
        if (!sn.founded) return;
        const top = Object.entries(sn.fns || {}).sort((a, b) => b[1] - a[1])[0];
        if (!top) return;
        const g = buildingFor(top[0], Math.max(1, Math.round(v.roles)), ci * 5.1 + vi * 3.3);
        g.scale.setScalar(0.6);
        g.userData = { co, island: v.island, station: v };
        builds.add(g);
      });
    });
    if (state.selected) highlight();
    if (state.fnFilter) applyFnDim();   // rebuilds reset colors — re-apply the dim
    if (state.hqLines) syncHqLines();   // village heights changed — re-anchor the tubes
  }

  function applyTheme() {
    const t = THEME[state.theme];
    scene.background = new THREE.Color(t.bg);
    hemi.color.setHex(t.hemi); hemi.groundColor.setHex(t.hemiGround); hemi.intensity = t.hemiI;
    keyLight.color.setHex(t.key); keyLight.intensity = t.keyI; fillLight.intensity = t.fillI;
    sea.material.color.setHex(t.sea);
    gridMat.color.setHex(t.grid); gridMat.opacity = t.gridOpacity;
    tileRecs.forEach((rec) => {
      const c = new THREE.Color(rec.baseTint);
      // night frosts the caps; with terrain on, village caps keep more of their sector
      if (t.capMix) c.lerp(new THREE.Color(t.capMix.color), t.capMix.amount * (rec.co ? SECTOR_STYLES[state.sectorStyle].nightCapMix : 1));
      // themed base is what the fn-filter restores to before dimming. Stored on
      // the MATERIALS' own userData — cap and side share one mesh userData
      // (pick hits), so per-part keys there would collide.
      const cm = rec.cap.material, sm = rec.side.material;
      if (!cm.userData) cm.userData = {};
      if (!sm.userData) sm.userData = {};
      cm.userData.baseColor = c.clone();
      sm.userData.baseColor = new THREE.Color(t.side);
      cm.color.copy(c);
      sm.color.setHex(t.side);
    });
    applyDate();
  }

  // --------------------------------------------------------------- selection
  function clearArcs() {
    arcs.clear();
  }

  /** arc tube between two anchor points — quadratic lift proportional to span */
  function tubeBetween(a, b, mat) {
    const d = Math.hypot(b.x - a.x, b.z - a.z);
    const mid = new THREE.Vector3((a.x + b.x) / 2, Math.max(a.y, b.y) + d * 0.24 + 1.2, (a.z + b.z) / 2);
    const curve = new THREE.QuadraticBezierCurve3(new THREE.Vector3(a.x, a.y, a.z), mid, new THREE.Vector3(b.x, b.y, b.z));
    return new THREE.Mesh(new THREE.TubeGeometry(curve, 44, 0.055, 6, false), mat);
  }

  /** the payoff of the format: one company, every island it touches, connected */
  function drawArcs(co) {
    clearArcs();
    const nodes = [
      ...co.villages.map((v) => ({ x: v.tiles[0] ? v.tiles[0].pos.x : 0, z: v.tiles[0] ? v.tiles[0].pos.z : 0, y: (v.height || LAND_H) + 0.4, w: v.roles })),
      ...(co.stations || []).map((v) => ({ x: v.base.x, z: v.base.z, y: DECK_H + 0.3, w: v.roles })),
    ];
    if (nodes.length < 2) return;
    const hub = nodes.slice().sort((a, b) => b.w - a.w)[0];
    const mat = new THREE.MeshBasicMaterial({ color: SELECT_GLOW, transparent: true, opacity: 0.75 });
    nodes.forEach((n) => {
      if (n === hub) return;
      arcs.add(tubeBetween(n, hub, mat));
    });
  }

  /** remote-roles view: from each of this water center's stations to its company's
   *  HQ — the biggest land village. Remote-first companies have no land: skipped.
   *  Tubes are teal (water-teal, operations tint) to read apart from selection arcs. */
  function drawHqLines(is) {
    clearHqLines();
    if (!is || !is.isWater) return;
    is.companies.forEach((entry) => {
      const co = entry.co;
      if (co.remote_policy === 'remote') return;
      const hq = (co.villages || []).slice().sort((a, b) => b.roles - a.roles)[0];
      if (!hq || !hq.tiles[0]) return;
      const mat = new THREE.MeshBasicMaterial({ color: 0x33b0a6, transparent: true, opacity: 0.7 });
      const hqPos = { x: hq.tiles[0].pos.x, z: hq.tiles[0].pos.z, y: (hq.height || LAND_H) + 0.4 };
      (co.stations || []).forEach((v) => {
        if (v.island !== is) return;
        const t = tubeBetween({ x: v.base.x, z: v.base.z, y: DECK_H + 0.3 }, hqPos, mat);
        t.userData = { co, hq: true };
        hqLines.add(t);
      });
    });
  }
  function clearHqLines() {
    hqLines.clear();
  }

  /** keep hq lines true to the current selection + fn filter */
  function syncHqLines() {
    if (!state.hqLines) { clearHqLines(); return; }
    const sel = state.selected;
    const isNow = sel && sel.type === 'island' ? islands.find((i) => i.id === sel.id) : null;
    if (isNow && isNow.isWater) {
      drawHqLines(isNow);
      dimHqLines();   // fresh tubes must respect an active fn filter
    } else clearHqLines();
  }
  /** restore then dim the tubes whose company doesn't hire the filtered function */
  function dimHqLines() {
    const f = state.fnFilter;
    hqLines.children.forEach((m) => {
      restoreGroup(m);
      if (f && !(m.userData.co && fnMatch(m.userData.co))) desatGroup(m);
    });
  }

  function highlight() {
    const sel = state.selected;
    const selCo = sel && sel.type === 'company' ? byName.get(sel.id) : null;
    const selIs = sel && sel.type === 'island' ? islands.find((i) => i.id === sel.id) : null;
    tileRecs.forEach((rec) => {
      const on = (selCo && rec.co === selCo) || (selIs && rec.island === selIs && rec.cell.kind === 'village');
      const dim = selIs && rec.island === selIs && rec.cell.kind !== 'village';
      rec.cap.material.emissive.set(on ? SELECT_GLOW : 0x000000).multiplyScalar(on ? 0.42 : 0);
      rec.side.material.emissive.set(on || dim ? SELECT_GLOW : 0x000000).multiplyScalar(on ? 0.18 : dim ? 0.08 : 0);
    });
    data.companies.forEach((co) => {
      const on = co === selCo || (selIs && selIs.companies.some((c) => c.name === co.name));
      const strong = co === selCo;
      co.villages.forEach((v) => { if (v.flag) v.flag.parts.forEach((m) => m.material.emissive.set(on ? SELECT_GLOW : 0x000000).multiplyScalar(strong ? 0.34 : on ? 0.16 : 0)); });
      (co.stations || []).forEach((v) => v.parts.forEach((m) => m.material.emissive.set(on ? SELECT_GLOW : 0x000000).multiplyScalar(strong ? 0.34 : on ? 0.16 : 0)));
    });
    if (selCo) drawArcs(selCo); else clearArcs();
  }

  // -------------------------------------------------------------- fn filter
  /** does this company hire the filtered function at the current date? */
  function fnMatch(co) {
    const f = state.fnFilter;
    if (!f || !f.length) return true;
    const sn = co.snap || {};
    /* multi-toggle: company matches when it hires ANY selected function */
    return !!(sn.founded && f.some((k) => (sn.fns[k] || 0) > 0));
  }
  function islandHasFn(is) {
    return is.companies.some((e) => fnMatch(e.co));
  }
  /** luminance gray of a stored color — solo desaturates instead of darkening */
  const grayOf = (c) => c.r * 0.2126 + c.g * 0.7152 + c.b * 0.0722;
  const gray = (c) => { const l = grayOf(c); return new THREE.Color().setRGB(l, l, l); };
  const rememberBase = (g) => { if (!g) return; g.traverse((o) => { const m = o.material; if (!m) return; if (!m.userData) m.userData = {}; if (!m.userData.base) m.userData.base = m.color.clone(); }); };
  const restoreGroup = (g) => { rememberBase(g); if (!g) return; g.traverse((o) => { const m = o.material; if (m && m.userData.base) m.color.copy(m.userData.base); }); };
  const desatGroup = (g) => { if (!g) return; g.traverse((o) => { const m = o.material; if (m && m.userData.base) m.color.copy(gray(m.userData.base)); }); };

  /**
   * fn-filter state: restore every mesh to its themed base color, then
   * DESATURATE what the filter drops — companies that don't hire the function
   * and land around islands that have nothing to do with it. Matching cells
   * keep their exact color (full saturation); everything else goes gray at its
   * own luminance so map relief stays readable. Clearing the filter restores
   * every cell to its exact base color.
   */
  function applyFnDim() {
    const f = state.fnFilter;
    // restore (captures base the first time it runs)
    tileRecs.forEach((rec) => {
      const cu = rec.cap.material.userData, su = rec.side.material.userData;
      rec.cap.material.color.copy(cu.baseColor ? cu.baseColor : new THREE.Color(rec.baseTint));
      rec.side.material.color.copy(su.baseColor ? su.baseColor : new THREE.Color(THEME[state.theme].side));
    });
    builds.children.forEach((g) => { if (g.userData.co) restoreGroup(g); });
    data.companies.forEach((co) => {
      co.villages.forEach((v) => restoreGroup(v.flag ? v.flag.g : null));
      (co.stations || []).forEach((v) => restoreGroup(v.g));
    });
    hqLines.children.forEach((m) => restoreGroup(m));
    if (!f) return;
    tileRecs.forEach((rec) => {
      const drop = rec.co ? !fnMatch(rec.co) : !islandHasFn(rec.island);
      if (drop) {
        const cu = rec.cap.material.userData, su = rec.side.material.userData;
        rec.cap.material.color.copy(gray(cu.baseColor ? cu.baseColor : new THREE.Color(rec.baseTint)));
        rec.side.material.color.copy(gray(su.baseColor ? su.baseColor : new THREE.Color(THEME[state.theme].side)));
      }
    });
    builds.children.forEach((g) => { if (g.userData.co && !fnMatch(g.userData.co)) desatGroup(g); });
    data.companies.forEach((co) => {
      if (fnMatch(co)) return;
      co.villages.forEach((v) => desatGroup(v.flag ? v.flag.g : null));
      (co.stations || []).forEach((v) => desatGroup(v.g));
    });
    hqLines.children.forEach((m) => { if (!(m.userData.co && fnMatch(m.userData.co))) desatGroup(m); });
  }

  // ----------------------------------------------------------------- picking
  const ray = new THREE.Raycaster(), ptr = new THREE.Vector2();
  let down = null;
  function pick(e) {
    const r = renderer.domElement.getBoundingClientRect();
    ptr.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ptr, cam);
    for (const hit of ray.intersectObjects([...pickables, ...builds.children], true)) {
      let o = hit.object;
      while (o && !(o.userData && (o.userData.co || o.userData.island))) o = o.parent;
      if (o) return o.userData;
    }
    return null;
  }
  renderer.domElement.addEventListener('pointerdown', (e) => { down = [e.clientX, e.clientY]; });
  renderer.domElement.addEventListener('pointerup', (e) => {
    if (!down) return;
    const moved = Math.hypot(e.clientX - down[0], e.clientY - down[1]); down = null;
    if (moved > 5) return;
    const ud = pick(e);
    if (!ud) return api.select(null);
    if (ud.co) return api.select({ type: 'company', id: ud.co.name });
    /* region pick: same focus as the right-column list row — select + fly in.
       (company/village picks stay select-only; dblclick flies there instead) */
    api.select({ type: 'island', id: ud.island.id });
    api.flyTo(ud.island.id);
  });
  renderer.domElement.addEventListener('dblclick', (e) => {
    const ud = pick(e);
    if (!ud) return;
    if (ud.co) { api.select({ type: 'company', id: ud.co.name }); api.flyTo(ud.island.id); }
    else { api.select({ type: 'island', id: ud.island.id }); api.flyTo(ud.island.id); }
  });

  // ------------------------------------------------------------------ labels
  const mk = (cls) => { const el = document.createElement('div'); el.className = cls; labelLayer.appendChild(el); return el; };
  const islandEls = islands.map((is) => {
    const el = mk('geolabel island');
    el.style.pointerEvents = 'auto';
    el.style.cursor = 'pointer';
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      api.select({ type: 'island', id: is.id });
      api.flyTo(is.id);
    });
    return el;
  });
  const allVillages = islands.flatMap((is) => is.villages);
  const villageEls = allVillages.map(() => mk('geolabel village'));
  const isOfVg = new Map();
  islands.forEach((is) => is.villages.forEach((vg) => isOfVg.set(vg, is)));
  const mobM = window.matchMedia('(max-width: 900px)');

  function updateLabels() {
    const W = labelLayer.clientWidth, H = labelLayer.clientHeight;
    const night = state.theme === 'night';
    const sel = state.selected;
    /* mobile focus: when an area is focused, fade labels outside it so the
       focus reads on a small screen (desktop keeps the full map labelled) */
    let focusIsland = null;
    if (sel && sel.type === 'island') focusIsland = islands.find((is) => is.id === sel.id) || null;
    else if (sel && sel.type === 'company') focusIsland = islands.find((is) => is.villages.some((vg) => vg.name === sel.id)) || null;
    const dimOthers = mobM.matches && !!focusIsland;
    labelLayer.classList.toggle('focusdim', dimOthers);
    const v = new THREE.Vector3();
    const placed = [];
    const collide = (b) => placed.some((p) => !(b.x2 < p.x1 || b.x1 > p.x2 || b.y2 < p.y1 || b.y1 > p.y2));

    // islands are the primary reading level: they place first and always win
    const isItems = islands.map((is, i) => {
      const top = is.isWater ? DECK_H + 1.6 : LAND_H + is.r * 0.34 + 1.5;
      v.set(is.pos.x, top, is.pos.z).project(cam);
      return { i, is, x: (v.x * 0.5 + 0.5) * W, y: (-v.y * 0.5 + 0.5) * H, z: v.z };
    }).sort((a, b) => b.is.roles - a.is.roles);

    isItems.forEach((it, order) => {
      const el = islandEls[it.i];
      const on = sel && sel.type === 'island' && sel.id === it.is.id;
      const w = it.is.label.length * 7.4 + 52, h = 26;
      const box = { x1: it.x - w / 2, x2: it.x + w / 2, y1: it.y - h, y2: it.y };
      const fade = clamp((0.9995 - it.z) * 900, 0, 1);
      const show = fade > 0.05 && (on || order === 0 || !collide(box));
      if (show) placed.push(box);
      const cx = clamp(it.x, w / 2 + 6, W - w / 2 - 6);   // keep edge islands' pills on screen
      el.style.display = show ? 'flex' : 'none';
      el.style.transform = `translate(-50%,-100%) translate(${cx.toFixed(1)}px,${it.y.toFixed(1)}px)`;
      el.style.zIndex = 400;
      const fdim = state.fnFilter ? !islandHasFn(it.is) : false;
      el.style.opacity = fade * (fdim ? 0.32 : 1) * (dimOthers && it.is.id !== focusIsland.id ? 0.07 : 1);
      el.style.background = on ? '#fb5b60' : night ? 'rgba(20,27,36,0.86)' : 'rgba(255,255,255,0.92)';
      el.style.color = on ? '#ffffff' : night ? '#eaf3fb' : '#0d0d0d';
      el.style.borderColor = on ? '#fb5b60' : night ? 'rgba(234,243,251,0.22)' : '#f2d9d2';
      el.innerHTML = `<span style="font-family:Karla,sans-serif;font-weight:700;letter-spacing:0.01em">${it.is.label}</span>`
        + `<span style="font-family:Spectral,serif;font-weight:600;opacity:${on ? 1 : 0.55};margin-left:7px">${it.is.roles}</span>`
        + (it.is.precision === 'city' ? '' : `<span style="font-family:Karla,sans-serif;font-size:9px;opacity:0.5;margin-left:6px;letter-spacing:0.06em;text-transform:uppercase">${it.is.precision === 'policy' ? 'policy' : 'approx'}</span>`);
    });

    // then villages, biggest-first, colliding boxes dropped; selection always survives
    const vItems = allVillages.map((vg, i) => {
      const rec = vg.tiles[0];
      const p = rec ? rec.pos : { x: 0, z: 0 };
      v.set(p.x, (vg.height || LAND_H) + 0.55, p.z).project(cam);
      return { i, vg, x: (v.x * 0.5 + 0.5) * W, y: (-v.y * 0.5 + 0.5) * H, z: v.z };
    });
    vItems.slice().sort((a, b) => b.z - a.z).forEach((it, rank) => { it.rank = rank; });
    let budget = labelBudget;
    vItems.slice().sort((a, b) => {
      const as = sel && sel.type === 'company' && sel.id === a.vg.name, bs = sel && sel.type === 'company' && sel.id === b.vg.name;
      if (as !== bs) return as ? -1 : 1;
      return b.vg.roles - a.vg.roles;
    }).forEach((it) => {
      const isSel = sel && sel.type === 'company' && sel.id === it.vg.name;
      const w = Math.min(it.vg.name.length, 16) * 6.6 + 30, h = 20;
      const box = { x1: it.x - w / 2, x2: it.x + w / 2, y1: it.y - h, y2: it.y };
      it.show = isSel || (!collide(box) && budget > 0);
      if (it.show) { placed.push(box); if (!isSel) budget--; }
    });

    vItems.forEach((it) => {
      const el = villageEls[it.i], vg = it.vg, sn = vg.co.snap || {};
      const isSel = sel && sel.type === 'company' && sel.id === vg.name;
      const fdim = state.fnFilter ? !fnMatch(vg.co) : false;
      let fade = clamp((0.9995 - it.z) * 900, 0, 1);
      if (!it.show) fade = 0;
      el.style.display = fade < 0.05 ? 'none' : 'flex';
      el.style.transform = `translate(-50%,-100%) translate(${it.x.toFixed(1)}px,${it.y.toFixed(1)}px)`;
      el.style.zIndex = 100 + it.rank;
      const oDim = dimOthers && isOfVg.get(vg) !== focusIsland ? 0.07 : 1;
      el.style.opacity = (sn.founded ? 1 : 0.34) * (isSel || !fdim ? 1 : 0.28) * fade * oDim;
      el.style.fontSize = (isSel ? 12.5 : 11) + 'px';
      el.style.fontWeight = isSel ? 700 : 600;
      el.style.background = isSel ? '#fb5b60' : night ? 'rgba(20,27,36,0.7)' : 'rgba(255,242,238,0.86)';
      el.style.color = isSel ? '#fff' : night ? '#eaf3fb' : '#0d0d0d';
      el.style.borderColor = isSel ? '#fb5b60' : night ? 'rgba(234,243,251,0.16)' : 'rgba(13,13,13,0.10)';
      const nm = vg.name.length > 16 ? vg.name.slice(0, 15) + '…' : vg.name;
      const d = sn.delta > 0 ? ' ▲' + sn.delta : sn.delta < 0 ? ' ▼' + Math.abs(sn.delta) : '';
      el.innerHTML = `<span>${nm}</span><span style="opacity:0.62;margin-left:6px;font-family:Spectral,serif">${vg.roles}</span>`
        + (d ? `<span style="margin-left:5px;color:${isSel ? '#fff' : sn.delta > 0 ? '#5f9b1f' : '#fb5b60'}">${d}</span>` : '');
    });
  }

  // -------------------------------------------------------------------- loop
  let raf = 0;
  function tick() {
    raf = requestAnimationFrame(tick);
    if (autorotate && performance.now() - state.idle > 5000) controls.autoRotate = true;
    if (camTarget) {
      controls.target.lerp(camTarget, 0.07);
      if (camPos) cam.position.lerp(camPos, 0.07);
      if (controls.target.distanceTo(camTarget) < 0.02) { camTarget = null; camPos = null; }
    }
    controls.update();
    tileRecs.forEach((rec) => {
      if (Math.abs(rec.h - rec.target) > 0.002) {
        rec.h += (rec.target - rec.h) * 0.14;
        rec.side.scale.y = Math.max(rec.h, 0.05);
        rec.side.position.y = rec.h / 2;
        rec.cap.position.y = rec.h + 0.07;
      }
    });
    builds.children.forEach((g) => {
      const ud = g.userData;
      if (ud.village) g.position.y = (ud.village.tiles[0] ? ud.village.tiles[0].h : LAND_H) + 0.14;
    });

    const t = performance.now() / 1000;
    vessels.forEach((v) => {
      const ph = v.phase, sel = state.selected && state.selected.type === 'company' && state.selected.id === v.co.name;
      v.sail = clamp((v.sail || 0) + (sel ? 0.012 : -0.02), 0, 1);
      /* boats bob on their mooring point — selected companies rock a bit livelier */
      const amp = (v.isRig ? 0.015 : 0.06) * (0.6 + v.sail * 0.8);
      v.g.position.set(v.base.x, v.base.y + (v.deckLift || 0) + Math.sin(t * 1.6 + ph) * amp, v.base.z);
      v.g.rotation.y = v.base.rot + Math.sin(t * 0.5 + ph) * 0.06;
      v.g.rotation.z = Math.sin(t * 1.2 + ph) * (v.isRig ? 0.012 : 0.05);
      v.g.rotation.x = Math.sin(t * 0.9 + ph) * (v.isRig ? 0.008 : 0.03);
      const b = builds.children.find((c) => c.userData.station === v);
      if (b) { b.position.copy(v.g.position); b.position.y += v.isRig ? 0.5 : 0.3; }
    });
    allVillages.forEach((vg) => {
      (vg.features || []).forEach((f) => { f.g.position.y = f.rec.h + 0.14; });
      if (!vg.flag) return;
      vg.flag.g.position.y = vg.flag.rec.h + 0.14;
      vg.flag.parts[0].rotation.y = Math.sin(t * 1.4 + vg.flag.rec.pos.x) * 0.22;
    });
    if (arcs.children.length) arcs.children.forEach((m, i) => { m.material.opacity = 0.55 + Math.sin(t * 1.6 + i) * 0.2; });
    updateLabels();
    renderer.render(scene, cam);
  }

  const ro = new ResizeObserver(() => {
    const W = mount.clientWidth, H = mount.clientHeight;
    if (!W || !H) return;
    cam.aspect = W / H; cam.updateProjectionMatrix(); renderer.setSize(W, H);
    if (!state.touched) fit(ptsOf(islands), true);
  });
  ro.observe(mount);

  applyTheme();
  tick();

  const api = {
    islands, companies: data.companies, dates: data.dates, unplaced: data.unplaced,
    vessels,   // exposed for tests/scripts; chrome never touches it directly
    hqLines,   // exposed for tests/scripts; chrome never touches it directly
    camera: cam,   // exposed for tests/scripts; chrome never touches it directly
    get state() { return { ...state }; },
    snapshot: (name, di = state.dateIndex) => snapAt(byName.get(name), di),
    setDate(i) { state.dateIndex = clamp(i, 0, data.dates.length - 1); applyDate(); },
    setTheme(t) { state.theme = t === 'night' ? 'night' : 'day'; applyTheme(); },
    setSectorStyle(s) {
      state.sectorStyle = SECTOR_STYLES[s] ? s : 'tint';
      features.visible = SECTOR_STYLES[state.sectorStyle].features;
      tileRecs.forEach((rec) => { rec.baseTint = tintFor(rec.co, rec.cell); });
      applyTheme();
      if (state.fnFilter) applyFnDim();   // an active fn filter must survive a style switch
    },
    setGraticule(on) { graticule.visible = on !== false; },
    select(sel) {
      state.selected = sel && sel.id ? sel : null;
      highlight();
      if (state.fnFilter) applyFnDim();
      syncHqLines();   // water island keeps its lines, anything else clears them
      if (onSelect) onSelect(state.selected);
    },
    setHqLines(on) {
      state.hqLines = !!on;
      syncHqLines();
    },
    setFnFilter(f) {
      /* f = array of function keys (multi-select); empty/null clears */
      state.fnFilter = Array.isArray(f) && f.length ? f.slice() : null;
      if (state.selected) highlight();
      applyFnDim();
      dimHqLines();   // filter state changed — tubes must follow
      updateLabels();
    },
    flyTo(id) {
      const is = islands.find((i) => i.id === id);
      if (!is) return;
      state.touched = true; controls.autoRotate = false;
      fit(ptsOf([is]), false, 0.62);
    },
    preset(name) {
      const list = (PRESETS[name] || PRESETS.world)();
      state.touched = name !== 'world'; controls.autoRotate = false;
      fit(ptsOf(list.length ? list : islands), false, name === 'world' ? 0.94 : 0.8);
    },
    reset() { state.touched = false; controls.autoRotate = false; api.select(null); fit(ptsOf(islands), false); },
    destroy() {
      cancelAnimationFrame(raf); ro.disconnect(); controls.dispose(); renderer.dispose();
      renderer.domElement.remove(); [...islandEls, ...villageEls].forEach((e) => e.remove());
    },
  };
  return api;
}

if (typeof window !== 'undefined') {
  window.createGeoBoard = createGeoBoard;
  window.GeoBoardData = { normalizeBoardData, fetchBoardData, CENTERS };
  window.FUNCTION_COLORS = FUNCTION_COLORS;
  window.sectorOf = sectorOf;
  window.dispatchEvent(new Event('geoboard-ready'));
}
