const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const GEOAPIFY_KEY = process.env.GEOAPIFY_KEY; // for geocoding & places

// Simple caches to reduce upstream calls
const cache = {
  geocode: new Map(), // key: text -> {lat, lon}
  rxnorm: new Map(), // key: med -> {rxcui, name, suggestions}
};

// NOTE: We now support a keyless fallback when GEOAPIFY_KEY is missing.
// Geocoding fallback: Nominatim (OpenStreetMap)
// Pharmacies fallback: Overpass API (OpenStreetMap)

// Utility: deterministic number from string for price/stock simulation
function seedNum(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  return h;
}

function simulatePrice(rxcui, placeId) {
  const base = 10 + (seedNum(String(rxcui)) % 40); // $10–$50 base
  const variation = (seedNum(String(placeId)) % 200) / 100; // $0.00–$2.00
  return Number((base + variation).toFixed(2));
}

function simulateStock(placeId) {
  const v = seedNum(String(placeId)) % 100;
  if (v < 10) return 'out_of_stock';
  if (v < 35) return 'low_stock';
  return 'in_stock';
}

async function rxnormLookup(med) {
  const key = med.trim().toLowerCase();
  if (cache.rxnorm.has(key)) return cache.rxnorm.get(key);
  const url = `https://rxnav.nlm.nih.gov/REST/drugs.json?name=${encodeURIComponent(med)}`;
  try {
    const r = await axios.get(url);
    const groups = r.data?.drugGroup?.conceptGroup || [];
    let best = null;
    for (const g of groups) {
      const props = g.conceptProperties || [];
      for (const p of props) {
        if (!best) best = p;
        if (String(p.name).toLowerCase() === key) { best = p; break; }
      }
    }
    if (!best) {
      // fetch spelling suggestions to assist user
      const sUrl = `https://rxnav.nlm.nih.gov/REST/spellingsuggestions.json?name=${encodeURIComponent(med)}`;
      const s = await axios.get(sUrl);
      const suggestions = s.data?.suggestionGroup?.suggestionList?.suggestion || [];
      const payload = { rxcui: null, name: null, suggestions };
      cache.rxnorm.set(key, payload);
      return payload;
    }
    const payload = { rxcui: best.rxcui, name: best.name, suggestions: [] };
    cache.rxnorm.set(key, payload);
    return payload;
  } catch (err) {
    throw upstreamError('RxNorm lookup failed', err);
  }
}

async function geocodeText(text) {
  const key = text.trim().toLowerCase();
  if (cache.geocode.has(key)) return cache.geocode.get(key);
  try {
    if (GEOAPIFY_KEY) {
      const url = `https://api.geoapify.com/v1/geocode/search?text=${encodeURIComponent(text)}&limit=1&apiKey=${GEOAPIFY_KEY}`;
      const r = await axios.get(url);
      const feat = r.data?.features?.[0];
      if (!feat) return null;
      const { lat, lon } = feat.properties;
      const payload = { lat, lon };
      cache.geocode.set(key, payload);
      return payload;
    }
    // Fallback: Nominatim
    const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(text)}&limit=1`;
    const r = await axios.get(url, { headers: { 'User-Agent': 'MedicationChecker/1.0' } });
    const item = r.data?.[0];
    if (!item) return null;
    const lat = parseFloat(item.lat);
    const lon = parseFloat(item.lon);
    const payload = { lat, lon };
    cache.geocode.set(key, payload);
    return payload;
  } catch (err) {
    throw upstreamError('Geocoding failed', err);
  }
}

async function findPharmacies(lat, lon, radiusMeters = 10000) {
  try {
    if (GEOAPIFY_KEY) {
      const url = `https://api.geoapify.com/v2/places?categories=healthcare.pharmacy&filter=circle:${lon},${lat},${radiusMeters}&bias=proximity:${lon},${lat}&limit=30&apiKey=${GEOAPIFY_KEY}`;
      const r = await axios.get(url);
      const feats = r.data?.features || [];
      return feats.map(f => ({
        id: f.properties.place_id,
        name: f.properties.name || 'Unknown Pharmacy',
        address: f.properties.formatted || [f.properties.street, f.properties.city].filter(Boolean).join(', '),
        phone: f.properties.contact?.phone || null,
        distance_km: f.properties.distance ? Number((f.properties.distance / 1000).toFixed(2)) : haversineKm(lat, lon, f.properties.lat, f.properties.lon),
        lat: f.properties.lat,
        lon: f.properties.lon,
      }));
    }
    // Fallback: Overpass API
    const q = `[
      out:json
    ];
    (
      node["amenity"="pharmacy"](around:${radiusMeters},${lat},${lon});
      way["amenity"="pharmacy"](around:${radiusMeters},${lat},${lon});
      relation["amenity"="pharmacy"](around:${radiusMeters},${lat},${lon});
    );
    out center tags;`;
    const r = await axios.post('https://overpass-api.de/api/interpreter', `data=${encodeURIComponent(q)}`, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'MedicationChecker/1.0' }
    });
    const elements = r.data?.elements || [];
    return elements.map(e => {
      const pLat = e.lat ?? e.center?.lat;
      const pLon = e.lon ?? e.center?.lon;
      const name = e.tags?.name || 'Pharmacy';
      const addressParts = [e.tags?.['addr:housenumber'], e.tags?.['addr:street'], e.tags?.['addr:city'], e.tags?.['addr:postcode']].filter(Boolean);
      const phone = e.tags?.phone || e.tags?.['contact:phone'] || null;
      return {
        id: e.id,
        name,
        address: addressParts.length ? addressParts.join(', ') : null,
        phone,
        distance_km: pLat && pLon ? Number(haversineKm(lat, lon, pLat, pLon).toFixed(2)) : null,
        lat: pLat,
        lon: pLon,
      };
    });
  } catch (err) {
    throw upstreamError('Pharmacy search failed', err);
  }
}

// Main search endpoint: combines RxNorm lookup, geocoding, and pharmacies
// GET /api/search?med=Amoxicillin&location=Boston, MA&radius_km=10&price_min=&price_max=&stock=in_stock|any&sort=price_asc|price_desc|distance
app.get('/api/search', async (req, res) => {
  try {
    const med = (req.query.med || '').toString().trim();
    const location = (req.query.location || '').toString().trim();
    const radiusKm = Number(req.query.radius_km || 10);
    const priceMin = req.query.price_min ? Number(req.query.price_min) : null;
    const priceMax = req.query.price_max ? Number(req.query.price_max) : null;
    const stockFilter = (req.query.stock || 'any').toString();
    const sortBy = (req.query.sort || 'distance').toString();

    if (!med) return res.status(400).json({ error: 'Missing parameter: med' });
    if (!location) return res.status(400).json({ error: 'Missing parameter: location' });

    const drug = await rxnormLookup(med);
    if (!drug.rxcui) {
      return res.status(400).json({ error: 'Invalid medicine name', suggestions: drug.suggestions || [] });
    }

    const geo = await geocodeText(location);
    if (!geo) return res.status(404).json({ error: 'Location not found' });

    const places = await findPharmacies(geo.lat, geo.lon, Math.max(1000, Math.min(50000, radiusKm * 1000)));

    // enrich with simulated price and stock
    let items = places.map(p => ({
      ...p,
      price_usd: simulatePrice(drug.rxcui, p.id),
      availability: simulateStock(p.id),
    }));

    // filter by price range
    if (priceMin !== null) items = items.filter(i => i.price_usd >= priceMin);
    if (priceMax !== null) items = items.filter(i => i.price_usd <= priceMax);
    // filter by stock
    if (stockFilter === 'in_stock') items = items.filter(i => i.availability === 'in_stock');
    if (stockFilter === 'low_stock') items = items.filter(i => i.availability === 'low_stock');

    // sort
    if (sortBy === 'price_asc') items.sort((a, b) => a.price_usd - b.price_usd);
    else if (sortBy === 'price_desc') items.sort((a, b) => b.price_usd - a.price_usd);
    else if (sortBy === 'distance') items.sort((a, b) => (a.distance_km ?? Infinity) - (b.distance_km ?? Infinity));

    res.json({
      med: { name: drug.name, rxcui: drug.rxcui },
      location: { text: location, lat: geo.lat, lon: geo.lon },
      total: items.length,
      items
    });
  } catch (err) {
    const details = extractError(err);
    res.status(details.status || 502).json(details);
  }
});

// Health check for load balancer
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: Date.now() });
});

// Serve UI
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

function upstreamError(message, err) {
  const e = new Error(message);
  e.cause = err;
  return e;
}

function extractError(err) {
  if (err.response) {
    return { status: err.response.status, error: 'Upstream error', data: err.response.data };
  }
  return { status: 502, error: err.message || 'Unknown error' };
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const R = 6371; // km
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});