const { isInNoconaHills } = require('./service-area');

async function geocodeServiceAddress(address, fetchImpl = global.fetch) {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) throw new Error('Google Maps Geocoding is not configured.');

  const url = new URL('https://maps.googleapis.com/maps/api/geocode/json');
  url.searchParams.set('address', address);
  url.searchParams.set('components', 'country:US|postal_code:76255');
  url.searchParams.set('key', apiKey);

  const response = await fetchImpl(url, { signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error(`Google geocoding request failed with status ${response.status}.`);
  const result = await response.json();
  if (result.status === 'ZERO_RESULTS') return { status: 'not_found' };
  if (result.status !== 'OK' || !Array.isArray(result.results) || !result.results[0]) {
    throw new Error(`Google geocoding returned ${result.status || 'an invalid response'}.`);
  }

  const match = result.results[0];
  const addressTypes = match.types || [];
  const components = match.address_components || [];
  const postalCode = components.find((component) => component.types.includes('postal_code'))?.long_name;
  const state = components.find((component) => component.types.includes('administrative_area_level_1'))?.short_name;
  const location = match.geometry?.location;
  if (
    match.partial_match ||
    !addressTypes.some((type) => type === 'street_address' || type === 'premise' || type === 'subpremise') ||
    postalCode !== '76255' ||
    state !== 'TX' ||
    !Number.isFinite(location?.lat) ||
    !Number.isFinite(location?.lng)
  ) {
    return { status: 'not_found' };
  }
  if (!isInNoconaHills(location.lng, location.lat)) return { status: 'outside_area' };
  return { status: 'inside_area' };
}

module.exports = { geocodeServiceAddress };
