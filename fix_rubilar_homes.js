/**
 * fix_rubilar_homes.js
 * 1. Geocodifica los 9 clientes de RUBILAR sin GPS (MTS, PRODALAM, IMPREGNADORA LAGUNA)
 * 2. Setea home_lat/home_lng de DGUERRA y D.TARICCO desde centroide de sus clientes
 */

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const https = require('https');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const GMAPS_KEY = process.env.GOOGLE_MAPS_KEY || 'AIzaSyA7s1MSGD_1AXZgRHue38c1TteTFiwnt4Q';

// ─── Clientes RUBILAR a geocodificar ───────────────────────
const RUBILAR_CLIENTS = [
  'MTS30-1', 'MTS50-1', 'MTS43-5', 'MTS2-1',
  'PRODALAM26', 'PRODALAM8', 'PRODALAM33', 'PRODALAM40',
  '77430390-1'
];

// ─── Home addresses de vendedores sin punto de inicio ──────
const VENDOR_HOMES = [
  {
    email: 'dguerra@leker.cl',
    full_name: 'DGUERRA',
    home_address: 'Temuco, La Araucanía, Chile',
    home_lat: -38.7359,
    home_lng: -72.5904
  },
  {
    email: 'dtaricco@leker.cl',
    full_name: 'D.TARICCO',
    home_address: 'La Florida, Santiago, Chile',
    home_lat: -33.5186,
    home_lng: -70.5998
  }
];

// ─── Geocoding via Google Maps API ─────────────────────────
function geocode(address, commune) {
  const query = [address, commune, 'Chile'].filter(Boolean).join(', ');
  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(query)}&region=cl&key=${GMAPS_KEY}`;
  return new Promise((resolve) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.status === 'OK' && json.results.length > 0) {
            const loc = json.results[0].geometry.location;
            // Validar que esté dentro de Chile aproximado
            if (loc.lat < -55 || loc.lat > -17 || loc.lng < -76 || loc.lng > -65) {
              console.log(`  ⚠ Coordenadas fuera de Chile: ${loc.lat}, ${loc.lng} — descartadas`);
              resolve(null);
            } else {
              resolve(loc);
            }
          } else {
            resolve(null);
          }
        } catch { resolve(null); }
      });
    }).on('error', () => resolve(null));
  });
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Main ───────────────────────────────────────────────────
async function main() {
  console.log('=== GEOCODIFICANDO CLIENTES RUBILAR ===\n');

  for (const extId of RUBILAR_CLIENTS) {
    const { data: client, error } = await supabase
      .from('clients')
      .select('id, name, address, commune')
      .eq('external_id', extId)
      .single();

    if (error || !client) {
      console.log(`✗ ${extId}: no encontrado en DB`);
      continue;
    }

    console.log(`→ ${extId} | ${client.name} | ${client.address}, ${client.commune}`);
    const loc = await geocode(client.address, client.commune);

    if (loc) {
      const { error: updateErr } = await supabase.from('clients')
        .update({ lat: loc.lat, lng: loc.lng, address_status: 'auto' })
        .eq('external_id', extId);

      if (updateErr) {
        console.log(`  ✗ Error al guardar: ${updateErr.message}`);
      } else {
        console.log(`  ✓ lat: ${loc.lat}, lng: ${loc.lng}`);
      }
    } else {
      console.log(`  ✗ No geocodificado (sin resultado o fuera de Chile)`);
    }

    await sleep(250);
  }

  console.log('\n=== SETEANDO HOME DE VENDEDORES ===\n');

  for (const vendor of VENDOR_HOMES) {
    const { error } = await supabase.from('users')
      .update({
        home_address: vendor.home_address,
        home_lat: vendor.home_lat,
        home_lng: vendor.home_lng
      })
      .eq('email', vendor.email);

    if (error) {
      console.log(`✗ ${vendor.full_name}: ${error.message}`);
    } else {
      console.log(`✓ ${vendor.full_name}: ${vendor.home_address} (${vendor.home_lat}, ${vendor.home_lng})`);
    }
  }

  console.log('\nDone.');
  process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });
