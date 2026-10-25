const { geocodeServiceAddress } = require('../src/geocoding');

const validResult = {
  status: 'OK',
  results: [{
    formatted_address: '123 Test Street, Nocona Hills, TX 76255, USA',
    types: ['street_address'],
    address_components: [
      { long_name: '76255', types: ['postal_code'] },
      { short_name: 'TX', types: ['administrative_area_level_1'] },
    ],
    geometry: { location: { lat: 33.845, lng: -97.64 } },
  }],
};

describe('Google address verification', () => {
  const priorApiKey = process.env.GOOGLE_MAPS_API_KEY;

  beforeEach(() => {
    process.env.GOOGLE_MAPS_API_KEY = 'test-maps-key';
  });

  afterAll(() => {
    if (priorApiKey === undefined) delete process.env.GOOGLE_MAPS_API_KEY;
    else process.env.GOOGLE_MAPS_API_KEY = priorApiKey;
  });

  it('accepts a complete US street address within 100 miles of Nocona Hills', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => validResult,
    });
    await expect(geocodeServiceAddress('123 Test Street, 76255', fetchImpl))
      .resolves.toEqual({ status: 'inside_area' });
    const requestUrl = new URL(fetchImpl.mock.calls[0][0]);
    expect(requestUrl.searchParams.get('components')).toBe('country:US');
    expect(requestUrl.searchParams.get('key')).toBe('test-maps-key');
  });

  it('measures the 100-mile service radius, including across the Oklahoma line', async () => {
    const at = (lat, lng) => jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ status: 'OK', results: [{ ...validResult.results[0], geometry: { location: { lat, lng } } }] }),
    });
    // About 83 miles south, toward Dallas-Fort Worth.
    await expect(geocodeServiceAddress('1 Main St', at(32.645, -97.64))).resolves.toEqual({ status: 'inside_area' });
    // Lawton, Oklahoma, about 68 miles north-west.
    await expect(geocodeServiceAddress('1 Main St', at(34.6087, -98.3903))).resolves.toEqual({ status: 'inside_area' });
    // About 104 miles north.
    await expect(geocodeServiceAddress('1 Main St', at(35.345, -97.64))).resolves.toEqual({ status: 'outside_area' });
  });

  it('uses a customer\'s own service center and radius when given', async () => {
    const austin = { latitude: 30.2672, longitude: -97.7431, radiusMiles: 30 };
    const at = (lat, lng) => jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ status: 'OK', results: [{ ...validResult.results[0], geometry: { location: { lat, lng } } }] }),
    });
    // Round Rock is about 17 miles from downtown Austin; Nocona Hills is far outside 30 miles.
    await expect(geocodeServiceAddress('1 Main St', at(30.5083, -97.6789), austin)).resolves.toEqual({ status: 'inside_area' });
    await expect(geocodeServiceAddress('1 Main St', at(33.845, -97.64), austin)).resolves.toEqual({ status: 'outside_area' });
  });

  it('does not accept a ZIP-only match or a partial result', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        ...validResult,
        results: [{ ...validResult.results[0], partial_match: true }],
      }),
    });
    await expect(geocodeServiceAddress('76255', fetchImpl)).resolves.toEqual({ status: 'not_found' });
  });

  it('surfaces provider and configuration failures', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({ ok: false, status: 503 });
    await expect(geocodeServiceAddress('123 Test Street, 76255', fetchImpl))
      .rejects.toThrow('Google geocoding request failed with status 503.');
    delete process.env.GOOGLE_MAPS_API_KEY;
    await expect(geocodeServiceAddress('123 Test Street', fetchImpl))
      .rejects.toThrow('Google Maps Geocoding is not configured.');
  });
});
