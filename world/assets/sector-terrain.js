/**
 * sector-terrain.js — sector as landform, not just tint.
 *
 * Six sectors, six silhouettes: peaks, terraces, orchard, fields, conifers, scrub.
 * Silhouette carries the sector at any zoom and in a screenshot; the cap tint is the
 * second, confirming signal. Tints are deliberately more saturated than the original
 * pastels and the grass mix drops from 0.58 to 0.22, so neighbouring islands separate.
 *
 * Every feature is a three.js primitive group, deterministic from its seed, sized to
 * sit inside one hex (radius 0.98) with a height budget below the buildings.
 *
 * Usage:
 *   import { SECTOR_TERRAIN, makeSectorFeature, sectorTint } from './sector-terrain.js';
 *   const g = makeSectorFeature(THREE, co.sector.key, cell.q * 7.1 + cell.r * 3.3);
 *   g.position.set(cell.world.x, LAND_H + 0.14, cell.world.z);
 *   props.add(g);
 */

export const GRASS = 0xbfe07d;
export const GRASS_MIX = 0.22;          // was 0.58 — pastel tints washed the sectors out

export const SECTOR_TERRAIN = {
  'AI & agents':        { tint: 0x7fa8cf, feature: 'peaks',    label: 'Alpine peaks',   note: 'cold, sharp, tallest silhouette' },
  'Infra & dev tools':  { tint: 0xa8b56b, feature: 'terraces', label: 'Stone terraces', note: 'built ground: stepped, deliberate' },
  'Consumer & media':   { tint: 0xf2907f, feature: 'orchard',  label: 'Orchard',        note: 'round crowns, in bloom' },
  'Commerce & fintech': { tint: 0xf0c04a, feature: 'fields',   label: 'Crop fields',    note: 'striped rows + a stack' },
  'Enterprise & GTM':   { tint: 0x9d84c4, feature: 'conifers', label: 'Conifer stand',  note: 'dense, vertical, dark' },
  'Other':              { tint: 0xb8ab99, feature: 'scrub',    label: 'Scrub',          note: 'sparse and low on purpose' },
};

const hash = (s) => { const x = Math.sin(s * 12.9898) * 43758.5453; return x - Math.floor(x); };
const lam = (THREE, color) => new THREE.MeshLambertMaterial({ color, flatShading: true });

/** cap color for a sector: its tint pulled a little toward the common grass */
export function sectorTint(THREE, sectorKey, mix = GRASS_MIX) {
  const spec = SECTOR_TERRAIN[sectorKey] || SECTOR_TERRAIN.Other;
  return new THREE.Color(spec.tint).lerp(new THREE.Color(GRASS), mix).getHex();
}

const FEATURES = {
  /** AI & agents — 2–3 rock cones, snow on the tallest. Height budget 0.78. */
  peaks(THREE, seed, s) {
    const g = new THREE.Group();
    const rock = lam(THREE, 0x8a93a3), snow = lam(THREE, 0xeef4fa);
    const n = hash(seed) > 0.45 ? 3 : 2;
    for (let i = 0; i < n; i++) {
      const r = hash(seed + i * 3.7);
      const h = (0.46 + r * 0.32) * s, rad = (0.2 + r * 0.09) * s;
      const peak = new THREE.Mesh(new THREE.ConeGeometry(rad, h, 5), rock);
      const px = (hash(seed + i * 1.9) - 0.5) * 0.6 * s, pz = (hash(seed + i * 5.3) - 0.5) * 0.6 * s;
      peak.position.set(px, h / 2, pz);
      peak.rotation.y = r * Math.PI;
      g.add(peak);
      if (i === 0) {
        const cap = new THREE.Mesh(new THREE.ConeGeometry(rad * 0.42, h * 0.26, 5), snow);
        cap.position.set(px, h * 0.88, pz);
        cap.rotation.y = peak.rotation.y;
        g.add(cap);
      }
    }
    return g;
  },

  /** Infra & dev tools — three stepped slabs and a boulder. Height budget 0.34. */
  terraces(THREE, seed, s) {
    const g = new THREE.Group();
    const stone = lam(THREE, 0xb6ab9c), moss = lam(THREE, 0x9fb26a);
    for (let i = 0; i < 3; i++) {
      const w = (0.92 - i * 0.22) * s, d = (0.62 - i * 0.13) * s;
      const step = new THREE.Mesh(new THREE.BoxGeometry(w, 0.1 * s, d), i === 2 ? moss : stone);
      step.position.set(-i * 0.06 * s, (0.05 + i * 0.1) * s, i * 0.05 * s);
      g.add(step);
    }
    const boulder = new THREE.Mesh(new THREE.IcosahedronGeometry(0.13 * s, 0), stone);
    boulder.position.set(0.42 * s, 0.11 * s, -0.34 * s);
    boulder.rotation.set(hash(seed) * 3, hash(seed + 1) * 3, 0);
    g.add(boulder);
    g.rotation.y = hash(seed + 7.1) * Math.PI * 2;
    return g;
  },

  /** Consumer & media — round crowns, in bloom. Height budget 0.62. */
  orchard(THREE, seed, s) {
    const g = new THREE.Group();
    const trunk = lam(THREE, 0xa98d80), bloom = lam(THREE, 0xf2a3ae), leaf = lam(THREE, 0x8fb56a);
    for (let i = 0; i < 3; i++) {
      const r = hash(seed + i * 4.1);
      const t = new THREE.Mesh(new THREE.CylinderGeometry(0.035 * s, 0.05 * s, 0.2 * s, 5), trunk);
      const crown = new THREE.Mesh(new THREE.IcosahedronGeometry((0.15 + r * 0.05) * s, 1), r > 0.55 ? leaf : bloom);
      const px = (i - 1) * 0.3 * s + (r - 0.5) * 0.12 * s, pz = (hash(seed + i * 2.3) - 0.5) * 0.5 * s;
      t.position.set(px, 0.1 * s, pz);
      crown.position.set(px, (0.3 + r * 0.05) * s, pz);
      g.add(t, crown);
    }
    return g;
  },

  /** Commerce & fintech — striped rows and a stack. Height budget 0.3. */
  fields(THREE, seed, s) {
    const g = new THREE.Group();
    const a = lam(THREE, 0xd8c46a), b = lam(THREE, 0xb9cc72);
    for (let i = 0; i < 5; i++) {
      const row = new THREE.Mesh(new THREE.BoxGeometry(0.86 * s, 0.07 * s, 0.1 * s), i % 2 ? b : a);
      row.position.set(0, 0.035 * s, (i - 2) * 0.15 * s);
      g.add(row);
    }
    const stack = new THREE.Mesh(new THREE.ConeGeometry(0.13 * s, 0.26 * s, 7), lam(THREE, 0xe8c86a));
    stack.position.set(0.34 * s, 0.13 * s, 0.44 * s);
    g.add(stack);
    g.rotation.y = hash(seed) * Math.PI * 2;
    return g;
  },

  /** Enterprise & GTM — dense two-tier conifers. Height budget 0.82. */
  conifers(THREE, seed, s) {
    const g = new THREE.Group();
    const trunk = lam(THREE, 0x7a6155), dark = lam(THREE, 0x4f6b52), light = lam(THREE, 0x628a5c);
    for (let i = 0; i < 3; i++) {
      const r = hash(seed + i * 6.7);
      const h = (0.42 + r * 0.24) * s, rad = (0.15 + r * 0.04) * s;
      const px = (hash(seed + i * 1.3) - 0.5) * 0.62 * s, pz = (hash(seed + i * 8.9) - 0.5) * 0.62 * s;
      const t = new THREE.Mesh(new THREE.CylinderGeometry(0.03 * s, 0.04 * s, 0.14 * s, 5), trunk);
      t.position.set(px, 0.07 * s, pz);
      const lower = new THREE.Mesh(new THREE.ConeGeometry(rad, h * 0.7, 6), dark);
      lower.position.set(px, 0.12 * s + h * 0.35, pz);
      const upper = new THREE.Mesh(new THREE.ConeGeometry(rad * 0.7, h * 0.55, 6), light);
      upper.position.set(px, 0.12 * s + h * 0.78, pz);
      g.add(t, lower, upper);
    }
    return g;
  },

  /** Other — sparse tufts and a pebble. Height budget 0.24. */
  scrub(THREE, seed, s) {
    const g = new THREE.Group();
    const tuft = lam(THREE, 0xa8b57a), pebble = lam(THREE, 0xb9aaa4);
    for (let i = 0; i < 3; i++) {
      const r = hash(seed + i * 2.9);
      const t = new THREE.Mesh(new THREE.ConeGeometry(0.14 * s, (0.13 + r * 0.08) * s, 5), tuft);
      t.position.set((hash(seed + i * 3.3) - 0.5) * 0.7 * s, 0.08 * s, (hash(seed + i * 7.7) - 0.5) * 0.7 * s);
      t.rotation.y = r * Math.PI;
      g.add(t);
    }
    const p = new THREE.Mesh(new THREE.IcosahedronGeometry(0.1 * s, 0), pebble);
    p.position.set(0.36 * s, 0.08 * s, -0.3 * s);
    p.rotation.set(hash(seed) * 3, hash(seed + 4) * 3, 0);
    g.add(p);
    return g;
  },
};

/**
 * One sector feature group, deterministic from `seed`.
 * `scale` shrinks the whole group; 1 fills a hex of radius 0.98.
 */
export function makeSectorFeature(THREE, sectorKey, seed, { scale = 1 } = {}) {
  const spec = SECTOR_TERRAIN[sectorKey] || SECTOR_TERRAIN.Other;
  const g = FEATURES[spec.feature](THREE, seed, scale);
  g.traverse((o) => { o.castShadow = o.receiveShadow = true; });
  return g;
}

export const SECTOR_FEATURE_KEYS = Object.keys(FEATURES);
