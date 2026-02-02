const { supabase } = require('../../config/database');

// =============================================
// CONFIGURACIÓN DE VEHÍCULO ESTÁNDAR
// =============================================
const VEHICLE_CONFIG = {
  FUEL_EFFICIENCY_KML: 10,        // 10 km por litro (vehículo estándar)
  FUEL_PRICE_CLP: 1150,           // Precio bencina 93 octanos (CLP/litro)
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

// Algoritmo Nearest Neighbor para TSP (optimización de ruta)
function optimizeRouteOrder(clients, startPoint = null) {
  if (!clients || clients.length === 0) return { route: [], totalDistance: 0 };

  // Filtrar clientes con coordenadas válidas
  const validClients = clients.filter(c => c.lat && c.lng);
  if (validClients.length === 0) return { route: [], totalDistance: 0 };

  const unvisited = [...validClients];
  const route = [];
  let totalDistance = 0;

  // Punto de inicio (si se proporciona, o el primer cliente)
  let current = startPoint && startPoint.lat && startPoint.lng
    ? startPoint
    : unvisited.shift();

  if (!startPoint) {
    route.push(current);
  }

  // Algoritmo Nearest Neighbor: siempre ir al cliente más cercano
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

  // Agregar distancia de retorno al punto inicial
  if (route.length > 1 && startPoint) {
    totalDistance += haversineDistance(
      current.lat, current.lng,
      startPoint.lat, startPoint.lng
    );
  }

  return { route, totalDistance: Math.round(totalDistance * 10) / 10 };
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

  async checkIn({ routeId, clientId, outcome, audioUrl, lat, lng, addressUpdate }) {
    const { data: route, error: routeError } = await supabase
      .from('daily_routes')
      .select('id, status')
      .eq('id', routeId)
      .single();

    if (routeError || !route) throw new Error('Ruta no encontrada');
    if (route.status !== 'active') throw new Error('La ruta no está activa');

    const { data: client, error: clientError } = await supabase
      .from('clients')
      .select('id, name, lat, lng')
      .eq('id', clientId)
      .single();

    if (clientError || !client) throw new Error('Cliente no encontrado');

    const { data: visit, error: visitError } = await supabase
      .from('visits')
      .insert([{
        route_id: routeId,
        client_id: clientId,
        check_in: new Date().toISOString(),
        outcome: outcome || 'pending',
        audio_url: audioUrl || null,
        check_in_lat: lat || null,
        check_in_lng: lng || null
      }])
      .select()
      .single();

    if (visitError) throw visitError;

    // Update client's last visit and potentially coordinates/address
    const updateData = { last_visit_at: new Date().toISOString() };

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

  async getOptimizedRoute(userId, zone = null, startPoint = null) {
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

    const { data: clients, error } = await query;

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

    // Optimizar orden de visitas
    const { route, totalDistance } = optimizeRouteOrder(clients, startPoint);

    // Calcular costos (ida y vuelta)
    const distanceWithReturn = totalDistance * 2; // Ida y vuelta
    const fuelStats = calculateFuelCost(distanceWithReturn);

    return {
      zone: zone || 'Todas las zonas',
      route: route.map((client, index) => ({
        order: index + 1,
        ...client
      })),
      stats: {
        totalClients: route.length,
        ...fuelStats,
        estimatedTime: Math.round(distanceWithReturn / 30 * 60), // ~30 km/h promedio ciudad, en minutos
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

  // Obtiene configuración de vehículo estándar
  getVehicleConfig() {
    return VEHICLE_CONFIG;
  }

  // Calcula distancia y costo entre dos puntos
  calculateDistanceCost(lat1, lng1, lat2, lng2) {
    const distance = haversineDistance(lat1, lng1, lat2, lng2);
    return calculateFuelCost(distance);
  }
}

module.exports = new RoutesService();
