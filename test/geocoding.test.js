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

  it('requires a complete address inside the configured service polygon', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => validResult,
    });
    await expect(geocodeServiceAddress('123 Test Street, 76255', fetchImpl))
      .resolves.toEqual({ status: 'inside_area' });
    const requestUrl = new URL(fetchImpl.mock.calls[0][0]);
    expect(requestUrl.searchParams.get('components')).toBe('country:US|postal_code:76255');
    expect(requestUrl.searchParams.get('key')).toBe('test-maps-key');
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
