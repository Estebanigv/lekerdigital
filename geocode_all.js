/**
 * geocode_all.js
 * Geocodifica todos los clientes con dirección pero sin lat/lng
 * Uso: node geocode_all.js
 */

require('dotenv').config();
const https = require('https');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const GOOGLE_KEY = 'AIzaSyA7s1MSGD_1AXZgRHue38c1TteTFiwnt4Q';
const DELAY_MS  = 120;   // ~8 req/seg (límite Google: 50/seg, usamos 8 para ser conservadores)
const BATCH_LOG = 25;    // Mostrar progreso cada N clientes

// Bounds Chile
const inChile = (lat, lng) => lat >= -56 && lat <= -17 && lng >= -76 && lng <= -66;

function geocode(address) {
  return new Promise((resolve, reject) => {
    const encoded = encodeURIComponent(address);
    const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encoded}&key=${GOOGLE_KEY}&region=cl&language=es`;
    https.get(url, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.status === 'OK' && json.results[0]) {
            const loc = json.results[0].geometry.location;
            if (inChile(loc.lat, loc.lng)) {
              resolve({ lat: loc.lat, lng: loc.lng });
            } else {
              reject('OUTSIDE_CHILE');
            }
          } else if (json.status === 'OVER_QUERY_LIMIT') {
            reject('RATE_LIMIT');
          } else {
            reject(json.status || 'NO_RESULTS');
          }
        } catch (e) {
          reject('PARSE_ERROR');
        }
      });
    }).on('error', err => reject(err.message));
  });
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function getAllClientsBatch(from, size) {
  const { data, error } = await supabase
    .from('clients')
    .select('id, name, fantasy_name, external_id, address, commune, city, region, geo_link')
    .is('lat', null)
    .is('lng', null)
    .not('address', 'is', null)
    .range(from, from + size - 1)
    .order('id');
  if (error) throw error;
  return data || [];
}

function extractCoordsFromGeoLink(geoLink) {
  if (!geoLink) return null;
  const m = geoLink.match(/[?&]q=(-?\d+\.?\d*),(-?\d+\.?\d*)/);
  if (!m) return null;
  const lat = parseFloat(m[1]), lng = parseFloat(m[2]);
  return inChile(lat, lng) ? { lat, lng } : null;
}

async function updateClient(id, lat, lng) {
  const { error } = await supabase
    .from('clients')
    .update({ lat, lng })
    .eq('id', id);
  if (error) throw error;
}

async function run() {
  // Contar total pendientes
  const { count } = await supabase
    .from('clients')
    .select('id', { count: 'exact', head: true })
    .is('lat', null)
    .is('lng', null)
    .not('address', 'is', null);

  console.log(`\n🗺  GEOCODIFICACIÓN MASIVA — LEKER`);
  console.log(`📦  Clientes pendientes: ${count}`);
  console.log(`⏱   Tiempo estimado: ~${Math.round(count * DELAY_MS / 1000 / 60)} minutos\n`);

  let success = 0, errors = 0, outside = 0, processed = 0;
  const BATCH = 200;
  let from = 0;

  while (true) {
    const clients = await getAllClientsBatch(from, BATCH);
    if (clients.length === 0) break;

    for (const client of clients) {
      processed++;
      const name = client.fantasy_name || client.name || client.external_id;

      try {
        let loc = null;

        // 1) Intentar extraer coordenadas exactas del geo_link
        loc = extractCoordsFromGeoLink(client.geo_link);

        // 2) Si no hay coords en geo_link, geocodificar con dirección completa
        if (!loc) {
          const parts = [];
          if (client.address) parts.push(client.address);
          if (client.commune) parts.push(client.commune);
          if (client.city && client.city !== client.commune) parts.push(client.city);
          if (client.region) parts.push(client.region);
          parts.push('Chile');
          const address = parts.join(', ');

          let retries = 0;
          while (retries < 3) {
            try {
              loc = await geocode(address);
              break;
            } catch (e) {
              if (e === 'RATE_LIMIT') {
                console.log(`  ⏳ Rate limit — esperando 5s...`);
                await sleep(5000);
                retries++;
              } else {
                throw e;
              }
            }
          }
          if (!loc) throw new Error('RATE_LIMIT_EXHAUSTED');
        }

        await updateClient(client.id, loc.lat, loc.lng);
        success++;
        if (success % BATCH_LOG === 0) {
          const pct = Math.round(processed / count * 100);
          console.log(`  ✅ [${pct}%] ${processed}/${count} — ${success} OK, ${errors} errores`);
        }

      } catch (e) {
        if (e === 'OUTSIDE_CHILE') outside++;
        else errors++;
        if (errors <= 10 || errors % 100 === 0) {
          console.log(`  ❌ ${name} — ${e}`);
        }
      }

      await sleep(DELAY_MS);
    }

    // Siguiente batch: siempre desde 0 porque ya actualizamos lat/lng (ya no son null)
    from = 0;
  }

  console.log(`\n✅ COMPLETADO`);
  console.log(`   Geocodificados: ${success}`);
  console.log(`   Fuera de Chile: ${outside}`);
  console.log(`   Sin resultado:  ${errors}`);
  console.log(`   Total procesado: ${processed}\n`);
}

run().catch(err => {
  console.error('Error fatal:', err);
  process.exit(1);
});
