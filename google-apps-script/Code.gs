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
 *
 * IMPORTANTE: Después de agregar doPost(), debes crear una NUEVA implementación
 * (no editar la existente) para que los cambios surtan efecto.
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

/**
 * doPost - Escritura en Google Sheets desde el admin LEKER
 *
 * Payload esperado:
 * {
 *   action: "updateAddress",
 *   rows: [
 *     { code: "123456", address: "Av. Nueva 123", commune: "Providencia", updatedBy: "admin@leker.cl", updatedAt: "2026-02-25T17:00:00Z" }
 *   ]
 * }
 *
 * Respuesta:
 * { success: true, updated: 1, notFound: ["999"], errors: [] }
 */
function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);
    var action = body.action;

    if (action === 'updateAddress') {
      return handleUpdateAddress(body.rows || []);
    }

    return ContentService.createTextOutput(JSON.stringify({
      error: 'Acción no reconocida: ' + action
    })).setMimeType(ContentService.MimeType.JSON);

  } catch (error) {
    return ContentService.createTextOutput(JSON.stringify({
      error: error.message
    })).setMimeType(ContentService.MimeType.JSON);
  }
}

/**
 * Actualiza direcciones en la hoja "Direcciones" buscando por código de cliente
 */
function handleUpdateAddress(rows) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('Direcciones');

  if (!sheet) {
    return ContentService.createTextOutput(JSON.stringify({
      error: 'Hoja "Direcciones" no encontrada'
    })).setMimeType(ContentService.MimeType.JSON);
  }

  var lastRow = sheet.getLastRow();
  var lastCol = sheet.getLastColumn();
  if (lastRow < 2) {
    return ContentService.createTextOutput(JSON.stringify({
      error: 'La hoja "Direcciones" está vacía'
    })).setMimeType(ContentService.MimeType.JSON);
  }

  // Read headers to find column indices
  var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  var codeCol = findColumnIndex(headers, ['cod cliente', 'codigo', 'código', 'cod_cliente', 'code']);
  var addressCol = findColumnIndex(headers, ['direccion', 'dirección', 'address', 'dir']);
  var communeCol = findColumnIndex(headers, ['comuna', 'commune']);
  var geoLinkCol = findColumnIndex(headers, ['link georeferencia', 'link geo', 'georeferencia', 'geo link']);

  if (codeCol === -1) {
    return ContentService.createTextOutput(JSON.stringify({
      error: 'No se encontró columna de código de cliente en la hoja Direcciones'
    })).setMimeType(ContentService.MimeType.JSON);
  }

  // Ensure geo link column exists
  if (geoLinkCol === -1) {
    geoLinkCol = lastCol;
    sheet.getRange(1, geoLinkCol + 1).setValue('Link Georeferencia');
    lastCol++;
  }

  // Ensure audit columns exist, add them if not
  var auditByCol = findColumnIndex(headers, ['modificado por', 'updated by', 'modificado_por']);
  var auditAtCol = findColumnIndex(headers, ['última modificación', 'ultima modificacion', 'updated at', 'fecha modificación']);

  if (auditByCol === -1) {
    auditByCol = lastCol; // 0-indexed → next column
    sheet.getRange(1, auditByCol + 1).setValue('Modificado por');
    lastCol++;
  }
  if (auditAtCol === -1) {
    auditAtCol = lastCol;
    sheet.getRange(1, auditAtCol + 1).setValue('Última modificación');
    lastCol++;
  }

  // Read all code values for lookup
  var codeValues = sheet.getRange(2, codeCol + 1, lastRow - 1, 1).getValues();

  var updated = 0;
  var notFound = [];
  var errors = [];

  rows.forEach(function(row) {
    try {
      var targetCode = String(row.code).trim();
      var rowIndex = -1;

      // Find the row with matching code
      for (var i = 0; i < codeValues.length; i++) {
        if (String(codeValues[i][0]).trim() === targetCode) {
          rowIndex = i + 2; // +2 because data starts at row 2, array is 0-indexed
          break;
        }
      }

      if (rowIndex === -1) {
        notFound.push(targetCode);
        return;
      }

      // Update address
      if (row.address && addressCol !== -1) {
        sheet.getRange(rowIndex, addressCol + 1).setValue(row.address);
      }

      // Update commune
      if (row.commune && communeCol !== -1) {
        sheet.getRange(rowIndex, communeCol + 1).setValue(row.commune);
      }

      // Update geo link
      if (row.geoLink && geoLinkCol !== -1) {
        sheet.getRange(rowIndex, geoLinkCol + 1).setValue(row.geoLink);
      }

      // Update audit columns
      sheet.getRange(rowIndex, auditByCol + 1).setValue(row.updatedBy || 'sistema');
      sheet.getRange(rowIndex, auditAtCol + 1).setValue(row.updatedAt || new Date().toISOString());

      updated++;
    } catch (rowError) {
      errors.push({ code: row.code, error: rowError.message });
    }
  });

  return ContentService.createTextOutput(JSON.stringify({
    success: true,
    updated: updated,
    notFound: notFound,
    errors: errors
  })).setMimeType(ContentService.MimeType.JSON);
}

/**
 * Busca el índice de una columna por posibles nombres (case-insensitive)
 */
function findColumnIndex(headers, possibleNames) {
  for (var i = 0; i < headers.length; i++) {
    var headerLower = String(headers[i]).toLowerCase().trim();
    for (var j = 0; j < possibleNames.length; j++) {
      if (headerLower === possibleNames[j]) {
        return i;
      }
    }
  }
  return -1;
}
