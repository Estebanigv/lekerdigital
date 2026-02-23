const { supabase } = require('../../config/database');

// =============================================
// CONFIGURACIÓN DE VEHÍCULO ESTÁNDAR
// =============================================
let VEHICLE_CONFIG = {
  FUEL_EFFICIENCY_KML: 10,        // 10 km por litro (vehículo estándar)
  FUEL_PRICE_CLP: 1141,           // Precio bencina 93 octanos Chile (CLP/litro)
  FUEL_TYPE: '93 octanos'
};

// =============================================
// FUNCIONES DE CÁLCULO DE DISTANCIA
// =============================================

// Calcula distancia entre dos puntos usando fórmula Haversine (en km)
function haversineDistance(lat1, lng1, lat2, lng2) {
  const R = 6371; // Radio de la Tierra en km
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLng/2) * Math.sin(dLng/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
}

// Calcula distancia total de una ruta ordenada
function routeTotalDistance(route) {
  let total = 0;
  for (let i = 0; i < route.length - 1; i++) {
    total += haversineDistance(route[i].lat, route[i].lng, route[i + 1].lat, route[i + 1].lng);
  }
  return total;
}

// Algoritmo Nearest Neighbor para TSP (optimización de ruta)
function nearestNeighborTSP(clients, startPoint = null) {
  if (!clients || clients.length === 0) return { route: [], totalDistance: 0 };

  const validClients = clients.filter(c => c.lat && c.lng);
  if (validClients.length === 0) return { route: [], totalDistance: 0 };

  const unvisited = [...validClients];
  const route = [];
  let totalDistance = 0;

  let current = startPoint && startPoint.lat && startPoint.lng
    ? startPoint
    : unvisited.shift();

  if (!startPoint) {
    route.push(current);
  }

  while (unvisited.length > 0) {
    let nearestIdx = 0;
    let nearestDist = Infinity;

    for (let i = 0; i < unvisited.length; i++) {
      const dist = haversineDistance(
        current.lat, current.lng,
        unvisited[i].lat, unvisited[i].lng
      );
      if (dist < nearestDist) {
        nearestDist = dist;
        nearestIdx = i;
      }
    }

    totalDistance += nearestDist;
    current = unvisited.splice(nearestIdx, 1)[0];
    route.push(current);
  }

  if (route.length > 1 && startPoint) {
    totalDistance += haversineDistance(
      current.lat, current.lng,
      startPoint.lat, startPoint.lng
    );
  }

  return { route, totalDistance: Math.round(totalDistance * 10) / 10 };
}

// Mejora 2-opt sobre ruta existente: intercambia aristas para reducir distancia
function twoOptImprovement(route) {
  if (!route || route.length < 4) return route;

  let improved = true;
  let iterations = 0;
  const MAX_ITERATIONS = 100;
  let bestRoute = [...route];

  while (improved && iterations < MAX_ITERATIONS) {
    improved = false;
    iterations++;

    for (let i = 0; i < bestRoute.length - 2; i++) {
      for (let j = i + 2; j < bestRoute.length - 1; j++) {
        const a = bestRoute[i], b = bestRoute[i + 1];
        const c = bestRoute[j], d = bestRoute[j + 1];

        const currentDist = haversineDistance(a.lat, a.lng, b.lat, b.lng) +
                           haversineDistance(c.lat, c.lng, d.lat, d.lng);
        const newDist = haversineDistance(a.lat, a.lng, c.lat, c.lng) +
                       haversineDistance(b.lat, b.lng, d.lat, d.lng);

        if (newDist < currentDist - 0.001) {
          // Reverse segment between i+1 and j
          const segment = bestRoute.slice(i + 1, j + 1);
          segment.reverse();
          bestRoute.splice(i + 1, segment.length, ...segment);
          improved = true;
        }
      }
    }
  }

  return bestRoute;
}

// Nearest Neighbor + 2-opt improvement
function optimizeRouteOrder(clients, startPoint = null) {
  const nn = nearestNeighborTSP(clients, startPoint);
  if (nn.route.length < 4) return nn;

  const improvedRoute = twoOptImprovement(nn.route);
  const improvedDistance = routeTotalDistance(improvedRoute);

  return {
    route: improvedRoute,
    totalDistance: Math.round(improvedDistance * 10) / 10
  };
}

/**
 * Clustering geográfico por proximidad real (haversine).
 * Greedy seed-based: elige semillas por prioridad 80-20, crece cluster por cercanía
 * al centroide, y para cuando se agota el presupuesto de tiempo (480 min).
 */
function clusterClientsByProximity(clients) {
  const TIME_BUDGET_MIN = 540; // 9 horas (09:00 a 18:00)
  const SPEED_KMH = 40;
  const VISIT_DURATION_MIN = 60;
  const MAX_PER_CLUSTER = 9;

  if (!clients || clients.length === 0) return [];

  // Sort by priority: 80-20 first, then L, then N
  const priorityOrder = { '80-20': 0, 'L': 1, 'N': 2 };
  const sorted = [...clients].sort((a, b) => {
    const pa = priorityOrder[a.segmentation] ?? 2;
    const pb = priorityOrder[b.segmentation] ?? 2;
    return pa - pb;
  });

  const assigned = new Set();
  const clusters = [];

  // Helper: calculate cluster centroid
  function centroid(members) {
    let sumLat = 0, sumLng = 0;
    members.forEach(m => { sumLat += parseFloat(m.lat); sumLng += parseFloat(m.lng); });
    return { lat: sumLat / members.length, lng: sumLng / members.length };
  }

  // Helper: estimate total time for a cluster
  function clusterTime(members) {
    if (members.length <= 1) return members.length * VISIT_DURATION_MIN;
    const { totalDistance } = nearestNeighborTSP(members);
    const travelMin = (totalDistance / SPEED_KMH) * 60;
    return travelMin + members.length * VISIT_DURATION_MIN;
  }

  while (assigned.size < sorted.length) {
    // Pick seed: first unassigned 80-20, or most isolated unassigned client
    let seed = null;

    // Try 80-20 seeds first
    for (const c of sorted) {
      if (!assigned.has(c.id) && c.segmentation === '80-20' && c.lat && c.lng) {
        seed = c;
        break;
      }
    }

    // If no 80-20 left, pick most isolated unassigned client
    if (!seed) {
      let maxMinDist = -1;
      for (const c of sorted) {
        if (assigned.has(c.id) || !c.lat || !c.lng) continue;
        // Find distance to nearest assigned cluster centroid (or nearest other unassigned)
        let minDist = Infinity;
        for (const cluster of clusters) {
          const ctr = centroid(cluster);
          const d = haversineDistance(c.lat, c.lng, ctr.lat, ctr.lng);
          if (d < minDist) minDist = d;
        }
        if (minDist > maxMinDist || clusters.length === 0) {
          maxMinDist = minDist;
          seed = c;
        }
      }
    }

    if (!seed) break; // All remaining have no coords

    const cluster = [seed];
    assigned.add(seed.id);

    // Grow cluster: add nearest unassigned to centroid while within time budget
    while (cluster.length < MAX_PER_CLUSTER) {
      const ctr = centroid(cluster);
      let nearestClient = null;
      let nearestDist = Infinity;

      for (const c of sorted) {
        if (assigned.has(c.id) || !c.lat || !c.lng) continue;
        const d = haversineDistance(ctr.lat, ctr.lng, parseFloat(c.lat), parseFloat(c.lng));
        if (d < nearestDist) {
          nearestDist = d;
          nearestClient = c;
        }
      }

      if (!nearestClient) break;

      // Check if adding this client would exceed time budget
      const testCluster = [...cluster, nearestClient];
      const time = clusterTime(testCluster);
      if (time > TIME_BUDGET_MIN) break;

      cluster.push(nearestClient);
      assigned.add(nearestClient.id);
    }

    clusters.push(cluster);
  }

  // Also collect clients without GPS coords (assign to smallest cluster or new one)
  const noGps = sorted.filter(c => !assigned.has(c.id));
  if (noGps.length > 0) {
    for (const c of noGps) {
      // Add to the smallest cluster that has room
      let smallest = clusters.reduce((best, cl) =>
        cl.length < best.length ? cl : best, clusters[0]);
      if (smallest && smallest.length < MAX_PER_CLUSTER) {
        smallest.push(c);
      } else {
        clusters.push([c]);
      }
    }
  }

  return clusters;
}

// Calcula costo estimado de combustible
function calculateFuelCost(distanceKm, fuelEfficiency = VEHICLE_CONFIG.FUEL_EFFICIENCY_KML) {
  const litersUsed = distanceKm / fuelEfficiency;
  const cost = litersUsed * VEHICLE_CONFIG.FUEL_PRICE_CLP;
  return {
    distanceKm: Math.round(distanceKm * 10) / 10,
    litersUsed: Math.round(litersUsed * 100) / 100,
    costCLP: Math.round(cost),
    fuelEfficiency,
    fuelPriceCLP: VEHICLE_CONFIG.FUEL_PRICE_CLP,
    fuelType: VEHICLE_CONFIG.FUEL_TYPE
  };
}

class RoutesService {
  // =============================================
  // USUARIOS
  // =============================================

  async getAllUsers() {
    const { data, error } = await supabase
      .from('users')
      .select('*')
      .order('full_name');

    if (error) throw error;
    return data;
  }

  async createUser({ fullName, email, role = 'executive' }) {
    const { data, error } = await supabase
      .from('users')
      .insert([{
        full_name: fullName,
        email: email.toLowerCase(),
        role
      }])
      .select()
      .single();

    if (error) {
      if (error.code === '23505') throw new Error('Ya existe un usuario con ese email');
      throw error;
    }
    return data;
  }

  async deleteUser(userId) {
    const { data: activeRoutes } = await supabase
      .from('daily_routes')
      .select('id')
      .eq('user_id', userId)
      .eq('status', 'active');

    if (activeRoutes && activeRoutes.length > 0) {
      throw new Error('No se puede eliminar: tiene rutas activas');
    }

    const { error } = await supabase
      .from('users')
      .delete()
      .eq('id', userId);

    if (error) throw error;
    return true;
  }

  async updateUser(userId, userData) {
    const { id, created_at, email, ...updateData } = userData;

    // Map camelCase to snake_case if needed
    if (userData.fullName) {
      updateData.full_name = userData.fullName;
      delete updateData.fullName;
    }

    const { data, error } = await supabase
      .from('users')
      .update(updateData)
      .eq('id', userId)
      .select()
      .single();

    if (error) throw error;
    return data;
  }

  // =============================================
  // VEHÍCULOS
  // =============================================

  async getAllVehicles() {
    const { data, error } = await supabase
      .from('vehicles')
      .select('*')
      .order('license_plate');

    if (error) throw error;
    return data;
  }

  async createVehicle({ licensePlate, model, fuelEfficiency = 12 }) {
    const { data, error } = await supabase
      .from('vehicles')
      .insert([{
        license_plate: licensePlate.toUpperCase(),
        model,
        fuel_efficiency_kml: parseFloat(fuelEfficiency) || 12,
        status: 'active'
      }])
      .select()
      .single();

    if (error) {
      if (error.code === '23505') throw new Error('Ya existe un vehículo con esa patente');
      throw error;
    }
    return data;
  }

  async deleteVehicle(vehicleId) {
    const { data: inUse } = await supabase
      .from('daily_routes')
      .select('id')
      .eq('vehicle_id', vehicleId)
      .eq('status', 'active');

    if (inUse && inUse.length > 0) {
      throw new Error('No se puede eliminar: vehículo en uso');
    }

    const { error } = await supabase
      .from('vehicles')
      .delete()
      .eq('id', vehicleId);

    if (error) throw error;
    return true;
  }

  async updateVehicleStatus(vehicleId, status) {
    if (!['active', 'maintenance', 'inactive'].includes(status)) {
      throw new Error('Estado no válido');
    }

    const { data, error } = await supabase
      .from('vehicles')
      .update({ status })
      .eq('id', vehicleId)
      .select()
      .single();

    if (error) throw error;
    return data;
  }

  async updateVehicle(vehicleId, vehicleData) {
    const { id, created_at, ...updateData } = vehicleData;

    // Map camelCase to snake_case if needed
    if (vehicleData.fuelEfficiency !== undefined) {
      updateData.fuel_efficiency_kml = parseFloat(vehicleData.fuelEfficiency);
      delete updateData.fuelEfficiency;
    }
    if (vehicleData.licensePlate) {
      updateData.license_plate = vehicleData.licensePlate;
      delete updateData.licensePlate;
    }

    const { data, error } = await supabase
      .from('vehicles')
      .update(updateData)
      .eq('id', vehicleId)
      .select()
      .single();

    if (error) throw error;
    return data;
  }

  // =============================================
  // CLIENTES
  // =============================================

  async getAllClients() {
    // Get all clients using pagination to bypass Supabase default limit
    let allClients = [];
    let from = 0;
    const batchSize = 1000;
    let hasMore = true;

    while (hasMore) {
      let { data, error } = await supabase
        .from('clients')
        .select('*')
        .order('name')
        .range(from, from + batchSize - 1);

      if (error) throw error;

      if (data && data.length > 0) {
        allClients = allClients.concat(data);
        from += batchSize;
        hasMore = data.length === batchSize;
      } else {
        hasMore = false;
      }
    }

    return allClients;
  }

  async getClientCount() {
    const { count, error } = await supabase
      .from('clients')
      .select('*', { count: 'exact', head: true });

    if (error) throw error;
    return count;
  }

  async createClient(clientData) {
    const { data, error } = await supabase
      .from('clients')
      .insert([clientData])
      .select()
      .single();

    if (error) {
      if (error.code === '23505') throw new Error('Ya existe un cliente con ese código');
      throw error;
    }
    return data;
  }

  async updateClient(clientId, clientData) {
    // Remove id from update data if present
    const { id, created_at, ...updateData } = clientData;

    const { data, error } = await supabase
      .from('clients')
      .update(updateData)
      .eq('id', clientId)
      .select()
      .single();

    if (error) {
      if (error.code === '23505') throw new Error('Ya existe un cliente con ese código');
      throw error;
    }
    return data;
  }

  async reassignClients(fromUserId, toUserId) {
    // Count clients to reassign
    const { data: clients, error: countError } = await supabase
      .from('clients')
      .select('id')
      .eq('assigned_user_id', fromUserId);

    if (countError) throw countError;

    if (!clients || clients.length === 0) {
      throw new Error('El vendedor origen no tiene clientes asignados');
    }

    // Reassign all clients
    const { data, error } = await supabase
      .from('clients')
      .update({ assigned_user_id: toUserId })
      .eq('assigned_user_id', fromUserId)
      .select('id');

    if (error) throw error;

    return { updated: data.length, fromUserId, toUserId };
  }

  async deleteClient(clientId) {
    // Check if client has visits
    const { data: visits } = await supabase
      .from('visits')
      .select('id')
      .eq('client_id', clientId)
      .limit(1);

    if (visits && visits.length > 0) {
      throw new Error('No se puede eliminar: el cliente tiene visitas registradas');
    }

    const { error } = await supabase
      .from('clients')
      .delete()
      .eq('id', clientId);

    if (error) throw error;
    return true;
  }

  async upsertClients(clients) {
    const results = { inserted: 0, updated: 0, errors: [] };

    // Process in batches of 100
    const batchSize = 100;
    for (let i = 0; i < clients.length; i += batchSize) {
      const batch = clients.slice(i, i + batchSize);

      const { data, error } = await supabase
        .from('clients')
        .upsert(batch, {
          onConflict: 'external_id',
          ignoreDuplicates: false
        })
        .select();

      if (error) {
        results.errors.push({ batch: i / batchSize, error: error.message });
      } else {
        results.inserted += data ? data.length : 0;
      }
    }

    return results;
  }

  async upsertUsers(users) {
    const results = { inserted: 0, updated: 0, errors: [] };

    for (const user of users) {
      const { data, error } = await supabase
        .from('users')
        .upsert(user, {
          onConflict: 'email',
          ignoreDuplicates: false
        })
        .select()
        .single();

      if (error) {
        if (error.code === '23505') {
          results.updated++;
        } else {
          results.errors.push({ email: user.email, error: error.message });
        }
      } else {
        results.inserted++;
      }
    }

    return results;
  }

  async upsertVehicles(vehicles) {
    const results = { inserted: 0, updated: 0, errors: [] };

    for (const vehicle of vehicles) {
      const { data, error } = await supabase
        .from('vehicles')
        .upsert(vehicle, {
          onConflict: 'license_plate',
          ignoreDuplicates: false
        })
        .select()
        .single();

      if (error) {
        if (error.code === '23505') {
          results.updated++;
        } else {
          results.errors.push({ plate: vehicle.license_plate, error: error.message });
        }
      } else {
        results.inserted++;
      }
    }

    return results;
  }

  async replaceClients(clients) {
    // Delete all existing clients then insert new ones
    const { error: deleteError } = await supabase
      .from('clients')
      .delete()
      .neq('id', '00000000-0000-0000-0000-000000000000'); // Delete all

    if (deleteError) throw deleteError;

    return await this.upsertClients(clients);
  }

  async replaceUsers(users) {
    // Delete all users without active routes
    const { data: usersWithRoutes } = await supabase
      .from('daily_routes')
      .select('user_id')
      .eq('status', 'active');

    const activeUserIds = usersWithRoutes?.map(r => r.user_id) || [];

    // Only delete users that don't have active routes
    const { error: deleteError } = await supabase
      .from('users')
      .delete()
      .not('id', 'in', `(${activeUserIds.length > 0 ? activeUserIds.join(',') : '00000000-0000-0000-0000-000000000000'})`);

    if (deleteError && !deleteError.message.includes('empty')) {
      console.warn('Delete warning:', deleteError.message);
    }

    return await this.upsertUsers(users);
  }

  async replaceVehicles(vehicles) {
    // Delete all vehicles not in use
    const { data: vehiclesInUse } = await supabase
      .from('daily_routes')
      .select('vehicle_id')
      .eq('status', 'active');

    const activeVehicleIds = vehiclesInUse?.map(r => r.vehicle_id) || [];

    const { error: deleteError } = await supabase
      .from('vehicles')
      .delete()
      .not('id', 'in', `(${activeVehicleIds.length > 0 ? activeVehicleIds.join(',') : '00000000-0000-0000-0000-000000000000'})`);

    if (deleteError && !deleteError.message.includes('empty')) {
      console.warn('Delete warning:', deleteError.message);
    }

    return await this.upsertVehicles(vehicles);
  }

  // =============================================
  // RUTAS DIARIAS
  // =============================================

  async startDay({ userId, vehicleId, startKm }) {
    const { data: user, error: userError } = await supabase
      .from('users')
      .select('id, full_name')
      .eq('id', userId)
      .single();

    if (userError || !user) throw new Error('Usuario no encontrado');

    const { data: vehicle, error: vehicleError } = await supabase
      .from('vehicles')
      .select('id, license_plate')
      .eq('id', vehicleId)
      .eq('status', 'active')
      .single();

    if (vehicleError || !vehicle) throw new Error('Vehículo no encontrado o no activo');

    const today = new Date().toISOString().split('T')[0];
    const { data: existingRoute } = await supabase
      .from('daily_routes')
      .select('id')
      .eq('user_id', userId)
      .eq('date', today)
      .eq('status', 'active')
      .single();

    if (existingRoute) throw new Error('Ya existe una ruta activa para hoy');

    const { data: route, error: routeError } = await supabase
      .from('daily_routes')
      .insert([{
        user_id: userId,
        vehicle_id: vehicleId,
        date: today,
        start_km: startKm,
        status: 'active'
      }])
      .select()
      .single();

    if (routeError) throw routeError;

    return {
      route,
      user: { id: user.id, name: user.full_name },
      vehicle: { id: vehicle.id, plate: vehicle.license_plate }
    };
  }

  async checkIn({ routeId, clientId, outcome, audioUrl, lat, lng, addressUpdate, checklistData }) {
    const { data: route, error: routeError } = await supabase
      .from('daily_routes')
      .select('id, status')
      .eq('id', routeId)
      .single();

    if (routeError || !route) throw new Error('Ruta no encontrada');
    if (route.status !== 'active') throw new Error('La ruta no está activa');

    const { data: client, error: clientError } = await supabase
      .from('clients')
      .select('id, name, lat, lng, consecutive_no_sale')
      .eq('id', clientId)
      .single();

    if (clientError || !client) throw new Error('Cliente no encontrado');

    const visitInsert = {
      route_id: routeId,
      client_id: clientId,
      check_in: new Date().toISOString(),
      outcome: outcome || 'pending',
      audio_url: audioUrl || null,
      check_in_lat: lat || null,
      check_in_lng: lng || null
    };

    if (checklistData) {
      visitInsert.checklist_data = checklistData;
    }

    const { data: visit, error: visitError } = await supabase
      .from('visits')
      .insert([visitInsert])
      .select()
      .single();

    if (visitError) throw visitError;

    // Update client's last visit and potentially coordinates/address
    const updateData = { last_visit_at: new Date().toISOString() };

    // Track consecutive visits without sale
    if (outcome === 'sale') {
      updateData.consecutive_no_sale = 0;
      updateData.last_sale_date = new Date().toISOString();
    } else if (outcome === 'contacted' || outcome === 'no_contact') {
      updateData.consecutive_no_sale = (client.consecutive_no_sale || 0) + 1;
    }

    // If address correction was provided, use that
    if (addressUpdate) {
      if (addressUpdate.address) updateData.address = addressUpdate.address;
      if (addressUpdate.commune) updateData.commune = addressUpdate.commune;
      if (addressUpdate.lat) updateData.lat = addressUpdate.lat;
      if (addressUpdate.lng) updateData.lng = addressUpdate.lng;
    } else if (lat && lng && (!client.lat || !client.lng)) {
      // Otherwise, if client has no coords and we have GPS, use that
      updateData.lat = lat;
      updateData.lng = lng;
    }

    await supabase
      .from('clients')
      .update(updateData)
      .eq('id', clientId);

    // Mark scheduled route as completed if exists
    const today = new Date().toISOString().split('T')[0];
    await supabase
      .from('scheduled_routes')
      .update({ status: 'completed', updated_at: new Date().toISOString() })
      .eq('client_id', clientId)
      .eq('scheduled_date', today)
      .eq('status', 'pending');

    return {
      visit,
      client: { id: client.id, name: client.name },
      location: lat && lng ? { lat, lng } : null,
      addressUpdated: !!addressUpdate
    };
  }

  async getActiveRoute(userId) {
    const today = new Date().toISOString().split('T')[0];

    const { data: route, error } = await supabase
      .from('daily_routes')
      .select(`
        *,
        user:users(*),
        vehicle:vehicles(*),
        visits(*, client:clients(*))
      `)
      .eq('user_id', userId)
      .eq('date', today)
      .eq('status', 'active')
      .single();

    if (error) return null;
    return route;
  }

  async getAllRoutes() {
    const { data, error } = await supabase
      .from('daily_routes')
      .select(`
        *,
        user:users(id, full_name, email),
        vehicle:vehicles(id, license_plate, model)
      `)
      .order('date', { ascending: false })
      .limit(50);

    if (error) throw error;

    // Get visit counts
    const routeIds = data.map(r => r.id);
    if (routeIds.length === 0) return data;

    const { data: visits } = await supabase
      .from('visits')
      .select('route_id')
      .in('route_id', routeIds);

    const visitCounts = {};
    visits?.forEach(v => {
      visitCounts[v.route_id] = (visitCounts[v.route_id] || 0) + 1;
    });

    return data.map(route => ({
      ...route,
      visits_count: visitCounts[route.id] || 0
    }));
  }

  async getRouteWithVisits(routeId) {
    const { data: route, error } = await supabase
      .from('daily_routes')
      .select(`
        *,
        user:users(*),
        vehicle:vehicles(*),
        visits(*, client:clients(*))
      `)
      .eq('id', routeId)
      .single();

    if (error) return null;

    if (route.visits) {
      route.visits.sort((a, b) => new Date(a.check_in) - new Date(b.check_in));
    }

    return route;
  }

  async getRoutesByUser(userId) {
    const { data, error } = await supabase
      .from('daily_routes')
      .select(`
        *,
        user:users(*),
        vehicle:vehicles(*),
        visits(*, client:clients(*))
      `)
      .eq('user_id', userId)
      .order('date', { ascending: false })
      .limit(10);

    if (error) throw error;
    return data || [];
  }

  async getTodayRoutes() {
    const today = new Date().toISOString().split('T')[0];

    const { data, error } = await supabase
      .from('daily_routes')
      .select(`
        *,
        user:users(*),
        vehicle:vehicles(*),
        visits(*, client:clients(*))
      `)
      .eq('date', today)
      .order('created_at', { ascending: false });

    if (error) throw error;
    return data || [];
  }

  async getRoutesByDate(date) {
    const { data, error } = await supabase
      .from('daily_routes')
      .select(`
        *,
        user:users(id, full_name, email),
        vehicle:vehicles(id, license_plate, model)
      `)
      .eq('date', date)
      .order('created_at', { ascending: false });

    if (error) throw error;

    // Get visit counts
    if (data && data.length > 0) {
      const routeIds = data.map(r => r.id);
      const { data: visits } = await supabase
        .from('visits')
        .select('route_id')
        .in('route_id', routeIds);

      const visitCounts = {};
      visits?.forEach(v => {
        visitCounts[v.route_id] = (visitCounts[v.route_id] || 0) + 1;
      });

      return data.map(route => ({
        ...route,
        visits_count: visitCounts[route.id] || 0
      }));
    }

    return data || [];
  }

  async endDay(routeId, endKm) {
    const { data: route } = await supabase
      .from('daily_routes')
      .select('*, vehicle:vehicles(*)')
      .eq('id', routeId)
      .single();

    if (!route) throw new Error('Ruta no encontrada');

    const kmTraveled = endKm - route.start_km;
    const fuelEfficiency = route.vehicle?.fuel_efficiency_kml || VEHICLE_CONFIG.FUEL_EFFICIENCY_KML;
    const fuelUsed = kmTraveled / fuelEfficiency;
    const totalCost = Math.round(fuelUsed * VEHICLE_CONFIG.FUEL_PRICE_CLP);

    const { data, error } = await supabase
      .from('daily_routes')
      .update({
        end_km: endKm,
        total_cost_clp: totalCost,
        status: 'completed'
      })
      .eq('id', routeId)
      .select()
      .single();

    if (error) throw error;
    return data;
  }

  // =============================================
  // OPTIMIZACIÓN DE RUTAS
  // =============================================

  // Obtiene ruta optimizada para un vendedor
  // Obtiene las zonas disponibles para un vendedor (con estado GPS)
  async getVendorZones(userId) {
    const { data: clients, error } = await supabase
      .from('clients')
      .select('zone, lat, lng')
      .eq('assigned_user_id', userId)
      .not('zone', 'is', null);

    if (error) throw error;

    // Obtener zonas únicas con conteo y estado GPS
    const zoneStats = {};
    clients.forEach(c => {
      if (c.zone) {
        if (!zoneStats[c.zone]) {
          zoneStats[c.zone] = { total: 0, withGps: 0 };
        }
        zoneStats[c.zone].total++;
        if (c.lat && c.lng) {
          zoneStats[c.zone].withGps++;
        }
      }
    });

    return Object.entries(zoneStats).map(([zone, stats]) => ({
      zone,
      clientCount: stats.total,
      withGps: stats.withGps,
      withoutGps: stats.total - stats.withGps
    })).sort((a, b) => b.withGps - a.withGps); // Ordenar por los que tienen más GPS
  }

  async getOptimizedRoute(userId, zone = null, startPoint = null, excludeIds = []) {
    // Construir query base
    let query = supabase
      .from('clients')
      .select('id, external_id, name, fantasy_name, address, commune, lat, lng, segment, priority, zone')
      .eq('assigned_user_id', userId)
      .not('lat', 'is', null)
      .not('lng', 'is', null);

    // Filtrar por zona si se especifica (zona vacía = todas las zonas)
    if (zone && zone.trim() !== '') {
      query = query.eq('zone', zone);
    }

    const { data: allClients, error } = await query;

    // Filter out excluded clients
    const clients = (allClients || []).filter(c => !excludeIds.includes(c.id));

    if (error) throw error;

    if (!clients || clients.length === 0) {
      return {
        message: zone
          ? `No hay clientes con coordenadas en la zona "${zone}" para este vendedor`
          : 'No hay clientes con coordenadas asignados a este vendedor',
        route: [],
        stats: null,
        zone: zone
      };
    }

    // Si es "Todas las zonas", verificar dispersión geográfica
    let geoWarning = null;
    if (!zone || zone.trim() === '') {
      // Calcular bounding box
      let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
      clients.forEach(c => {
        const lat = parseFloat(c.lat);
        const lng = parseFloat(c.lng);
        if (lat < minLat) minLat = lat;
        if (lat > maxLat) maxLat = lat;
        if (lng < minLng) minLng = lng;
        if (lng > maxLng) maxLng = lng;
      });
      const maxSpan = haversineDistance(minLat, minLng, maxLat, maxLng);
      if (maxSpan > 100) {
        geoWarning = `Los clientes están dispersos en ${Math.round(maxSpan)} km. Se recomienda filtrar por zona para una ruta más eficiente.`;
      }
    }

    // Generate weekdays starting from next business day
    const startDate = new Date();
    // Advance to next business day
    do {
      startDate.setDate(startDate.getDate() + 1);
    } while (startDate.getDay() === 0 || startDate.getDay() === 6);

    // Calculate how many weekdays we need (ceil(clients / 10) + 2 buffer)
    const neededDays = Math.ceil(clients.length / 10) + 2;
    const weekdays = [];
    const cursor = new Date(startDate);
    while (weekdays.length < neededDays) {
      if (cursor.getDay() >= 1 && cursor.getDay() <= 5) {
        weekdays.push(cursor.toISOString().split('T')[0]);
      }
      cursor.setDate(cursor.getDate() + 1);
    }

    // Use shared helper to split into days with TSP per day
    const { schedule: days, sortedDates } = this._splitIntoDays(clients, weekdays);

    // Build per-day route with stats and fuel costs
    const daysResult = {};
    let totalClients = 0;
    let totalDistanceKm = 0;
    let totalEstimatedTime = 0;

    for (const date of sortedDates) {
      const dayData = days[date];
      const fuelStats = calculateFuelCost(dayData.totalDistance);
      daysResult[date] = {
        route: dayData.clients.map((client, idx) => ({ order: idx + 1, ...client })),
        stats: {
          totalClients: dayData.clients.length,
          ...fuelStats,
          estimatedTime: dayData.estimatedTime,
          totalHours: dayData.totalHours,
          endTime: dayData.endTime
        },
        communes: dayData.communes || []
      };
      totalClients += dayData.clients.length;
      totalDistanceKm += dayData.totalDistance;
      totalEstimatedTime += dayData.estimatedTime;
    }

    const totalFuelStats = calculateFuelCost(totalDistanceKm);

    // Flatten all routes for backward compat
    const allRoute = [];
    for (const date of sortedDates) {
      allRoute.push(...daysResult[date].route);
    }
    // Re-number flattened route
    allRoute.forEach((c, i) => { c.order = i + 1; });

    return {
      zone: zone || 'Todas las zonas',
      geoWarning: geoWarning || null,
      // Multi-day structure
      days: daysResult,
      totalStats: {
        totalClients,
        totalDays: sortedDates.length,
        ...totalFuelStats,
        estimatedTime: totalEstimatedTime,
        vehicleConfig: VEHICLE_CONFIG,
        startDate: sortedDates[0],
        endDate: sortedDates[sortedDates.length - 1]
      },
      // Backward compat
      route: allRoute,
      stats: {
        totalClients,
        ...totalFuelStats,
        estimatedTime: totalEstimatedTime,
        vehicleConfig: VEHICLE_CONFIG
      }
    };
  }

  // =============================================
  // ZONALES Y CLIENTES POR VENDEDOR
  // =============================================

  async getClientsByUser(userId) {
    let allUserClients = [];
    let from = 0;
    const batchSize = 1000;
    let hasMore = true;

    while (hasMore) {
      const { data, error } = await supabase
        .from('clients')
        .select('*')
        .eq('assigned_user_id', userId)
        .order('name')
        .range(from, from + batchSize - 1);

      if (error) throw error;

      if (data && data.length > 0) {
        allUserClients = allUserClients.concat(data);
        from += batchSize;
        hasMore = data.length === batchSize;
      } else {
        hasMore = false;
      }
    }

    return allUserClients;
  }

  async updateUserZone(userId, zone, isLeader = false) {
    const updateData = { zone };
    if (typeof isLeader === 'boolean') {
      updateData.zone_leader = isLeader;
    }

    const { data, error } = await supabase
      .from('users')
      .update(updateData)
      .eq('id', userId)
      .select()
      .single();

    if (error) throw error;
    return data;
  }

  async getZones() {
    const { data: users, error } = await supabase
      .from('users')
      .select('id, full_name, email, role, zone, zone_leader, status')
      .order('full_name');

    if (error) throw error;

    // Group by zone
    const zones = {};
    const ZONE_ORDER = ['Norte', 'Centro', 'Centro Sur', 'Sur'];

    users.forEach(u => {
      const zoneName = u.zone || 'Sin Zona';
      if (!zones[zoneName]) {
        zones[zoneName] = { name: zoneName, leader: null, vendors: [] };
      }
      if (u.zone_leader) {
        zones[zoneName].leader = u;
      }
      if (u.role === 'executive' || u.role === 'zonal') {
        zones[zoneName].vendors.push(u);
      }
    });

    // Sort zones by predefined order
    const sortedZones = [];
    ZONE_ORDER.forEach(z => {
      if (zones[z]) sortedZones.push(zones[z]);
    });
    // Add any remaining zones not in the predefined order
    Object.keys(zones).forEach(z => {
      if (!ZONE_ORDER.includes(z)) sortedZones.push(zones[z]);
    });

    return sortedZones;
  }

  async reassignSelectedClients(clientIds, toUserId) {
    if (!clientIds || clientIds.length === 0) {
      throw new Error('No se seleccionaron clientes');
    }

    const { data, error } = await supabase
      .from('clients')
      .update({ assigned_user_id: toUserId })
      .in('id', clientIds)
      .select('id');

    if (error) throw error;

    return { updated: data.length, toUserId };
  }

  /**
   * Obtiene estadísticas de rendimiento de visitas por vendedor
   * Puede filtrar por rango de fechas
   */
  async getVisitPerformance(dateFrom = null, dateTo = null) {
    // Get all users (executives)
    const { data: users, error: usersError } = await supabase
      .from('users')
      .select('id, full_name, role')
      .in('role', ['executive', 'zonal', 'supervisor'])
      .order('full_name');

    if (usersError) throw usersError;

    // Build routes query with date filter
    let routesQuery = supabase
      .from('daily_routes')
      .select(`
        id, user_id, date, status,
        visits(id, outcome, check_in, check_out)
      `)
      .order('date', { ascending: false });

    if (dateFrom) routesQuery = routesQuery.gte('date', dateFrom);
    if (dateTo) routesQuery = routesQuery.lte('date', dateTo);

    const { data: routes, error: routesError } = await routesQuery;
    if (routesError) throw routesError;

    // Build per-user stats
    const stats = users.map(user => {
      const userRoutes = (routes || []).filter(r => r.user_id === user.id);
      const allVisits = userRoutes.flatMap(r => r.visits || []);

      const outcomes = { sale: 0, contacted: 0, no_contact: 0, no_stock: 0, not_interested: 0, pending: 0 };
      allVisits.forEach(v => {
        if (outcomes.hasOwnProperty(v.outcome)) outcomes[v.outcome]++;
        else outcomes.pending++;
      });

      const totalVisits = allVisits.length;
      const effectiveVisits = outcomes.sale + outcomes.contacted;
      const effectiveness = totalVisits > 0 ? Math.round((effectiveVisits / totalVisits) * 100) : 0;

      // Days worked (unique dates with routes)
      const uniqueDays = new Set(userRoutes.map(r => r.date));
      const daysWorked = uniqueDays.size;
      const avgVisitsPerDay = daysWorked > 0 ? Math.round((totalVisits / daysWorked) * 10) / 10 : 0;

      return {
        userId: user.id,
        name: user.full_name,
        role: user.role,
        totalRoutes: userRoutes.length,
        completedRoutes: userRoutes.filter(r => r.status === 'completed').length,
        daysWorked,
        totalVisits,
        effectiveVisits,
        effectiveness,
        avgVisitsPerDay,
        outcomes
      };
    });

    // Sort by effectiveness descending
    stats.sort((a, b) => b.effectiveness - a.effectiveness || b.totalVisits - a.totalVisits);

    // Totals
    const totals = {
      totalVendedores: stats.length,
      totalVisits: stats.reduce((s, u) => s + u.totalVisits, 0),
      totalSales: stats.reduce((s, u) => s + u.outcomes.sale, 0),
      avgEffectiveness: stats.length > 0 ? Math.round(stats.reduce((s, u) => s + u.effectiveness, 0) / stats.length) : 0
    };

    return { stats, totals };
  }

  // Actualiza precio de combustible dinámicamente (desde CNE u otra fuente)
  updateFuelPrice(price) {
    if (price && typeof price === 'number' && price > 0) {
      VEHICLE_CONFIG.FUEL_PRICE_CLP = Math.round(price);
    }
  }

  // Obtiene configuración de vehículo estándar
  getVehicleConfig() {
    return VEHICLE_CONFIG;
  }

  // Calcula distancia y costo entre dos puntos
  calculateDistanceCost(lat1, lng1, lat2, lng2) {
    const distance = haversineDistance(lat1, lng1, lat2, lng2);
    return calculateFuelCost(distance);
  }

  // =============================================
  // SEGMENTACIÓN DE CLIENTES (Fase 1)
  // =============================================

  /**
   * Sincroniza segmentación desde códigos enviados por el frontend
   * codesL: array de external_id de clientes con ventas (L)
   * codes8020: array de external_id de clientes clave (80-20)
   * Prioridad: 80-20 > L > N
   */
  async syncClientSegmentationFromCodes(codesL, codes8020) {
    const results = { updated: 0, errors: [], segmentCounts: { L: 0, '80-20': 0, N: 0 } };

    // Get all clients
    const allClients = await this.getAllClients();
    const clientsByCode = {};
    allClients.forEach(c => {
      if (c.external_id) clientsByCode[String(c.external_id).trim()] = c;
    });

    // Step 1: Mark ALL existing clients as L (todos compraron en Leker)
    const allClientIds = allClients.map(c => c.id);
    if (allClientIds.length > 0) {
      const batchSize = 500;
      for (let i = 0; i < allClientIds.length; i += batchSize) {
        const batch = allClientIds.slice(i, i + batchSize);
        await supabase
          .from('clients')
          .update({ segmentation: 'L' })
          .in('id', batch);
      }
    }

    // Step 2: Mark 80-20 clients (overrides L - clientes clave)
    const codes8020Set = new Set((codes8020 || []).map(c => String(c).trim()).filter(Boolean));
    const eightTwentyIds = [];
    codes8020Set.forEach(code => {
      if (clientsByCode[code]) eightTwentyIds.push(clientsByCode[code].id);
    });
    if (eightTwentyIds.length > 0) {
      const batchSize = 500;
      for (let i = 0; i < eightTwentyIds.length; i += batchSize) {
        const batch = eightTwentyIds.slice(i, i + batchSize);
        const { error } = await supabase
          .from('clients')
          .update({ segmentation: '80-20' })
          .in('id', batch);
        if (error) results.errors.push({ step: '80-20', error: error.message });
      }
      results.segmentCounts['80-20'] = eightTwentyIds.length;
    }

    // Count: L = total - 80-20, N = 0 (solo para clientes nuevos importados)
    results.segmentCounts.L = allClients.length - eightTwentyIds.length;
    results.segmentCounts.N = 0;
    results.updated = allClients.length;

    return results;
  }

  /**
   * Estadísticas de segmentación
   */
  async getSegmentationStats() {
    const allClients = await this.getAllClients();
    const stats = { L: 0, '80-20': 0, N: 0, total: allClients.length };

    allClients.forEach(c => {
      const seg = c.segmentation || 'N';
      if (seg === '80-20') stats['80-20']++;
      else if (seg === 'L') stats.L++;
      else stats.N++;
    });

    return stats;
  }

  // =============================================
  // CHECKLIST DE VISITA (Fase 2)
  // =============================================

  /**
   * Obtiene datos consolidados para el checklist de un cliente
   */
  async getClientChecklistData(clientId) {
    // Get client data
    const { data: client, error: clientError } = await supabase
      .from('clients')
      .select('*')
      .eq('id', clientId)
      .single();

    if (clientError || !client) throw new Error('Cliente no encontrado');

    // Get last visit
    const { data: lastVisits } = await supabase
      .from('visits')
      .select('*, route:daily_routes(date, user:users(full_name))')
      .eq('client_id', clientId)
      .order('check_in', { ascending: false })
      .limit(5);

    // Get scheduled routes pending for this client
    const { data: scheduledPending } = await supabase
      .from('scheduled_routes')
      .select('*')
      .eq('client_id', clientId)
      .eq('status', 'pending')
      .order('scheduled_date', { ascending: true })
      .limit(3);

    return {
      client,
      lastVisit: lastVisits && lastVisits.length > 0 ? lastVisits[0] : null,
      visitHistory: lastVisits || [],
      scheduledVisits: scheduledPending || []
    };
  }

  /**
   * Actualiza ficha del cliente (dueño, comprador, teléfonos, etc.)
   */
  async updateClientProfile(clientId, profileData) {
    const allowedFields = [
      'owner_name', 'buyer_name', 'phone', 'phone2', 'email',
      'observations', 'competitor_provider1', 'competitor_provider2',
      'is_competitor_client', 'segmentation'
    ];

    const updateData = {};
    allowedFields.forEach(field => {
      if (profileData[field] !== undefined) {
        updateData[field] = profileData[field];
      }
    });

    if (Object.keys(updateData).length === 0) {
      throw new Error('No hay campos válidos para actualizar');
    }

    const { data, error } = await supabase
      .from('clients')
      .update(updateData)
      .eq('id', clientId)
      .select()
      .single();

    if (error) throw error;
    return data;
  }

  // =============================================
  // RUTAS PLANIFICADAS (Fase 3) — V2
  // =============================================

  // fillLonely8020Communes removed — replaced by proximity-based clustering

  /**
   * Calcula timeline del día con hora estimada de llegada a cada cliente
   * Velocidad promedio: 40 km/h, 60 min por visita, inicio 09:00
   */
  calculateDayTimeline(orderedClients, startTime = '09:00') {
    const SPEED_KMH = 40;
    const VISIT_DURATION_MIN = 60;
    const END_OF_DAY = '18:00';

    const [startH, startM] = startTime.split(':').map(Number);
    let currentMinutes = startH * 60 + startM;
    const endMinutes = 18 * 60; // 18:00

    const timeline = [];
    let totalDistanceKm = 0;
    let overloaded = false;

    for (let i = 0; i < orderedClients.length; i++) {
      const client = orderedClients[i];

      // Calculate travel time from previous client
      let travelTimeMin = 0;
      let travelDistKm = 0;
      if (i > 0) {
        const prev = orderedClients[i - 1];
        if (prev.lat && prev.lng && client.lat && client.lng) {
          travelDistKm = haversineDistance(prev.lat, prev.lng, client.lat, client.lng);
          travelTimeMin = Math.round((travelDistKm / SPEED_KMH) * 60);
        } else {
          travelTimeMin = 15; // default if no coords
        }
      }

      totalDistanceKm += travelDistKm;
      currentMinutes += travelTimeMin;

      const arrivalH = Math.floor(currentMinutes / 60);
      const arrivalM = currentMinutes % 60;
      const arrivalTime = `${String(arrivalH).padStart(2, '0')}:${String(arrivalM).padStart(2, '0')}`;

      const departureMinutes = currentMinutes + VISIT_DURATION_MIN;
      const departH = Math.floor(departureMinutes / 60);
      const departM = departureMinutes % 60;
      const departureTime = `${String(departH).padStart(2, '0')}:${String(departM).padStart(2, '0')}`;

      if (currentMinutes > endMinutes) {
        overloaded = true;
      }

      timeline.push({
        client,
        estimatedArrival: arrivalTime,
        estimatedDeparture: departureTime,
        travelTimeMin,
        travelDistKm: Math.round(travelDistKm * 10) / 10
      });

      currentMinutes = departureMinutes;
    }

    const totalHours = Math.round((currentMinutes - (startH * 60 + startM)) / 6) / 10; // 1 decimal

    return {
      timeline,
      totalDistanceKm: Math.round(totalDistanceKm * 10) / 10,
      totalHours,
      overloaded,
      endTime: `${String(Math.floor(currentMinutes / 60)).padStart(2, '0')}:${String(currentMinutes % 60).padStart(2, '0')}`
    };
  }

  /**
   * Divide clientes en días hábiles usando clustering geográfico por proximidad.
   * Reemplaza la lógica anterior de agrupación por comuna con clusters basados en haversine.
   * @param {Array} clientsToVisit - Clientes a distribuir
   * @param {Array} weekdays - Fechas hábiles ['YYYY-MM-DD', ...]
   * @returns {Object} { schedule: {date: {clients, totalDistance, totalHours, ...}}, sortedDates }
   */
  _splitIntoDays(clientsToVisit, weekdays) {
    const MAX_PER_DAY = 15;
    const MIN_PER_DAY = 5;

    // Step 1: Cluster clients by geographic proximity
    const clusters = clusterClientsByProximity(clientsToVisit);

    // Sort clusters: largest first (they get the earliest days)
    clusters.sort((a, b) => b.length - a.length);

    // Step 2: Assign clusters to days (bin-packing by time budget)
    const schedule = {};
    weekdays.forEach(d => { schedule[d] = []; });

    for (const cluster of clusters) {
      // Find day with most remaining capacity
      let bestDay = null;
      let bestRemaining = -1;
      for (const d of weekdays) {
        const remaining = MAX_PER_DAY - schedule[d].length;
        if (remaining >= cluster.length && remaining > bestRemaining) {
          bestDay = d;
          bestRemaining = remaining;
        }
      }

      // If cluster fits entirely in a day, assign it
      if (bestDay) {
        schedule[bestDay].push(...cluster);
      } else {
        // Cluster too big or no day has enough room — split across days
        let remaining = [...cluster];
        for (const d of weekdays) {
          if (remaining.length === 0) break;
          const capacity = MAX_PER_DAY - schedule[d].length;
          if (capacity <= 0) continue;
          const batch = remaining.splice(0, capacity);
          schedule[d].push(...batch);
        }
        // If still leftover, create overflow on least-loaded day
        if (remaining.length > 0) {
          const leastLoaded = weekdays.reduce((best, d) =>
            schedule[d].length < schedule[best].length ? d : best, weekdays[0]);
          schedule[leastLoaded].push(...remaining);
        }
      }
    }

    // Step 3: Optimize route order (NN + 2-opt) and calculate timeline per day
    const optimizedSchedule = {};
    for (const [date, dayClients] of Object.entries(schedule)) {
      if (dayClients.length === 0) continue;
      const clientsWithCoords = dayClients.filter(c => c.lat && c.lng);
      const clientsWithoutCoords = dayClients.filter(c => !c.lat || !c.lng);

      let orderedClients;
      if (clientsWithCoords.length > 0) {
        const result = optimizeRouteOrder(clientsWithCoords);
        orderedClients = [...result.route, ...clientsWithoutCoords];
      } else {
        orderedClients = dayClients;
      }

      const dayTimeline = this.calculateDayTimeline(orderedClients);
      const communes = [...new Set(orderedClients.map(c => c.commune || 'Sin Comuna'))];

      optimizedSchedule[date] = {
        clients: dayTimeline.timeline.map(t => ({
          ...t.client,
          estimatedArrival: t.estimatedArrival,
          estimatedDeparture: t.estimatedDeparture,
          travelTimeMin: t.travelTimeMin,
          travelDistKm: t.travelDistKm
        })),
        totalDistance: dayTimeline.totalDistanceKm,
        totalHours: dayTimeline.totalHours,
        estimatedTime: Math.round(dayTimeline.totalHours * 60),
        endTime: dayTimeline.endTime,
        overloaded: dayTimeline.overloaded,
        communes
      };
    }

    // Step 4: Move overloaded clients (arriving after 17:00) to next available day
    const sortedDates = Object.keys(optimizedSchedule).sort();
    for (let i = 0; i < sortedDates.length; i++) {
      const dayData = optimizedSchedule[sortedDates[i]];
      if (!dayData.overloaded) continue;

      const overflow = [];
      const keep = [];
      for (const client of dayData.clients) {
        const [h] = client.estimatedArrival.split(':').map(Number);
        if (h >= 17 && keep.length >= MIN_PER_DAY) {
          overflow.push(client);
        } else {
          keep.push(client);
        }
      }

      if (overflow.length > 0) {
        for (let j = i + 1; j < sortedDates.length && overflow.length > 0; j++) {
          const nextDay = optimizedSchedule[sortedDates[j]];
          while (nextDay.clients.length < MAX_PER_DAY && overflow.length > 0) {
            nextDay.clients.push(overflow.shift());
          }
        }
        // If still overflow, add a new day
        if (overflow.length > 0) {
          const extraDate = sortedDates[sortedDates.length - 1];
          const nextBiz = new Date(extraDate);
          do { nextBiz.setDate(nextBiz.getDate() + 1); } while (nextBiz.getDay() === 0 || nextBiz.getDay() === 6);
          const extraKey = nextBiz.toISOString().split('T')[0];
          sortedDates.push(extraKey);
          const extraTimeline = this.calculateDayTimeline(overflow);
          optimizedSchedule[extraKey] = {
            clients: overflow.map((c, idx) => ({
              ...c,
              estimatedArrival: extraTimeline.timeline[idx]?.estimatedArrival || '09:00',
              estimatedDeparture: extraTimeline.timeline[idx]?.estimatedDeparture || '09:30'
            })),
            totalDistance: extraTimeline.totalDistanceKm,
            totalHours: extraTimeline.totalHours,
            estimatedTime: Math.round(extraTimeline.totalHours * 60),
            endTime: extraTimeline.endTime,
            overloaded: extraTimeline.overloaded,
            communes: [...new Set(overflow.map(c => c.commune || 'Sin Comuna'))]
          };
          overflow.length = 0;
        }

        const recalc = this.calculateDayTimeline(keep);
        dayData.clients = keep.map((c, idx) => ({
          ...c,
          estimatedArrival: recalc.timeline[idx]?.estimatedArrival || c.estimatedArrival,
          estimatedDeparture: recalc.timeline[idx]?.estimatedDeparture || c.estimatedDeparture
        }));
        dayData.totalDistance = recalc.totalDistanceKm;
        dayData.totalHours = recalc.totalHours;
        dayData.estimatedTime = Math.round(recalc.totalHours * 60);
        dayData.endTime = recalc.endTime;
        dayData.overloaded = recalc.overloaded;
      }
    }

    return { schedule: optimizedSchedule, sortedDates };
  }

  /**
   * Genera plan semanal L-V para un vendedor (V2 con timeline y relleno de comunas)
   */
  async generateSchedule(userId, startDate, endDate) {
    // Get vendor's clients with segmentation
    const { data: clients, error } = await supabase
      .from('clients')
      .select('id, external_id, name, fantasy_name, address, commune, lat, lng, segmentation, visit_frequency_days, consecutive_no_sale, last_visit_at, is_competitor_client')
      .eq('assigned_user_id', userId);

    if (error) throw error;
    if (!clients || clients.length === 0) {
      throw new Error('El vendedor no tiene clientes asignados');
    }

    // Sort by priority: 80-20 first, then L, then N
    const priorityOrder = { '80-20': 0, 'L': 1, 'N': 2 };
    clients.sort((a, b) => {
      const pa = priorityOrder[a.segmentation] ?? 2;
      const pb = priorityOrder[b.segmentation] ?? 2;
      return pa - pb;
    });

    // Filter clients that need a visit (based on frequency and last visit)
    const now = new Date();
    const clientsToVisit = clients.filter(c => {
      if (!c.last_visit_at) return true;
      const lastVisit = new Date(c.last_visit_at);
      const daysSince = Math.floor((now - lastVisit) / (1000 * 60 * 60 * 24));
      return daysSince >= (c.visit_frequency_days || 30) * 0.7;
    });

    // Generate weekdays between start and end
    const start = new Date(startDate);
    const end = new Date(endDate);
    const weekdays = [];
    const current = new Date(start);
    while (current <= end) {
      const day = current.getDay();
      if (day >= 1 && day <= 5) {
        weekdays.push(new Date(current).toISOString().split('T')[0]);
      }
      current.setDate(current.getDate() + 1);
    }

    if (weekdays.length === 0) {
      throw new Error('No hay días hábiles en el rango seleccionado');
    }

    // Use shared helper to split into days (proximity-based clustering)
    const { schedule: optimizedSchedule } = this._splitIntoDays(clientsToVisit, weekdays);

    // Delete existing pending scheduled routes for this user in the date range
    await supabase
      .from('scheduled_routes')
      .delete()
      .eq('user_id', userId)
      .eq('status', 'pending')
      .gte('scheduled_date', startDate)
      .lte('scheduled_date', endDate);

    // Insert new scheduled routes with estimated arrival
    const inserts = [];
    for (const [date, dayData] of Object.entries(optimizedSchedule)) {
      dayData.clients.forEach((client, idx) => {
        inserts.push({
          user_id: userId,
          scheduled_date: date,
          client_id: client.id,
          priority: idx,
          status: 'pending',
          original_date: date,
          estimated_arrival: client.estimatedArrival || null,
          estimated_duration: 60
        });
      });
    }

    if (inserts.length > 0) {
      const batchSize = 100;
      for (let i = 0; i < inserts.length; i += batchSize) {
        const batch = inserts.slice(i, i + batchSize);
        await supabase.from('scheduled_routes').insert(batch);
      }
    }

    return {
      totalClients: inserts.length,
      days: Object.keys(optimizedSchedule).length,
      schedule: optimizedSchedule
    };
  }

  /**
   * Mueve rutas pendientes de un día al siguiente hábil
   */
  async rescheduleIncomplete(userId, date) {
    // Get pending routes for the date
    const { data: pending, error } = await supabase
      .from('scheduled_routes')
      .select('*')
      .eq('user_id', userId)
      .eq('scheduled_date', date)
      .eq('status', 'pending');

    if (error) throw error;
    if (!pending || pending.length === 0) {
      return { rescheduled: 0, message: 'No hay rutas pendientes para reprogramar' };
    }

    // Find next business day
    const currentDate = new Date(date);
    let nextDay = new Date(currentDate);
    do {
      nextDay.setDate(nextDay.getDate() + 1);
    } while (nextDay.getDay() === 0 || nextDay.getDay() === 6);

    const nextDateStr = nextDay.toISOString().split('T')[0];

    // Update status and date
    const ids = pending.map(p => p.id);
    const { error: updateError } = await supabase
      .from('scheduled_routes')
      .update({
        scheduled_date: nextDateStr,
        status: 'rescheduled',
        updated_at: new Date().toISOString()
      })
      .in('id', ids);

    if (updateError) throw updateError;

    // Create new pending entries for next day
    const newEntries = pending.map((p, idx) => ({
      user_id: userId,
      scheduled_date: nextDateStr,
      client_id: p.client_id,
      priority: idx,
      status: 'pending',
      original_date: p.original_date || date
    }));

    await supabase.from('scheduled_routes').insert(newEntries);

    return {
      rescheduled: pending.length,
      fromDate: date,
      toDate: nextDateStr
    };
  }

  /**
   * Obtiene rutas planificadas de un vendedor
   */
  async getScheduledRoutes(userId, startDate, endDate) {
    let query = supabase
      .from('scheduled_routes')
      .select('*, client:clients(id, external_id, name, fantasy_name, address, commune, lat, lng, segmentation)')
      .eq('user_id', userId)
      .order('scheduled_date')
      .order('priority');

    if (startDate) query = query.gte('scheduled_date', startDate);
    if (endDate) query = query.lte('scheduled_date', endDate);

    const { data, error } = await query;
    if (error) throw error;

    // Group by date
    const byDate = {};
    (data || []).forEach(sr => {
      if (!byDate[sr.scheduled_date]) byDate[sr.scheduled_date] = [];
      byDate[sr.scheduled_date].push(sr);
    });

    return byDate;
  }

  /**
   * Obtiene TODAS las rutas planificadas de todos los vendedores para un rango de fechas
   * Usado por el calendario mensual multi-ejecutivo
   */
  async getAllScheduledRoutes(startDate, endDate) {
    // First, get all users for name lookup
    const { data: users } = await supabase
      .from('users')
      .select('id, full_name, role');
    const userMap = {};
    (users || []).forEach(u => { userMap[u.id] = u; });

    let allData = [];
    let from = 0;
    const pageSize = 1000;

    while (true) {
      let query = supabase
        .from('scheduled_routes')
        .select('*, client:clients(id, external_id, name, fantasy_name, address, commune, lat, lng, segmentation)')
        .order('scheduled_date')
        .order('priority')
        .range(from, from + pageSize - 1);

      if (startDate) query = query.gte('scheduled_date', startDate);
      if (endDate) query = query.lte('scheduled_date', endDate);

      const { data, error } = await query;
      if (error) throw error;
      if (!data || data.length === 0) break;

      allData = allData.concat(data);
      if (data.length < pageSize) break;
      from += pageSize;
    }

    // Group by userId → date → [routes]
    const grouped = {};
    allData.forEach(sr => {
      const uid = sr.user_id;
      const user = userMap[uid];
      if (!grouped[uid]) grouped[uid] = { userName: user?.full_name || 'Sin nombre', dates: {} };
      if (!grouped[uid].dates[sr.scheduled_date]) grouped[uid].dates[sr.scheduled_date] = [];
      grouped[uid].dates[sr.scheduled_date].push(sr);
    });

    return grouped;
  }

  /**
   * Recalcula frecuencias de visita para todos los clientes
   */
  async updateAllVisitFrequencies() {
    const allClients = await this.getAllClients();
    let updated = 0;

    for (const client of allClients) {
      let frequency = 30; // default: 1 visit per month

      // 80-20 clients: every 15 days
      if (client.segmentation === '80-20') {
        frequency = 15;
      }

      // 5+ consecutive no sale: increase frequency by 1.5x
      if ((client.consecutive_no_sale || 0) >= 5) {
        frequency = Math.round(frequency * 1.5);
      }

      // Competitor client with potential: reduce frequency by 0.75x
      if (client.is_competitor_client && client.segmentation !== 'N') {
        frequency = Math.round(frequency * 0.75);
      }

      if (frequency !== (client.visit_frequency_days || 30)) {
        await supabase
          .from('clients')
          .update({ visit_frequency_days: frequency })
          .eq('id', client.id);
        updated++;
      }
    }

    return { updated, total: allClients.length };
  }

  // =============================================
  // DASHBOARD MEJORADO (Fase 4)
  // =============================================

  /**
   * Estadísticas por vendedor para un mes
   */
  async getVendorDashboardStats(month) {
    // month format: YYYY-MM
    const startDate = `${month}-01`;
    const endOfMonth = new Date(parseInt(month.split('-')[0]), parseInt(month.split('-')[1]), 0);
    const endDate = endOfMonth.toISOString().split('T')[0];

    // Get users
    const { data: users } = await supabase
      .from('users')
      .select('id, full_name, role')
      .in('role', ['executive', 'zonal', 'supervisor'])
      .order('full_name');

    // Get routes in month
    const { data: routes } = await supabase
      .from('daily_routes')
      .select('id, user_id, date, status, visits(id, outcome, client_id)')
      .gte('date', startDate)
      .lte('date', endDate);

    const vendorStats = (users || []).map(user => {
      const userRoutes = (routes || []).filter(r => r.user_id === user.id);
      const allVisits = userRoutes.flatMap(r => r.visits || []);

      // Unique clients with sale
      const clientsWithSale = new Set();
      let totalSales = 0;
      allVisits.forEach(v => {
        if (v.outcome === 'sale') {
          totalSales++;
          clientsWithSale.add(v.client_id);
        }
      });

      // Days worked
      const daysWorked = new Set(userRoutes.map(r => r.date)).size;

      // Weekly breakdown
      const weeklyData = {};
      userRoutes.forEach(r => {
        const d = new Date(r.date);
        const weekNum = Math.ceil(d.getDate() / 7);
        const weekKey = `Semana ${weekNum}`;
        if (!weeklyData[weekKey]) weeklyData[weekKey] = { visits: 0, days: new Set(), clients: new Set() };
        const visits = r.visits || [];
        weeklyData[weekKey].visits += visits.length;
        weeklyData[weekKey].days.add(r.date);
        visits.forEach(v => weeklyData[weekKey].clients.add(v.client_id));
      });

      // Convert Sets to counts
      const weeklyArr = Object.entries(weeklyData).map(([week, data]) => ({
        week,
        visits: data.visits,
        days: data.days.size,
        clients: data.clients.size
      }));

      return {
        userId: user.id,
        name: user.full_name,
        role: user.role,
        totalVisits: allVisits.length,
        totalSales,
        clientsWithSale: clientsWithSale.size,
        daysWorked,
        weekly: weeklyArr
      };
    });

    return vendorStats;
  }

  /**
   * Datos de calendario de un vendedor para un mes
   */
  async getVendorCalendar(userId, month) {
    const startDate = `${month}-01`;
    const endOfMonth = new Date(parseInt(month.split('-')[0]), parseInt(month.split('-')[1]), 0);
    const endDate = endOfMonth.toISOString().split('T')[0];

    // Get actual visits/routes
    const { data: routes } = await supabase
      .from('daily_routes')
      .select('id, date, status, visits(id, outcome, client:clients(id, name, segmentation))')
      .eq('user_id', userId)
      .gte('date', startDate)
      .lte('date', endDate)
      .order('date');

    // Get scheduled routes
    const { data: scheduled } = await supabase
      .from('scheduled_routes')
      .select('scheduled_date, status, client:clients(id, name, segmentation)')
      .eq('user_id', userId)
      .gte('scheduled_date', startDate)
      .lte('scheduled_date', endDate);

    // Build day-by-day data
    const calendar = {};
    const current = new Date(startDate);
    while (current <= endOfMonth) {
      const dateStr = current.toISOString().split('T')[0];
      calendar[dateStr] = {
        scheduled: 0,
        completed: 0,
        pending: 0,
        segmentation: { '80-20': 0, L: 0, N: 0 }
      };
      current.setDate(current.getDate() + 1);
    }

    // Fill from scheduled routes
    (scheduled || []).forEach(sr => {
      const d = sr.scheduled_date;
      if (calendar[d]) {
        if (sr.status === 'pending') calendar[d].pending++;
        else if (sr.status === 'completed') calendar[d].completed++;
        calendar[d].scheduled++;
        const seg = sr.client?.segmentation || 'N';
        if (calendar[d].segmentation[seg] !== undefined) {
          calendar[d].segmentation[seg]++;
        }
      }
    });

    // Fill from actual routes
    (routes || []).forEach(r => {
      const d = r.date;
      if (calendar[d]) {
        const visits = r.visits || [];
        // Override completed count with actual visits
        calendar[d].completed = visits.length;
        visits.forEach(v => {
          const seg = v.client?.segmentation || 'N';
          if (!calendar[d].segmentation[seg]) calendar[d].segmentation[seg] = 0;
        });
      }
    });

    return calendar;
  }

  // =============================================
  // MODIFICACIÓN DE RUTAS Y ALERTAS (V2)
  // =============================================

  /**
   * Modifica una ruta planificada (ejecutivo skip/reschedule)
   */
  async modifyScheduledRoute(routeId, userId, { action, reason, newDate }) {
    const { data: route, error } = await supabase
      .from('scheduled_routes')
      .select('*, client:clients(id, name)')
      .eq('id', routeId)
      .single();

    if (error || !route) throw new Error('Ruta planificada no encontrada');

    // Verify ownership
    if (route.user_id !== userId) {
      throw new Error('No tienes permiso para modificar esta ruta');
    }

    const oldValue = { status: route.status, scheduled_date: route.scheduled_date };
    let newValue = {};

    if (action === 'skip') {
      newValue = { status: 'skipped' };
      await supabase
        .from('scheduled_routes')
        .update({ status: 'skipped', modified_by: userId, notes: reason, updated_at: new Date().toISOString() })
        .eq('id', routeId);
    } else if (action === 'reschedule' && newDate) {
      newValue = { status: 'rescheduled', scheduled_date: newDate };
      await supabase
        .from('scheduled_routes')
        .update({ status: 'rescheduled', modified_by: userId, notes: reason, updated_at: new Date().toISOString() })
        .eq('id', routeId);

      // Create new pending entry for the new date
      await supabase.from('scheduled_routes').insert({
        user_id: userId,
        scheduled_date: newDate,
        client_id: route.client_id,
        priority: 99,
        status: 'pending',
        original_date: route.original_date || route.scheduled_date,
        estimated_duration: 60
      });
    } else {
      throw new Error('Acción no válida');
    }

    // Log modification
    await supabase.from('route_modifications').insert({
      scheduled_route_id: routeId,
      user_id: userId,
      modification_type: action,
      reason: reason || null,
      old_value: oldValue,
      new_value: newValue
    });

    // Get user name for alert message
    const { data: user } = await supabase.from('users').select('full_name').eq('id', userId).single();
    const userName = user?.full_name || 'Ejecutivo';
    const clientName = route.client?.name || 'Cliente';

    // Create alert for all admins
    const { data: admins } = await supabase
      .from('users')
      .select('id')
      .eq('role', 'admin')
      .not('id', 'is', null);

    const alertType = action === 'skip' ? 'visit_skipped' : 'route_rescheduled';
    const message = action === 'skip'
      ? `${userName} saltó cliente "${clientName}" del ${route.scheduled_date} — "${reason || 'Sin razón'}"`
      : `${userName} reagendó "${clientName}" del ${route.scheduled_date} al ${newDate} — "${reason || 'Sin razón'}"`;

    const alertInserts = (admins || []).map(admin => ({
      alert_type: alertType,
      user_id: userId,
      admin_id: admin.id,
      message,
      metadata: { route_id: routeId, client_id: route.client_id, action, old_value: oldValue, new_value: newValue }
    }));

    if (alertInserts.length > 0) {
      await supabase.from('route_alerts').insert(alertInserts);
    }

    return { success: true, action, routeId };
  }

  /**
   * Obtiene alertas de ruta para un admin
   */
  async getRouteAlerts(adminId, unreadOnly = false) {
    let query = supabase
      .from('route_alerts')
      .select('*')
      .eq('admin_id', adminId)
      .order('created_at', { ascending: false })
      .limit(50);

    if (unreadOnly) {
      query = query.eq('read', false);
    }

    const { data, error } = await query;
    if (error) {
      // Table may not exist yet — return empty gracefully
      console.warn('getRouteAlerts error (table may not exist):', error.message);
      return [];
    }
    return data || [];
  }

  /**
   * Marca alerta como leída
   */
  async markAlertRead(alertId) {
    const { error } = await supabase
      .from('route_alerts')
      .update({ read: true })
      .eq('id', alertId);
    if (error && !error.message?.includes('does not exist')) throw error;
    return true;
  }

  /**
   * Marca todas las alertas como leídas para un admin
   */
  async markAllAlertsRead(adminId) {
    const { error } = await supabase
      .from('route_alerts')
      .update({ read: true })
      .eq('admin_id', adminId)
      .eq('read', false);
    if (error && !error.message?.includes('does not exist')) throw error;
    return true;
  }

  /**
   * Cuenta alertas no leídas para un admin
   */
  async getUnreadAlertCount(adminId) {
    const { count, error } = await supabase
      .from('route_alerts')
      .select('*', { count: 'exact', head: true })
      .eq('admin_id', adminId)
      .eq('read', false);
    if (error) {
      console.warn('getUnreadAlertCount error (table may not exist):', error.message);
      return 0;
    }
    return count || 0;
  }

  /**
   * Auto-reprogramación de rutas pendientes al final del día
   */
  async autoRescheduleEndOfDay() {
    const today = new Date().toISOString().split('T')[0];

    // Get all pending routes for today
    const { data: pending, error } = await supabase
      .from('scheduled_routes')
      .select('*, user:users(id, full_name)')
      .eq('scheduled_date', today)
      .eq('status', 'pending');

    if (error) throw error;
    if (!pending || pending.length === 0) return { rescheduled: 0 };

    // Find next business day
    const todayDate = new Date(today);
    let nextDay = new Date(todayDate);
    do {
      nextDay.setDate(nextDay.getDate() + 1);
    } while (nextDay.getDay() === 0 || nextDay.getDay() === 6);
    const nextDateStr = nextDay.toISOString().split('T')[0];

    // Group by user
    const byUser = {};
    pending.forEach(p => {
      if (!byUser[p.user_id]) byUser[p.user_id] = [];
      byUser[p.user_id].push(p);
    });

    let totalRescheduled = 0;

    for (const [userId, userPending] of Object.entries(byUser)) {
      const ids = userPending.map(p => p.id);

      // Mark old as rescheduled
      await supabase
        .from('scheduled_routes')
        .update({ status: 'rescheduled', updated_at: new Date().toISOString() })
        .in('id', ids);

      // Create new entries
      const newEntries = userPending.map((p, idx) => ({
        user_id: userId,
        scheduled_date: nextDateStr,
        client_id: p.client_id,
        priority: 50 + idx,
        status: 'pending',
        original_date: p.original_date || today,
        estimated_duration: 60
      }));

      await supabase.from('scheduled_routes').insert(newEntries);
      totalRescheduled += userPending.length;

      // Create alert for admins
      const { data: admins } = await supabase.from('users').select('id').eq('role', 'admin');
      const userName = userPending[0]?.user?.full_name || 'Vendedor';
      const alertInserts = (admins || []).map(admin => ({
        alert_type: 'route_rescheduled',
        user_id: userId,
        admin_id: admin.id,
        message: `Auto-reprogramación: ${userPending.length} visitas de ${userName} del ${today} → ${nextDateStr}`,
        metadata: { auto: true, count: userPending.length, from: today, to: nextDateStr }
      }));
      if (alertInserts.length > 0) {
        await supabase.from('route_alerts').insert(alertInserts);
      }
    }

    return { rescheduled: totalRescheduled, fromDate: today, toDate: nextDateStr };
  }
  /**
   * Programa una ruta optimizada para un día específico.
   * Borra scheduled_routes pendientes para ese user+fecha y re-inserta con orden TSP.
   */
  async scheduleOptimizedDay(userId, date, clients) {
    if (!userId || !date || !clients || clients.length === 0) {
      throw new Error('Se requiere userId, date y al menos un cliente');
    }

    // Delete existing pending scheduled routes for this user+date
    await supabase
      .from('scheduled_routes')
      .delete()
      .eq('user_id', userId)
      .eq('status', 'pending')
      .eq('scheduled_date', date);

    // Insert each client preserving optimized order (only base columns)
    const inserts = clients.map((c, idx) => ({
      user_id: userId,
      scheduled_date: date,
      client_id: c.id,
      priority: idx,
      status: 'pending',
      original_date: date
    }));

    const batchSize = 100;
    for (let i = 0; i < inserts.length; i += batchSize) {
      const batch = inserts.slice(i, i + batchSize);
      const { error } = await supabase.from('scheduled_routes').insert(batch);
      if (error) throw new Error(`Error insertando rutas programadas: ${error.message}`);
    }

    return { scheduled: inserts.length, date, userId };
  }

  /**
   * Programa ruta optimizada multi-día. Acumulativo: solo borra pending del user+fecha de los días incluidos.
   * @param {string} userId
   * @param {Object} days - { "YYYY-MM-DD": [{id: "..."}, ...], ... }
   */
  async scheduleOptimizedMultiDay(userId, days) {
    if (!userId || !days || Object.keys(days).length === 0) {
      throw new Error('Se requiere userId y al menos un día con clientes');
    }

    let totalScheduled = 0;
    const dates = Object.keys(days).sort();

    for (const date of dates) {
      const clients = days[date];
      if (!clients || clients.length === 0) continue;

      // Delete only pending for this user+date (accumulative - does NOT touch other dates)
      await supabase
        .from('scheduled_routes')
        .delete()
        .eq('user_id', userId)
        .eq('status', 'pending')
        .eq('scheduled_date', date);

      const inserts = clients.map((c, idx) => {
        const row = {
          user_id: userId,
          scheduled_date: date,
          client_id: c.id,
          priority: idx,
          status: 'pending',
          original_date: date
        };
        // V2 columns (may not exist if migration not run)
        if (c.estimatedArrival) row.estimated_arrival = c.estimatedArrival;
        return row;
      });

      const batchSize = 100;
      for (let i = 0; i < inserts.length; i += batchSize) {
        const batch = inserts.slice(i, i + batchSize);
        let { error } = await supabase.from('scheduled_routes').insert(batch);
        if (error && error.message && error.message.includes('estimated_arrival')) {
          // Fallback: strip V2 columns and retry
          const safeBatch = batch.map(({estimated_arrival, ...rest}) => rest);
          const retry = await supabase.from('scheduled_routes').insert(safeBatch);
          error = retry.error;
        }
        if (error) throw new Error(`Error insertando rutas para ${date}: ${error.message}`);
      }

      totalScheduled += inserts.length;
    }

    return { scheduled: totalScheduled, days: dates.length, dates, userId };
  }

  /**
   * Elimina todas las rutas pendientes de un vendedor para una fecha específica.
   */
  async deleteScheduledDay(userId, date) {
    const { data, error } = await supabase
      .from('scheduled_routes')
      .delete()
      .eq('user_id', userId)
      .eq('scheduled_date', date)
      .eq('status', 'pending')
      .select('id');

    if (error) throw new Error(`Error eliminando rutas: ${error.message}`);
    return { deleted: data?.length || 0, date, userId };
  }

  /**
   * Elimina una ruta programada individual por su ID.
   */
  /**
   * Obtiene todas las rutas programadas de HOY para todos los vendedores
   * Usado por el panel de Visitas para saber quién tiene ruta programada
   */
  async getTodayScheduledRoutes() {
    const today = new Date().toISOString().split('T')[0];

    const { data, error } = await supabase
      .from('scheduled_routes')
      .select('*, client:clients(id, external_id, name, fantasy_name, address, commune, lat, lng, segmentation), user:users(id, full_name, role)')
      .eq('scheduled_date', today)
      .eq('status', 'pending')
      .order('user_id')
      .order('priority');

    if (error) throw error;

    // Group by user_id
    const byUser = {};
    (data || []).forEach(sr => {
      if (!byUser[sr.user_id]) byUser[sr.user_id] = [];
      byUser[sr.user_id].push(sr);
    });

    return byUser;
  }

  async deleteScheduledRoute(routeId) {
    const { data, error } = await supabase
      .from('scheduled_routes')
      .delete()
      .eq('id', routeId)
      .eq('status', 'pending')
      .select('id');

    if (error) throw new Error(`Error eliminando ruta: ${error.message}`);
    if (!data || data.length === 0) throw new Error('Ruta no encontrada o ya no está pendiente');
    return { deleted: 1, routeId };
  }
}

module.exports = new RoutesService();
