const {
  mockUsers,
  mockVehicles,
  mockClients,
  mockDailyRoutes,
  mockVisits
} = require('../../config/mockData');

class RoutesServiceMock {
  async startDay({ userId, vehicleId, startKm }) {
    const user = mockUsers.find(u => u.id === userId);
    if (!user) {
      throw new Error('Usuario no encontrado');
    }

    const vehicle = mockVehicles.find(v => v.id === vehicleId && v.status === 'active');
    if (!vehicle) {
      throw new Error('Vehículo no encontrado o no activo');
    }

    const today = new Date().toISOString().split('T')[0];
    const existingRoute = mockDailyRoutes.find(
      r => r.user_id === userId && r.date === today && r.status === 'active'
    );

    if (existingRoute) {
      throw new Error('Ya existe una ruta activa para hoy');
    }

    const route = {
      id: `route-${Date.now()}`,
      user_id: userId,
      vehicle_id: vehicleId,
      date: today,
      start_km: startKm,
      end_km: null,
      total_cost_clp: null,
      status: 'active',
      created_at: new Date().toISOString()
    };

    mockDailyRoutes.push(route);

    return {
      route,
      user: { id: user.id, name: user.full_name },
      vehicle: { id: vehicle.id, plate: vehicle.license_plate }
    };
  }

  async checkIn({ routeId, clientId, outcome, audioUrl }) {
    const route = mockDailyRoutes.find(r => r.id === routeId);
    if (!route) {
      throw new Error('Ruta no encontrada');
    }

    if (route.status !== 'active') {
      throw new Error('La ruta no está activa');
    }

    const client = mockClients.find(c => c.id === clientId);
    if (!client) {
      throw new Error('Cliente no encontrado');
    }

    const visit = {
      id: `visit-${Date.now()}`,
      route_id: routeId,
      client_id: clientId,
      check_in: new Date().toISOString(),
      check_out: null,
      outcome: outcome || 'pending',
      audio_url: audioUrl || null,
      ai_summary: null
    };

    mockVisits.push(visit);
    client.last_visit_at = new Date().toISOString();

    return {
      visit,
      client: { id: client.id, name: client.name }
    };
  }

  async getActiveRoute(userId) {
    const today = new Date().toISOString().split('T')[0];
    const route = mockDailyRoutes.find(
      r => r.user_id === userId && r.date === today && r.status === 'active'
    );

    if (!route) return null;

    const user = mockUsers.find(u => u.id === route.user_id);
    const vehicle = mockVehicles.find(v => v.id === route.vehicle_id);
    const visits = mockVisits
      .filter(v => v.route_id === route.id)
      .map(v => ({
        ...v,
        client: mockClients.find(c => c.id === v.client_id)
      }));

    return {
      ...route,
      user,
      vehicle,
      visits
    };
  }

  // Métodos adicionales para la UI
  getAllUsers() {
    return mockUsers;
  }

  getAllVehicles() {
    return mockVehicles;
  }

  getAllClients() {
    return mockClients;
  }

  getAllRoutes() {
    return mockDailyRoutes.map(route => ({
      ...route,
      user: mockUsers.find(u => u.id === route.user_id),
      vehicle: mockVehicles.find(v => v.id === route.vehicle_id),
      visits_count: mockVisits.filter(v => v.route_id === route.id).length
    }));
  }

  getRouteWithVisits(routeId) {
    const route = mockDailyRoutes.find(r => r.id === routeId);
    if (!route) return null;

    const user = mockUsers.find(u => u.id === route.user_id);
    const vehicle = mockVehicles.find(v => v.id === route.vehicle_id);
    const visits = mockVisits
      .filter(v => v.route_id === route.id)
      .map(v => {
        const client = mockClients.find(c => c.id === v.client_id);
        return {
          ...v,
          client
        };
      })
      .sort((a, b) => new Date(a.check_in) - new Date(b.check_in));

    return {
      ...route,
      user,
      vehicle,
      visits
    };
  }

  getRoutesByUser(userId) {
    return mockDailyRoutes
      .filter(r => r.user_id === userId)
      .map(route => this.getRouteWithVisits(route.id));
  }

  getTodayRoutes() {
    const today = new Date().toISOString().split('T')[0];
    return mockDailyRoutes
      .filter(r => r.date === today)
      .map(route => this.getRouteWithVisits(route.id));
  }

  // =============================================
  // GESTIÓN DE VENDEDORES
  // =============================================

  createUser({ fullName, email, role = 'executive' }) {
    // Verificar email único
    const existing = mockUsers.find(u => u.email.toLowerCase() === email.toLowerCase());
    if (existing) {
      throw new Error('Ya existe un usuario con ese email');
    }

    const user = {
      id: `user-${Date.now()}`,
      email: email.toLowerCase(),
      full_name: fullName,
      role: role,
      created_at: new Date().toISOString()
    };

    mockUsers.push(user);
    return user;
  }

  deleteUser(userId) {
    const index = mockUsers.findIndex(u => u.id === userId);
    if (index === -1) {
      throw new Error('Usuario no encontrado');
    }

    // Verificar que no tenga rutas activas
    const hasActiveRoutes = mockDailyRoutes.some(
      r => r.user_id === userId && r.status === 'active'
    );
    if (hasActiveRoutes) {
      throw new Error('No se puede eliminar: tiene rutas activas');
    }

    mockUsers.splice(index, 1);
    return true;
  }

  // =============================================
  // GESTIÓN DE VEHÍCULOS
  // =============================================

  createVehicle({ licensePlate, model, fuelEfficiency = 12 }) {
    // Verificar patente única
    const existing = mockVehicles.find(
      v => v.license_plate.toLowerCase() === licensePlate.toLowerCase()
    );
    if (existing) {
      throw new Error('Ya existe un vehículo con esa patente');
    }

    const vehicle = {
      id: `vehicle-${Date.now()}`,
      license_plate: licensePlate.toUpperCase(),
      model: model,
      fuel_efficiency_kml: parseFloat(fuelEfficiency) || 12,
      status: 'active'
    };

    mockVehicles.push(vehicle);
    return vehicle;
  }

  deleteVehicle(vehicleId) {
    const index = mockVehicles.findIndex(v => v.id === vehicleId);
    if (index === -1) {
      throw new Error('Vehículo no encontrado');
    }

    // Verificar que no esté en uso
    const inUse = mockDailyRoutes.some(
      r => r.vehicle_id === vehicleId && r.status === 'active'
    );
    if (inUse) {
      throw new Error('No se puede eliminar: vehículo en uso');
    }

    mockVehicles.splice(index, 1);
    return true;
  }

  updateVehicleStatus(vehicleId, status) {
    const vehicle = mockVehicles.find(v => v.id === vehicleId);
    if (!vehicle) {
      throw new Error('Vehículo no encontrado');
    }

    if (!['active', 'maintenance', 'inactive'].includes(status)) {
      throw new Error('Estado no válido');
    }

    vehicle.status = status;
    return vehicle;
  }
}

module.exports = new RoutesServiceMock();
