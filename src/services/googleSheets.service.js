/**
 * Google Sheets Integration Service
 * Conecta con Google Apps Script para leer datos del Google Sheet de LEKER
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
   */
  makeRequest(url, maxRedirects = 5) {
    return new Promise((resolve, reject) => {
      if (maxRedirects <= 0) {
        return reject(new Error('Demasiados redirects'));
      }

      const urlObj = new URL(url);
      const options = {
        hostname: urlObj.hostname,
        port: 443,
        path: urlObj.pathname + urlObj.search,
        method: 'GET',
        headers: {
          'Accept': 'application/json'
        },
        timeout: 30000
      };

      const req = https.request(options, (res) => {
        // Handle redirects (Apps Script always returns 302)
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return this.makeRequest(res.headers.location, maxRedirects - 1)
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
   * Actualiza la URL en runtime
   */
  updateConfig(scriptUrl) {
    if (scriptUrl) this.scriptUrl = scriptUrl;
  }
}

module.exports = new GoogleSheetsService();
