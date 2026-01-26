const webhookAuth = (req, res, next) => {
  const webhookSecret = process.env.N8N_WEBHOOK_SECRET;

  // Si no hay secreto configurado, permitir (desarrollo)
  if (!webhookSecret) {
    return next();
  }

  const providedSecret = req.headers['x-webhook-secret'];

  if (providedSecret !== webhookSecret) {
    return res.status(401).json({
      success: false,
      error: 'Invalid webhook secret'
    });
  }

  next();
};

module.exports = { webhookAuth };
