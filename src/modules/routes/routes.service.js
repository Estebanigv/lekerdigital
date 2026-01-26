const { supabase } = require('../../config/database');

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

  // =============================================
  // CLIENTES
  // =============================================

  async getAllClients() {
    const { data, error } = await supabase
      .from('clients')
      .select('*')
      .order('name');

    if (error) throw error;
    return data;
  }

  async createClient(clientData) {
    const { data, error } = await supabase
      .from('clients')
      .insert([clientData])
      .select()
      .single();

    if (error) throw error;
    return data;
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

  async checkIn({ routeId, clientId, outcome, audioUrl }) {
    const { data: route, error: routeError } = await supabase
      .from('daily_routes')
      .select('id, status')
      .eq('id', routeId)
      .single();

    if (routeError || !route) throw new Error('Ruta no encontrada');
    if (route.status !== 'active') throw new Error('La ruta no está activa');

    const { data: client, error: clientError } = await supabase
      .from('clients')
      .select('id, name')
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
        audio_url: audioUrl || null
      }])
      .select()
      .single();

    if (visitError) throw visitError;

    await supabase
      .from('clients')
      .update({ last_visit_at: new Date().toISOString() })
      .eq('id', clientId);

    return {
      visit,
      client: { id: client.id, name: client.name }
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

  async endDay(routeId, endKm) {
    const { data: route } = await supabase
      .from('daily_routes')
      .select('*, vehicle:vehicles(*)')
      .eq('id', routeId)
      .single();

    if (!route) throw new Error('Ruta no encontrada');

    const kmTraveled = endKm - route.start_km;
    const fuelUsed = kmTraveled / (route.vehicle?.fuel_efficiency_kml || 12);
    const fuelPricePerLiter = 1200;
    const totalCost = Math.round(fuelUsed * fuelPricePerLiter);

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
}

module.exports = new RoutesService();
