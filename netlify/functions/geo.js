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

function titleCaseCity(city) {
  return String(city || '')
    .trim()
    .toLowerCase()
    .replace(/\b([a-z])/g, (m) => m.toUpperCase());
}

function buildStreetFromCensusComponents(c) {
  if (!c) return '';
  const parts = [
    c.fromAddress,
    c.preDirection,
    c.preType,
    c.streetName,
    c.suffixType,
    c.suffixDirection,
    c.postDirection,
  ].filter((p) => p && String(p).trim());
  return parts.join(' ').trim();
}

function extractUnitSuffix(line) {
  const m = String(line || '').match(/,\s*((?:Apt\.?|Unit|Ste\.?|Suite|#)\s*[\w-]+)/i);
  return m ? m[1].trim() : '';
}

/** Split a one-line US address into street, city, state, zip (best-effort). */
function parseUsAddressLine(raw) {
  const line = String(raw || '').trim().replace(/\s+/g, ' ');
  if (!line) return { address: '', city: '', state: 'CA', zip: '' };

  const tail = line.match(/(?:,\s*|\s+)([A-Za-z]{2})\s+(\d{5}(?:-\d{4})?)\s*$/);
  if (!tail) {
    return { address: line, city: '', state: 'CA', zip: '' };
  }

  const state = tail[1].toUpperCase();
  const zip = tail[2];
  let rest = line.slice(0, tail.index).trim().replace(/,\s*$/, '');

  const aptCity = rest.match(
    /^(.+?),\s*((?:Apt\.?|Unit|Ste\.?|Suite|#)\s*[\w-]+)\s+([A-Za-z][A-Za-z\s.-]+)$/i
  );
  if (aptCity) {
    return {
      address: `${aptCity[1].trim()}, ${aptCity[2].trim()}`,
      city: titleCaseCity(aptCity[3].trim()),
      state,
      zip,
    };
  }

  const lastComma = rest.lastIndexOf(',');
  if (lastComma >= 0) {
    const street = rest.slice(0, lastComma).trim();
    const city = rest.slice(lastComma + 1).trim();
    if (city && !/^\d+$/.test(city)) {
      return { address: street, city: titleCaseCity(city), state, zip };
    }
  }

  const words = rest.split(/\s+/);
  if (words.length >= 3) {
    for (let n = 2; n <= 3 && words.length > n; n += 1) {
      const cityWords = words.slice(-n);
      const cityCandidate = cityWords.join(' ');
      if (
        !/\d/.test(cityCandidate)
        && !/^(dr|st|ave|rd|blvd|ln|way|apt|unit|ste|suite)$/i.test(cityWords[0])
      ) {
        const street = words.slice(0, -n).join(' ');
        if (street) {
          return { address: street, city: titleCaseCity(cityCandidate), state, zip };
        }
      }
    }
  }

  return { address: rest, city: '', state, zip };
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
  const c = match.addressComponents || {};
  const street = buildStreetFromCensusComponents(c);
  const zip = c.zip ? String(c.zip) : '';
  return {
    lat: match.coordinates.y,
    lng: match.coordinates.x,
    formatted: match.matchedAddress || address,
    source: 'census',
    components: {
      street,
      city: c.city ? String(c.city).trim() : '',
      state: c.state ? String(c.state).trim().toUpperCase() : '',
      zip,
    },
  };
}

/** Parse waiting-list one-line address into application form fields. */
async function parseAddressForForm(fullAddress) {
  const line = String(fullAddress || '').trim();
  if (!line) return { address: '', city: '', state: 'CA', zip: '' };

  const census = await geocodeWithCensus(line);
  if (census?.components?.city) {
    let address = census.components.street || line;
    const unit = extractUnitSuffix(line);
    if (unit && !address.toLowerCase().includes(unit.toLowerCase())) {
      address = `${address.replace(/,\s*$/, '')}, ${unit}`;
    }
    return {
      address,
      city: titleCaseCity(census.components.city),
      state: census.components.state || 'CA',
      zip: census.components.zip || '',
    };
  }

  return parseUsAddressLine(line);
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
  parseUsAddressLine,
  parseAddressForForm,
  titleCaseCity,
};
