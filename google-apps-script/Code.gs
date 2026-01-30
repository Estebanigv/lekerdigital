/**
 * Google Apps Script - API para Google Sheets de LEKER
 *
 * INSTRUCCIONES DE DEPLOY:
 * 1. Abre el Google Sheet (ID: 1W8yim9i13YN3lUx0saEkVplT0MhJm8XYwZKhyK_nzvI)
 * 2. Ve a Extensiones > Apps Script
 * 3. Pega este código en Code.gs
 * 4. Despliega: Implementar > Nueva implementación
 *    - Tipo: Aplicación web
 *    - Ejecutar como: Yo
 *    - Quién tiene acceso: Cualquier persona
 * 5. Copia la URL del deployment y agrégala al .env:
 *    GOOGLE_SHEETS_SCRIPT_URL=https://script.google.com/macros/s/DEPLOYMENT_ID/exec
 */

function doGet(e) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheetParam = e && e.parameter && e.parameter.sheet;

    if (!sheetParam) {
      // Return metadata
      var sheets = ss.getSheets();
      var meta = sheets.map(function(s) {
        return {
          name: s.getName(),
          rows: s.getLastRow(),
          cols: s.getLastColumn()
        };
      });
      return ContentService.createTextOutput(JSON.stringify(meta))
        .setMimeType(ContentService.MimeType.JSON);
    }

    if (sheetParam === 'all') {
      // Return all sheets data
      var sheets = ss.getSheets();
      var result = {};
      sheets.forEach(function(s) {
        var name = s.getName();
        var lastRow = s.getLastRow();
        var lastCol = s.getLastColumn();
        if (lastRow > 0 && lastCol > 0) {
          result[name] = s.getRange(1, 1, lastRow, lastCol).getDisplayValues();
        } else {
          result[name] = [];
        }
      });
      return ContentService.createTextOutput(JSON.stringify(result))
        .setMimeType(ContentService.MimeType.JSON);
    }

    // Return specific sheet
    var sheet = ss.getSheetByName(sheetParam);
    if (!sheet) {
      return ContentService.createTextOutput(JSON.stringify({
        error: 'Hoja no encontrada: ' + sheetParam
      })).setMimeType(ContentService.MimeType.JSON);
    }

    var lastRow = sheet.getLastRow();
    var lastCol = sheet.getLastColumn();
    var data = [];
    if (lastRow > 0 && lastCol > 0) {
      data = sheet.getRange(1, 1, lastRow, lastCol).getDisplayValues();
    }

    return ContentService.createTextOutput(JSON.stringify(data))
      .setMimeType(ContentService.MimeType.JSON);

  } catch (error) {
    return ContentService.createTextOutput(JSON.stringify({
      error: error.message
    })).setMimeType(ContentService.MimeType.JSON);
  }
}
