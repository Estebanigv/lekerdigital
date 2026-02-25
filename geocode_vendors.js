/**
 * Script para geocodificar las direcciones de los vendedores y guardarlas en Supabase
 * Uso: node geocode_vendors.js
 * Requiere: .env con SUPABASE_URL, SUPABASE_SERVICE_KEY
 */
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const GOOGLE_API_KEY = 'AIzaSyA7s1MSGD_1AXZgRHue38c1TteTFiwnt4Q';

const vendorAddresses = [
  { email: 'fbustos@leker.cl', address: 'Calle Nonguen 577, Concepción, Chile' },
  { email: 'ecaceres@leker.cl', address: 'Pasaje Bernardo Leyton Guzmán 3048, Macul, Chile' },
  { email: 'eibarra@leker.cl', address: 'Colbún 2333, San Bernardo, Chile' },
  { email: 'ycarrero@leker.cl', address: '13 Oriente B 2890, Talca, Chile' },
  { email: 'jrubilar@leker.cl', address: 'Pasaje Gamacruz 27, Los Andes, Chile' },
  { email: 'mgarcia@leker.cl', address: 'Av Ossa 971, La Reina, Santiago, Chile' },
  { email: 'marroyo@leker.cl', address: 'Av. Javiera Carrera 1176, Temuco, Chile' },
  { email: 'dalmerida@leker.cl', address: 'Los Carrera 1658, Concepción, Chile' },
  { email: 'msilva@leker.cl', address: 'Marta Colvin 2000, Puerto Montt, Chile' },
  { email: 'arehbein@leker.cl', address: 'Pasaje 2 404, Parque Industrial, Puerto Montt, Chile' },
  { email: 'esagredo@leker.cl', address: 'Avenida Argentina 448, Chillán, Chile' },
  { email: 'lcanepa@leker.cl', address: 'Vía Florentina 1839, Puerto Montt, Chile' },
];

async function geocode(address) {
  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${GOOGLE_API_KEY}&region=cl`;
  const res = await fetch(url);
  const data = await res.json();
  if (data.status === 'OK' && data.results.length > 0) {
    const loc = data.results[0].geometry.location;
    return { lat: loc.lat, lng: loc.lng, formatted: data.results[0].formatted_address };
  }
  return null;
}

async function main() {
  console.log('Geocodificando direcciones de vendedores...\n');

  let updated = 0;
  let failed = 0;

  for (const vendor of vendorAddresses) {
    process.stdout.write(`${vendor.email}: `);

    const geo = await geocode(vendor.address);
    if (!geo) {
      console.log('FALLÓ geocoding');
      failed++;
      continue;
    }

    console.log(`${geo.lat.toFixed(5)}, ${geo.lng.toFixed(5)} — ${geo.formatted}`);

    // Update in Supabase
    const { error } = await supabase
      .from('users')
      .update({
        home_address: vendor.address.replace(', Chile', ''),
        home_lat: geo.lat,
        home_lng: geo.lng
      })
      .eq('email', vendor.email);

    if (error) {
      console.log(`  ERROR DB: ${error.message}`);
      failed++;
    } else {
      updated++;
    }

    // Small delay to avoid rate limit
    await new Promise(r => setTimeout(r, 200));
  }

  console.log(`\nResultado: ${updated} actualizados, ${failed} fallidos`);
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
