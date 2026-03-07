/**
 * Google Sheets Integration Service
 * Conecta directamente con Google Sheets API v4 usando Service Account
 * Reemplaza el Google Apps Script anterior — sync confiable en ambas direcciones
 */
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

class GoogleSheetsService {

  get spreadsheetId() {
    return process.env.GOOGLE_SHEETS_SPREADSHEET_ID || '';
  }

  get credentialsPath() {
    const p = process.env.GOOGLE_SHEETS_CREDENTIALS_PATH || '';
    if (!p) return '';
    return path.isAbsolute(p) ? p : path.resolve(process.cwd(), p);
  }

  get clientSheetName() {
    return process.env.GOOGLE_SHEETS_CLIENT_TAB || 'Direccion';
  }

  isConfigured() {
    if (!this.spreadsheetId) return false;
    // Prioridad 1: JSON directo en env var (Vercel / producción)
    if (process.env.GOOGLE_SHEETS_CREDENTIALS_JSON) return true;
    // Prioridad 2: archivo local (desarrollo)
    if (!this.credentialsPath) return false;
    try { return fs.existsSync(this.credentialsPath); } catch (_) { return false; }
  }

  _getCredentials() {
    // Prioridad 1: env var con JSON (Vercel)
    if (process.env.GOOGLE_SHEETS_CREDENTIALS_JSON) {
      return JSON.parse(process.env.GOOGLE_SHEETS_CREDENTIALS_JSON);
    }
    // Prioridad 2: archivo local
    return JSON.parse(fs.readFileSync(this.credentialsPath, 'utf8'));
  }

  _getAuth() {
    return new google.auth.GoogleAuth({
      credentials: this._getCredentials(),
      scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });
  }

  async _sheets() {
    const auth = this._getAuth();
    return google.sheets({ version: 'v4', auth });
  }

  buildMapsSearchUrl(address, commune) {
    const parts = [address, commune, 'Chile'].filter(Boolean);
    const query = parts.join(', ').replace(/\s+/g, ' ').trim();
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
  }

  // Convierte número de columna (1-based) a letra: 1→A, 27→AA
  _colLetter(n) {
    let result = '';
    while (n > 0) {
      n--;
      result = String.fromCharCode(65 + (n % 26)) + result;
      n = Math.floor(n / 26);
    }
    return result;
  }

  // ─────────────────────────────────────────────
  // LECTURA
  // ─────────────────────────────────────────────

  /**
   * Obtiene metadata del spreadsheet (nombres de hojas, filas, columnas)
   */
  async getMetadata() {
    if (!this.isConfigured()) throw new Error('Google Sheets no configurado');
    const sheets = await this._sheets();
    const res = await sheets.spreadsheets.get({ spreadsheetId: this.spreadsheetId });
    return {
      sheets: res.data.sheets.map(s => ({
        name: s.properties.title,
        rowCount: s.properties.gridProperties.rowCount,
        colCount: s.properties.gridProperties.columnCount
      }))
    };
  }

  /**
   * Obtiene datos de todas las hojas
   * Retorna objeto { sheetName: [[rows]], ... }
   */
  async getAllSheets() {
    if (!this.isConfigured()) throw new Error('Google Sheets no configurado');
    const sheets = await this._sheets();

    const meta = await sheets.spreadsheets.get({ spreadsheetId: this.spreadsheetId });
    const sheetNames = meta.data.sheets.map(s => s.properties.title);

    // Fetch todas las hojas en PARALELO para máxima velocidad
    const entries = await Promise.all(
      sheetNames.map(async name => {
        try {
          const r = await sheets.spreadsheets.values.get({
            spreadsheetId: this.spreadsheetId,
            range: name
          });
          return [name, r.data.values || []];
        } catch (_) {
          return [name, []];
        }
      })
    );

    return Object.fromEntries(entries);
  }

  /**
   * Obtiene datos de una hoja específica
   * Retorna [[row1], [row2], ...]
   */
  async getSheet(sheetName) {
    if (!this.isConfigured()) throw new Error('Google Sheets no configurado');
    const sheets = await this._sheets();
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: this.spreadsheetId,
      range: sheetName
    });
    return res.data.values || [];
  }

  // ─────────────────────────────────────────────
  // HELPERS INTERNOS
  // ─────────────────────────────────────────────

  /**
   * Encuentra la fila (1-based) de un cliente por su código
   * Retorna { rowIndex, headers, codeCol }
   * rowIndex = -1 si no se encuentra
   */
  async _findClientRow(sheets, sheetName, externalId) {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: this.spreadsheetId,
      range: sheetName
    });
    const rows = res.data.values || [];
    if (rows.length === 0) return { rowIndex: -1, headers: [], codeCol: -1 };

    const norm = s => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const headers = rows[0].map(h => String(h || '').trim().toLowerCase());
    const codeCol = headers.findIndex(h => norm(h).includes('cod'));
    if (codeCol === -1) return { rowIndex: -1, headers, codeCol: -1 };

    const target = String(externalId || '').trim();
    for (let i = 1; i < rows.length; i++) {
      if (String(rows[i][codeCol] || '').trim() === target) {
        return { rowIndex: i + 1, headers, codeCol };  // rowIndex es 1-based
      }
    }
    return { rowIndex: -1, headers, codeCol };
  }

  /**
   * Determina el índice de columna para un campo dado los headers
   * Soporta múltiples patrones por campo
   */
  _getColIndex(headers, patterns) {
    // Normaliza acentos para comparar: 'región' == 'region'
    const norm = s => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    return headers.findIndex(h => patterns.some(p => norm(h).includes(norm(p))));
  }

  // ─────────────────────────────────────────────
  // ESCRITURA
  // ─────────────────────────────────────────────

  /**
   * Sincroniza un cliente completo al Google Sheet.
   * Si existe → actualiza solo los campos provistos (no sobreescribe con vacíos).
   * Si no existe → retorna { notFound: [code] } para que el caller decida crear.
   */
  async syncClientToSheet(client, updatedBy) {
    if (!client.external_id) return { success: false, error: 'Sin código de cliente' };
    if (!this.isConfigured()) {
      console.warn('[GSheets] No configurado — sync omitido');
      return { success: false, error: 'Google Sheets no configurado' };
    }

    try {
      const sheets = await this._sheets();
      const sheetName = this.clientSheetName;
      const { rowIndex, headers } = await this._findClientRow(sheets, sheetName, client.external_id);

      if (rowIndex === -1) {
        return { success: true, updated: 0, notFound: [client.external_id] };
      }

      // Construir geo link
      let geoLink = client.geo_link || '';
      if (!geoLink && client.lat && client.lng) {
        geoLink = `https://www.google.com/maps?q=${client.lat},${client.lng}`;
      } else if (!geoLink && client.address) {
        geoLink = this.buildMapsSearchUrl(client.address, client.commune);
      }

      // Mapa de patrones de header → valor a escribir
      // Solo se incluyen campos no-nulos/no-vacíos para no sobreescribir con blancos
      // _newExternalId: si el código cambió, actualizar también la columna código
      const fieldPatterns = [
        { patterns: ['cod'],                          value: client._newExternalId || null },
        { patterns: ['raz'],                          value: client.name },
        { patterns: ['fan'],                          value: client.fantasy_name },
        { patterns: ['direcc', 'address'],            value: client.address },
        { patterns: ['comun'],                        value: client.commune },
        { patterns: ['ciudad', 'city'],               value: client.city },
        { patterns: ['region', 'región'],             value: client.region },
        { patterns: ['link', 'geo'],                  value: geoLink || null },
      ];

      const updates = [];
      const usedCols = new Set();

      for (const { patterns, value } of fieldPatterns) {
        if (value === null || value === undefined || value === '') continue;
        const colIdx = this._getColIndex(headers, patterns);
        if (colIdx === -1 || usedCols.has(colIdx)) continue;
        usedCols.add(colIdx);
        updates.push({
          range: `${sheetName}!${this._colLetter(colIdx + 1)}${rowIndex}`,
          values: [[value]]
        });
      }

      if (updates.length > 0) {
        await sheets.spreadsheets.values.batchUpdate({
          spreadsheetId: this.spreadsheetId,
          requestBody: { valueInputOption: 'RAW', data: updates }
        });
      }

      console.log(`[GSheets] syncClientToSheet(${client.external_id}) → updated ${updates.length} cols en fila ${rowIndex}`);
      return { success: true, updated: 1 };

    } catch (error) {
      console.error('[GSheets] syncClientToSheet error:', error.message);
      return { success: false, error: error.message };
    }
  }

  /**
   * Sincroniza solo la dirección de un cliente al Sheet
   */
  async syncAddressToSheet(externalId, address, commune, updatedBy, geoLink) {
    if (!externalId) return { success: false, error: 'Sin código de cliente' };
    const autoGeoLink = geoLink || (address ? this.buildMapsSearchUrl(address, commune) : '');
    return this.syncClientToSheet({
      external_id: externalId,
      address: address || null,
      commune: commune || null,
      geo_link: autoGeoLink || null
    }, updatedBy);
  }

  /**
   * Crea un nuevo cliente como nueva fila en el Sheet
   */
  async createClientInSheet(client) {
    if (!client.external_id) return { success: false, error: 'Sin código de cliente' };
    if (!this.isConfigured()) return { success: false, error: 'Google Sheets no configurado' };

    try {
      const sheets = await this._sheets();
      const sheetName = this.clientSheetName;

      // Leer headers para saber el orden de columnas
      const headerRes = await sheets.spreadsheets.values.get({
        spreadsheetId: this.spreadsheetId,
        range: `${sheetName}!1:1`
      });
      const headers = (headerRes.data.values || [[]])[0].map(h => String(h || '').trim().toLowerCase());

      let geoLink = client.geo_link || '';
      if (!geoLink && client.lat && client.lng) {
        geoLink = `https://www.google.com/maps?q=${client.lat},${client.lng}`;
      }

      const fieldPatterns = [
        { patterns: ['cod'],                          value: client.external_id },
        { patterns: ['raz'],                          value: client.name || '' },
        { patterns: ['fan'],                          value: client.fantasy_name || '' },
        { patterns: ['direcc', 'address'],            value: client.address || '' },
        { patterns: ['comun'],                        value: client.commune || '' },
        { patterns: ['ciudad', 'city'],               value: client.city || '' },
        { patterns: ['region', 'región'],             value: client.region || '' },
        { patterns: ['link', 'geo'],                  value: geoLink },
      ];

      // Construir fila respetando el orden de columnas del sheet
      const usedCols = new Set();
      const newRow = headers.map((h, i) => {
        if (usedCols.has(i)) return '';
        const match = fieldPatterns.find(fp => fp.patterns.some(p => h.includes(p)));
        if (match) { usedCols.add(i); return match.value || ''; }
        return '';
      });

      await sheets.spreadsheets.values.append({
        spreadsheetId: this.spreadsheetId,
        range: sheetName,
        valueInputOption: 'RAW',
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values: [newRow] }
      });

      console.log(`[GSheets] createClientInSheet(${client.external_id}) → fila creada`);
      return { success: true, created: 1 };

    } catch (error) {
      console.error('[GSheets] createClientInSheet error:', error.message);
      return { success: false, error: error.message };
    }
  }

  /**
   * Elimina la fila de un cliente del Sheet
   */
  async deleteClientFromSheet(externalId) {
    if (!externalId) return { success: false, error: 'Sin código de cliente' };
    if (!this.isConfigured()) return { success: false, error: 'Google Sheets no configurado' };

    try {
      const sheets = await this._sheets();
      const sheetName = this.clientSheetName;
      const { rowIndex } = await this._findClientRow(sheets, sheetName, externalId);

      if (rowIndex === -1) {
        console.warn(`[GSheets] deleteClientFromSheet(${externalId}) → no encontrado en Sheet`);
        return { success: true, deleted: 0, notFound: [externalId] };
      }

      // Obtener sheetId numérico para la operación batchUpdate
      const meta = await sheets.spreadsheets.get({ spreadsheetId: this.spreadsheetId });
      const sheet = meta.data.sheets.find(s => s.properties.title === sheetName);
      if (!sheet) return { success: false, error: `Hoja "${sheetName}" no encontrada` };

      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: this.spreadsheetId,
        requestBody: {
          requests: [{
            deleteDimension: {
              range: {
                sheetId: sheet.properties.sheetId,
                dimension: 'ROWS',
                startIndex: rowIndex - 1,  // 0-based (inclusive)
                endIndex: rowIndex          // 0-based (exclusive)
              }
            }
          }]
        }
      });

      console.log(`[GSheets] deleteClientFromSheet(${externalId}) → fila ${rowIndex} eliminada`);
      return { success: true, deleted: 1 };

    } catch (error) {
      console.error('[GSheets] deleteClientFromSheet error:', error.message);
      return { success: false, error: error.message };
    }
  }

  // ─────────────────────────────────────────────
  // COMPATIBILIDAD (ya no se usa Apps Script)
  // ─────────────────────────────────────────────

  updateConfig() { /* no-op */ }

  async postToSheet() {
    return { success: false, error: 'postToSheet deprecated — usando Service Account API directa' };
  }
}

module.exports = new GoogleSheetsService();
