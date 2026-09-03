/**
 * geo-data.js — location strings → job centers, plus the board data normalizer.
 *
 * Aliasing comes before any geography: 28 distinct strings in the sample payload
 * resolve to 19 centers. Unmatched strings are never dropped silently — they come
 * back in `unplaced` and are reported in the sidebar.
 */

/** The centers. `precision` drives the coastline treatment on the board. */
export const CENTERS = {
  sf:        { label: 'San Francisco Bay Area', lat: 37.77, lng: -122.42, precision: 'city' },
  la:        { label: 'Los Angeles',            lat: 34.05, lng: -118.24, precision: 'city' },
  austin:    { label: 'Austin',                 lat: 30.27, lng:  -97.74, precision: 'city' },
  nyc:       { label: 'New York City',          lat: 40.71, lng:  -74.01, precision: 'city' },
  seattle:   { label: 'Seattle',                lat: 47.61, lng: -122.33, precision: 'city' },
  toronto:   { label: 'Toronto',                lat: 43.65, lng:  -79.38, precision: 'city' },
  lisbon:    { label: 'Lisbon',                 lat: 38.72, lng:   -9.14, precision: 'city' },
  london:    { label: 'London',                 lat: 51.51, lng:   -0.13, precision: 'city' },
  paris:     { label: 'Paris',                  lat: 48.86, lng:    2.35, precision: 'city' },
  berlin:    { label: 'Berlin',                 lat: 52.52, lng:   13.41, precision: 'city' },
  munich:    { label: 'Munich',                 lat: 48.14, lng:   11.58, precision: 'city' },
  belgrade:  { label: 'Belgrade',               lat: 44.79, lng:   20.45, precision: 'city' },
  tokyo:     { label: 'Tokyo',                  lat: 35.68, lng:  139.65, precision: 'city' },
  bengaluru: { label: 'Bengaluru',              lat: 12.97, lng:   77.59, precision: 'city' },
  karachi:   { label: 'Karachi',                lat: 24.86, lng:   67.01, precision: 'city' },
  lahore:    { label: 'Lahore',                 lat: 31.55, lng:   74.34, precision: 'city' },
  india:     { label: 'India',                  lat: 22.00, lng:   79.00, precision: 'country' },
  china:     { label: 'China',                  lat: 35.00, lng:  105.00, precision: 'country' },
  vietnam:   { label: 'Vietnam',                lat: 14.06, lng:  108.28, precision: 'country' },
  korea:     { label: 'South Korea',            lat: 36.50, lng:  127.90, precision: 'country' },
  japan:     { label: 'Japan',                  lat: 36.20, lng:  138.25, precision: 'country' },
  usa:       { label: 'United States',          lat: 41.50, lng:  -95.00, precision: 'region' },
  remote:    { label: 'Remote',                 lat: 31.00, lng: -151.00, precision: 'policy', water: true },
  'us-remote': { label: 'US / Canada remote',   lat: 33.50, lng: -104.00, precision: 'policy', water: true },
};

/** normalized location string → center id. ~27 entries covers this dataset. */
export const LOCATION_ALIASES = {
  'san francisco': 'sf',
  'san francisco, ca': 'sf',
  'sf bay area': 'sf',
  'san francisco / bay area': 'sf',
  'bay area': 'sf',
  'palo alto': 'sf',
  'santa monica, ca': 'la',
  'santa monica': 'la',
  'los angeles': 'la',
  'los angeles, ca': 'la',
  'new york city': 'nyc',
  'new york city, ny': 'nyc',
  'new york, ny': 'nyc',
  'new york': 'nyc',
  'austin': 'austin',
  'austin, tx': 'austin',
  'seattle': 'seattle',
  'seattle, wa': 'seattle',
  'toronto': 'toronto',
  'lisbon': 'lisbon',
  'london': 'london',
  'london, uk': 'london',
  'london, england': 'london',
  'paris': 'paris',
  'berlin': 'berlin',
  'munich, germany': 'munich',
  'munich': 'munich',
  'belgrade': 'belgrade',
  'tokyo': 'tokyo',
  'bengaluru': 'bengaluru',
  'bengaluru, india': 'bengaluru',
  'karachi': 'karachi',
  'lahore': 'lahore',
  'india': 'india',
  'china': 'china',
  'vietnam': 'vietnam',
  'south korea': 'korea',
  'japan': 'japan',
  'usa': 'usa',
  'united states': 'usa',
  'us': 'usa',
  'remote': 'remote',
  'united states-remote': 'us-remote',
  'us-remote': 'us-remote',
  'us/canada': 'us-remote',
};

/**
 * Strip the noise a location string carries: parentheticals `(Hybrid)`, the
 * `Asia | ` region prefix, ` - Canada` / ` Office` suffixes.
 */
export function normalizeLocation(raw) {
  let s = String(raw || '').toLowerCase();
  s = s.replace(/\([^)]*\)/g, ' ');            // (Hybrid)
  s = s.replace(/^\s*(asia|europe|americas|emea|apac)\s*\|\s*/, '');
  s = s.replace(/\s*-\s*(canada|usa|us|uk)\s*$/, '');
  s = s.replace(/\s+office\s*$/, '');
  s = s.replace(/\s*,\s*/g, ', ').replace(/\s+/g, ' ').trim();
  s = s.replace(/[,\s]+$/, '');
  return s;
}

export function resolveLocation(raw) {
  const norm = normalizeLocation(raw);
  if (LOCATION_ALIASES[norm]) return LOCATION_ALIASES[norm];
  const bare = norm.replace(/[-\s]*remote\s*$/, '').trim();
  if (bare !== norm && LOCATION_ALIASES[bare]) return LOCATION_ALIASES[bare];
  return null;
}

/**
 * Roll every company's `jobs_by_loc` up into centers.
 * Returns { centers: [...], unplaced: [...], located, unlocatedRoles }
 */
export function resolveCenters(companies) {
  const acc = new Map();
  const unplaced = new Map();
  let located = 0;

  companies.forEach((co) => {
    Object.entries(co.jobs_by_loc || {}).forEach(([loc, n]) => {
      const roles = Number(n) || 0;
      if (!roles) return;
      const id = resolveLocation(loc);
      if (!id || !CENTERS[id]) {
        const cur = unplaced.get(loc) || { location: loc, roles: 0 };
        cur.roles += roles; unplaced.set(loc, cur);
        console.warn('[geo-board] unmatched location string:', loc, '(' + roles + ' roles)');
        return;
      }
      located += roles;
      if (!acc.has(id)) acc.set(id, { id, ...CENTERS[id], roles: 0, sources: new Set(), companies: [] });
      const c = acc.get(id);
      c.roles += roles;
      c.sources.add(loc);
      const existing = c.companies.find((x) => x.name === co.name);
      if (existing) existing.roles += roles;
      else c.companies.push({ name: co.name, roles, co });
    });
  });

  const centers = [...acc.values()].map((c) => ({
    ...c,
    sources: [...c.sources].sort(),
    companies: c.companies.sort((a, b) => b.roles - a.roles),
  })).sort((a, b) => b.roles - a.roles);

  return { centers, unplaced: [...unplaced.values()], located };
}

/** rolling median of 3 — scans are lumpy (partial crawls read as sudden dips) */
function medianSmooth(values) {
  return values.map((v, i) => {
    const w = [values[i - 1], v, values[i + 1]].filter((x) => x != null).sort((a, b) => a - b);
    return w[Math.floor(w.length / 2)];
  });
}

export function normalizeBoardData(raw) {
  const dates = [...(raw.dates || [])].sort();

  const companies = (raw.companies || []).map((c) => {
    const history = [...(c.history || [])].sort((a, b) => a.date.localeCompare(b.date));
    const totals = history.map((h) => h.total_jobs || 0);
    const smoothed = medianSmooth(totals);
    history.forEach((h, i) => { h.smoothed = smoothed[i]; });

    let maxAbsDelta = 1;
    for (let i = 1; i < smoothed.length; i++) maxAbsDelta = Math.max(maxAbsDelta, Math.abs(smoothed[i] - smoothed[i - 1]));

    const total = c.total_jobs || 0;
    const remoteShare = (c.remote_count || 0) / Math.max(1, total);

    return {
      name: c.company || c.name,
      cohort: c.cohort || '',
      industries: c.industries || [],
      total_jobs: total,
      jobs_by_fn: c.jobs_by_fn || {},
      jobs_by_loc: c.jobs_by_loc || {},
      remote_count: c.remote_count || 0,
      remote_policy: c.remote_policy || 'office',
      remoteShare,
      peak: Math.max(total, ...totals, 1),
      maxAbsDelta,
      history,
    };
  });

  const resolved = resolveCenters(companies);
  return {
    dates,
    functions: raw.functions || [],
    byDate: raw.by_date || {},
    companies,
    roles: raw.roles || [],   // per-role {company,title,department,location,url,posted_at}
    centers: resolved.centers,
    unplaced: resolved.unplaced,
    locatedRoles: resolved.located,
  };
}

export async function fetchBoardData(url = './data.json', init) {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`board data ${res.status} ${res.statusText}`);
  return normalizeBoardData(await res.json());
}
