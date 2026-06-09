// Geocoding + 50-mile service area check (Downtown Los Angeles)

const DTLA = { lat: 34.052235, lng: -118.243683 };
const MAX_MILES = 50;

const fetchFn = typeof fetch === 'function' ? fetch.bind(globalThis) : require('node-fetch');

async function fetchJson(url, options = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchFn(url, { ...options, signal: controller.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function haversineMiles(lat1, lon1, lat2, lon2) {
  const R = 3958.7613;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

async function geocodeWithCensus(address) {
  const url =
    'https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?' +
    new URLSearchParams({
      address,
      benchmark: 'Public_AR_Current',
      format: 'json',
    });
  const data = await fetchJson(url);
  const match = data?.result?.addressMatches?.[0];
  if (!match?.coordinates) return null;
  return {
    lat: match.coordinates.y,
    lng: match.coordinates.x,
    formatted: match.matchedAddress || address,
    source: 'census',
  };
}

async function geocodeWithNominatim(address) {
  const url =
    'https://nominatim.openstreetmap.org/search?' +
    new URLSearchParams({
      q: address,
      format: 'json',
      limit: '1',
      countrycodes: 'us',
    });
  const data = await fetchJson(url, {
    headers: { 'User-Agent': 'HibretEdir/1.0 (hibretedirtext@gmail.com)' },
  });
  const hit = Array.isArray(data) ? data[0] : null;
  if (!hit?.lat || !hit?.lon) return null;
  return {
    lat: parseFloat(hit.lat),
    lng: parseFloat(hit.lon),
    formatted: hit.display_name || address,
    source: 'nominatim',
  };
}

async function geocodeAddress(address) {
  const text = String(address || '').trim();
  if (!text) return null;
  return (await geocodeWithCensus(text)) || (await geocodeWithNominatim(text));
}

async function checkAddressRadius(address) {
  const coords = await geocodeAddress(address);
  if (!coords) {
    return {
      ok: false,
      reason: 'not_found',
      error:
        'We could not verify that address. Enter your full street address with city, state, and ZIP.',
    };
  }

  const miles = haversineMiles(DTLA.lat, DTLA.lng, coords.lat, coords.lng);
  const rounded = Math.round(miles * 10) / 10;

  if (miles > MAX_MILES) {
    return {
      ok: false,
      reason: 'too_far',
      miles: rounded,
      formatted: coords.formatted,
      error: `Membership is limited to addresses within ${MAX_MILES} miles of Downtown Los Angeles. Your address appears to be about ${rounded} miles away.`,
    };
  }

  return {
    ok: true,
    miles: rounded,
    formatted: coords.formatted,
    max_miles: MAX_MILES,
  };
}

module.exports = {
  DTLA,
  MAX_MILES,
  checkAddressRadius,
  geocodeAddress,
  haversineMiles,
};
