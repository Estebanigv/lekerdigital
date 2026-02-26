/**
 * Google Sheets Integration Service
 * Conecta con Google Apps Script para leer y escribir datos del Google Sheet de LEKER
 */
const https = require('https');

class GoogleSheetsService {
  constructor() {
    this.scriptUrl = process.env.GOOGLE_SHEETS_SCRIPT_URL || '';
  }

  isConfigured() {
    return !!this.scriptUrl;
  }

  /**
   * Helper para hacer requests HTTPS con soporte de redirects 302
   * @param {string} url
   * @param {object} opts - { method, body, maxRedirects }
   */
  makeRequest(url, opts = {}) {
    const maxRedirects = opts.maxRedirects !== undefined ? opts.maxRedirects : 5;
    const method = opts.method || 'GET';
    const body = opts.body || null;

    return new Promise((resolve, reject) => {
      if (maxRedirects <= 0) {
        return reject(new Error('Demasiados redirects'));
      }

      const urlObj = new URL(url);
      const postData = body ? JSON.stringify(body) : null;

      const options = {
        hostname: urlObj.hostname,
        port: 443,
        path: urlObj.pathname + urlObj.search,
        method: method,
        headers: {
          'Accept': 'application/json'
        },
        timeout: 90000
      };

      if (postData) {
        options.headers['Content-Type'] = 'application/json';
        options.headers['Content-Length'] = Buffer.byteLength(postData);
      }

      const req = https.request(options, (res) => {
        // Handle redirects (Apps Script always returns 302)
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          // On redirect after POST, Apps Script expects GET to the redirect URL
          return this.makeRequest(res.headers.location, { maxRedirects: maxRedirects - 1 })
            .then(resolve)
            .catch(reject);
        }

        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, data: JSON.parse(data) });
          } catch (e) {
            resolve({ ok: false, status: res.statusCode, data: data });
          }
        });
      });

      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Timeout: Google Apps Script tardó demasiado en responder'));
      });

      req.on('error', (e) => reject(e));

      if (postData) {
        req.write(postData);
      }
      req.end();
    });
  }

  /**
   * Obtiene datos de todas las hojas
   */
  async getAllSheets() {
    if (!this.isConfigured()) {
      throw new Error('Google Sheets no está configurado. Agrega GOOGLE_SHEETS_SCRIPT_URL al .env');
    }

    const response = await this.makeRequest(`${this.scriptUrl}?sheet=all`);

    if (!response.ok) {
      throw new Error(`Error al obtener datos: ${response.status}`);
    }

    return response.data;
  }

  /**
   * Obtiene datos de una hoja específica
   */
  async getSheet(sheetName) {
    if (!this.isConfigured()) {
      throw new Error('Google Sheets no está configurado. Agrega GOOGLE_SHEETS_SCRIPT_URL al .env');
    }

    const response = await this.makeRequest(`${this.scriptUrl}?sheet=${encodeURIComponent(sheetName)}`);

    if (!response.ok) {
      throw new Error(`Error al obtener hoja "${sheetName}": ${response.status}`);
    }

    return response.data;
  }

  /**
   * Obtiene metadata (nombres de hojas, filas, columnas)
   */
  async getMetadata() {
    if (!this.isConfigured()) {
      throw new Error('Google Sheets no está configurado. Agrega GOOGLE_SHEETS_SCRIPT_URL al .env');
    }

    const response = await this.makeRequest(this.scriptUrl);

    if (!response.ok) {
      throw new Error(`Error al obtener metadata: ${response.status}`);
    }

    return response.data;
  }

  /**
   * Escribe datos al Google Sheet via POST al Apps Script
   * @param {object} payload - { action: "updateAddress", rows: [...] }
   * @returns {object} - { success, updated, notFound, errors }
   */
  async postToSheet(payload) {
    if (!this.isConfigured()) {
      console.warn('[GSheets] No configurado — sync a Excel omitido');
      return { success: false, error: 'Google Sheets no configurado' };
    }

    try {
      const response = await this.makeRequest(this.scriptUrl, {
        method: 'POST',
        body: payload
      });

      if (!response.ok && !response.data?.success) {
        console.error('[GSheets] Error en POST:', response.data);
        return { success: false, error: response.data?.error || `HTTP ${response.status}` };
      }

      return response.data;
    } catch (error) {
      console.error('[GSheets] Error en postToSheet:', error.message);
      return { success: false, error: error.message };
    }
  }

  /**
   * Genera URL de búsqueda en Google Maps para una dirección
   */
  buildMapsSearchUrl(address, commune) {
    const parts = [address, commune, 'Chile'].filter(Boolean);
    const query = parts.join(', ').replace(/\s+/g, ' ').trim();
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
  }

  /**
   * Sincroniza dirección de un cliente al Google Sheet
   * @param {string} externalId - Código del cliente
   * @param {string} address - Nueva dirección
   * @param {string} commune - Nueva comuna
   * @param {string} updatedBy - Email o nombre del usuario que actualizó
   * @param {string} [geoLink] - Link de georeferencia (se auto-genera si no se proporciona)
   */
  async syncAddressToSheet(externalId, address, commune, updatedBy, geoLink) {
    if (!externalId) {
      console.warn('[GSheets] syncAddressToSheet: sin external_id, omitiendo');
      return { success: false, error: 'Sin código de cliente' };
    }

    // Auto-generate geo link if not provided and address exists
    const autoGeoLink = geoLink || (address ? this.buildMapsSearchUrl(address, commune) : '');

    return this.postToSheet({
      action: 'updateAddress',
      rows: [{
        code: externalId,
        address: address || '',
        commune: commune || '',
        geoLink: autoGeoLink,
        updatedBy: updatedBy || 'sistema',
        updatedAt: new Date().toISOString()
      }]
    });
  }

  /**
   * Actualiza la URL en runtime
   */
  updateConfig(scriptUrl) {
    if (scriptUrl) this.scriptUrl = scriptUrl;
  }
}

module.exports = new GoogleSheetsService();
