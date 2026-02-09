const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { supabase } = require('../../config/database');
const { authenticate, authorize, JWT_SECRET } = require('../../middlewares/auth');

const router = express.Router();

const TOKEN_EXPIRY = '8h';

/**
 * POST /api/auth/login
 * Public - Validate email + password, return JWT
 */
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ success: false, error: 'Email y contraseña son requeridos' });
    }

    const { data: user, error } = await supabase
      .from('users')
      .select('id, email, full_name, role, password_hash')
      .eq('email', email.toLowerCase().trim())
      .single();

    if (error || !user) {
      return res.status(401).json({ success: false, error: 'Credenciales inválidas' });
    }

    if (!user.password_hash) {
      return res.status(401).json({ success: false, error: 'Usuario sin contraseña configurada. Contacte al administrador.' });
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ success: false, error: 'Credenciales inválidas' });
    }

    // Update last_login
    await supabase.from('users').update({ last_login: new Date().toISOString() }).eq('id', user.id);

    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role, full_name: user.full_name },
      JWT_SECRET,
      { expiresIn: TOKEN_EXPIRY }
    );

    res.json({
      success: true,
      data: {
        token,
        user: { id: user.id, email: user.email, full_name: user.full_name, role: user.role }
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/auth/me
 * Protected - Returns current user from token
 */
router.get('/me', authenticate, async (req, res) => {
  try {
    const { data: user, error } = await supabase
      .from('users')
      .select('id, email, full_name, role, last_login')
      .eq('id', req.user.id)
      .single();

    if (error || !user) {
      return res.status(404).json({ success: false, error: 'Usuario no encontrado' });
    }

    res.json({ success: true, data: user });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/auth/set-password
 * Admin only - Set password for any user
 */
router.post('/set-password', authenticate, authorize('admin'), async (req, res) => {
  try {
    const { userId, password } = req.body;
    if (!userId || !password) {
      return res.status(400).json({ success: false, error: 'userId y password son requeridos' });
    }

    if (password.length < 4) {
      return res.status(400).json({ success: false, error: 'La contraseña debe tener al menos 4 caracteres' });
    }

    const hash = await bcrypt.hash(password, 10);
    const { error } = await supabase.from('users').update({ password_hash: hash }).eq('id', userId);

    if (error) {
      return res.status(400).json({ success: false, error: error.message });
    }

    res.json({ success: true, message: 'Contraseña actualizada' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/auth/setup
 * Initial setup - Only works if no admin has a password yet
 * Sets password for an admin user
 */
router.post('/setup', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ success: false, error: 'Email y contraseña son requeridos' });
    }

    if (password.length < 4) {
      return res.status(400).json({ success: false, error: 'La contraseña debe tener al menos 4 caracteres' });
    }

    // Check if any admin already has a password
    const { data: adminsWithPw } = await supabase
      .from('users')
      .select('id')
      .eq('role', 'admin')
      .not('password_hash', 'is', null);

    if (adminsWithPw && adminsWithPw.length > 0) {
      return res.status(403).json({ success: false, error: 'Setup ya fue realizado. Use login normal.' });
    }

    // Find the admin user by email
    const { data: user, error } = await supabase
      .from('users')
      .select('id, email, full_name, role')
      .eq('email', email.toLowerCase().trim())
      .eq('role', 'admin')
      .single();

    if (error || !user) {
      return res.status(404).json({ success: false, error: 'No se encontró usuario admin con ese email' });
    }

    const hash = await bcrypt.hash(password, 10);
    await supabase.from('users').update({ password_hash: hash, last_login: new Date().toISOString() }).eq('id', user.id);

    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role, full_name: user.full_name },
      JWT_SECRET,
      { expiresIn: TOKEN_EXPIRY }
    );

    res.json({
      success: true,
      data: {
        token,
        user: { id: user.id, email: user.email, full_name: user.full_name, role: user.role }
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/auth/check-setup
 * Public - Check if initial setup is needed
 */
router.get('/check-setup', async (req, res) => {
  try {
    const { data: adminsWithPw } = await supabase
      .from('users')
      .select('id')
      .eq('role', 'admin')
      .not('password_hash', 'is', null);

    const needsSetup = !adminsWithPw || adminsWithPw.length === 0;
    res.json({ success: true, needsSetup });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
