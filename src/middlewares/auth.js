const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'leker-default-secret-change-me';

/**
 * Middleware: Verify JWT token from Authorization header
 * Attaches req.user = { id, email, role, full_name, zone }
 */
function authenticate(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, error: 'Token no proporcionado' });
  }

  const token = authHeader.slice(7);
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ success: false, error: 'Token inválido o expirado' });
  }
}

/**
 * Middleware factory: Restrict access to specific roles
 * Usage: authorize('admin', 'supervisor')
 */
function authorize(...roles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ success: false, error: 'No autenticado' });
    }
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ success: false, error: 'No tiene permisos para esta acción' });
    }
    next();
  };
}

module.exports = { authenticate, authorize, JWT_SECRET };
