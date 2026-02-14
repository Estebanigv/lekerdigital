/**
 * CNE (Comisión Nacional de Energía) - Fuel Price Service
 * Fetches real-time fuel prices from CNE API (Chile)
 * Cache: 24 hours (prices change weekly)
 */

class CneService {
  constructor() {
    this.email = process.env.CNE_EMAIL || '';
    this.password = process.env.CNE_PASSWORD || '';
    this.token = null;
    this.tokenExpiry = null;
    this.cachedPrices = null;
    this.cacheExpiry = null;
    this.cachedRegionalPrices = null;
    this.regionalCacheExpiry = null;
    this.CACHE_DURATION_MS = 24 * 60 * 60 * 1000; // 24 hours
    this.BASE_URL = 'https://api.cne.cl/api';
  }

  isConfigured() {
    return !!(this.email && this.password);
  }

  async login() {
    if (!this.isConfigured()) {
      return null;
    }

    try {
      const response = await fetch(`${this.BASE_URL}/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: this.email, password: this.password })
      });

      if (!response.ok) {
        console.error('[CNE] Login failed:', response.status);
        return null;
      }

      const data = await response.json();
      if (data.token) {
        this.token = data.token;
        // Token valid for 12 hours (conservative)
        this.tokenExpiry = Date.now() + 12 * 60 * 60 * 1000;
        console.log('[CNE] Login successful');
        return this.token;
      }

      return null;
    } catch (error) {
      console.error('[CNE] Login error:', error.message);
      return null;
    }
  }

  async getToken() {
    if (this.token && this.tokenExpiry && Date.now() < this.tokenExpiry) {
      return this.token;
    }
    return await this.login();
  }

  async fetchFuelPrices() {
    const token = await this.getToken();
    if (!token) return null;

    try {
      const response = await fetch(`${this.BASE_URL}/combustibles/liquidos`, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/json'
        }
      });

      if (response.status === 401) {
        // Token expired, retry login
        this.token = null;
        const newToken = await this.login();
        if (!newToken) return null;

        const retry = await fetch(`${this.BASE_URL}/combustibles/liquidos`, {
          headers: {
            'Authorization': `Bearer ${newToken}`,
            'Accept': 'application/json'
          }
        });
        if (!retry.ok) return null;
        return await retry.json();
      }

      if (!response.ok) {
        console.error('[CNE] Fetch prices failed:', response.status);
        return null;
      }

      return await response.json();
    } catch (error) {
      console.error('[CNE] Fetch prices error:', error.message);
      return null;
    }
  }

  /**
   * Parse CNE response to extract Bencina 93 average price
   * CNE API typically returns array of stations with fuel prices
   */
  parseFuelPrices(data) {
    if (!data) return null;

    try {
      // CNE returns different formats; handle arrays or nested objects
      let stations = [];

      if (Array.isArray(data)) {
        stations = data;
      } else if (data.data && Array.isArray(data.data)) {
        stations = data.data;
      } else if (data.combustibles && Array.isArray(data.combustibles)) {
        stations = data.combustibles;
      } else if (data.items && Array.isArray(data.items)) {
        stations = data.items;
      }

      // Extract Bencina 93 prices
      const prices93 = [];

      for (const station of stations) {
        // Look for gasolina 93 / bencina 93 in various field names
        const price = station.gasolina_93 || station.bencina_93 || station.precio_93
          || station.gasolina93 || station.bencina93
          || (station.precios && (station.precios.gasolina_93 || station.precios.bencina_93))
          || (station.combustibles && station.combustibles.find(c =>
            c.nombre?.toLowerCase().includes('93') || c.tipo?.toLowerCase().includes('93')
          )?.precio);

        if (price && typeof price === 'number' && price > 500 && price < 3000) {
          prices93.push(price);
        }
      }

      if (prices93.length === 0) return null;

      const avg = Math.round(prices93.reduce((a, b) => a + b, 0) / prices93.length);
      const min = Math.min(...prices93);
      const max = Math.max(...prices93);

      return {
        price: avg,
        minPrice: min,
        maxPrice: max,
        stationsCount: prices93.length,
        source: 'CNE API',
        updatedAt: new Date().toISOString()
      };
    } catch (error) {
      console.error('[CNE] Parse error:', error.message);
      return null;
    }
  }

  /**
   * Get fuel price (with 24h cache)
   * Returns { price, source, minPrice, maxPrice, stationsCount, updatedAt } or null
   */
  async getFuelPrice() {
    // Return cached if valid
    if (this.cachedPrices && this.cacheExpiry && Date.now() < this.cacheExpiry) {
      return this.cachedPrices;
    }

    if (!this.isConfigured()) {
      return null;
    }

    const rawData = await this.fetchFuelPrices();
    const parsed = this.parseFuelPrices(rawData);

    if (parsed) {
      this.cachedPrices = parsed;
      this.cacheExpiry = Date.now() + this.CACHE_DURATION_MS;
      console.log(`[CNE] Fuel price updated: $${parsed.price}/L (${parsed.stationsCount} stations, range $${parsed.minPrice}-$${parsed.maxPrice})`);
    }

    return parsed;
  }

  /**
   * Parse CNE response to extract Bencina 93 prices by region
   * Returns object with regional breakdowns and national average
   */
  parseFuelPricesByRegion(data) {
    if (!data) return null;

    try {
      // Extract stations array (same logic as parseFuelPrices)
      let stations = [];

      if (Array.isArray(data)) {
        stations = data;
      } else if (data.data && Array.isArray(data.data)) {
        stations = data.data;
      } else if (data.combustibles && Array.isArray(data.combustibles)) {
        stations = data.combustibles;
      } else if (data.items && Array.isArray(data.items)) {
        stations = data.items;
      }

      // Group prices by region
      const regionData = {};
      let allPrices = [];

      for (const station of stations) {
        // Extract region (try multiple possible field names)
        const region = station.region || station.region_nombre || station.comuna
          || (station.ubicacion && (station.ubicacion.region || station.ubicacion.region_nombre))
          || (station.location && (station.location.region || station.location.region_nombre))
          || 'Sin Región';

        // Normalize region name
        const regionName = String(region).trim();
        if (!regionName || regionName === 'Sin Región') continue;

        // Extract Bencina 93 price (same logic as parseFuelPrices)
        const price = station.gasolina_93 || station.bencina_93 || station.precio_93
          || station.gasolina93 || station.bencina93
          || (station.precios && (station.precios.gasolina_93 || station.precios.bencina_93))
          || (station.combustibles && station.combustibles.find(c =>
            c.nombre?.toLowerCase().includes('93') || c.tipo?.toLowerCase().includes('93')
          )?.precio);

        if (price && typeof price === 'number' && price > 500 && price < 3000) {
          // Initialize region if not exists
          if (!regionData[regionName]) {
            regionData[regionName] = { prices: [], stationsCount: 0 };
          }
          regionData[regionName].prices.push(price);
          regionData[regionName].stationsCount++;
          allPrices.push(price);
        }
      }

      if (allPrices.length === 0) return null;

      // Calculate stats per region
      const regions = {};
      for (const [regionName, data] of Object.entries(regionData)) {
        const avg = data.prices.reduce((a, b) => a + b, 0) / data.prices.length;
        const min = Math.min(...data.prices);
        const max = Math.max(...data.prices);

        regions[regionName] = {
          price: Math.round(avg),
          minPrice: min,
          maxPrice: max,
          stationsCount: data.stationsCount
        };
      }

      // Calculate national average
      const nationalAvg = Math.round(allPrices.reduce((a, b) => a + b, 0) / allPrices.length);

      return {
        regions,
        nationalAvg,
        source: 'CNE API',
        updatedAt: new Date().toISOString()
      };
    } catch (error) {
      console.error('[CNE] Parse by region error:', error.message);
      return null;
    }
  }

  /**
   * Get fuel prices by region (with 24h cache)
   * Returns { regions, nationalAvg, source, updatedAt } or null
   */
  async getFuelPricesByRegion() {
    // Check if we already have regional data cached (reuse same cache mechanism)
    if (this.cachedRegionalPrices && this.regionalCacheExpiry && Date.now() < this.regionalCacheExpiry) {
      return this.cachedRegionalPrices;
    }

    if (!this.isConfigured()) {
      return null;
    }

    const rawData = await this.fetchFuelPrices();
    const parsed = this.parseFuelPricesByRegion(rawData);

    if (parsed) {
      this.cachedRegionalPrices = parsed;
      this.regionalCacheExpiry = Date.now() + this.CACHE_DURATION_MS;
      const regionCount = Object.keys(parsed.regions).length;
      console.log(`[CNE] Regional fuel prices updated: ${regionCount} regions, national avg $${parsed.nationalAvg}/L`);
    }

    return parsed;
  }
}

module.exports = new CneService();
