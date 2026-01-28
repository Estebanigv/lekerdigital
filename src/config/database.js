const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('WARNING: Missing Supabase credentials');
  console.error('SUPABASE_URL:', supabaseUrl ? 'SET' : 'MISSING');
  console.error('SUPABASE_SERVICE_KEY:', supabaseKey ? 'SET' : 'MISSING');
  // Create a dummy client that will fail gracefully
  module.exports = {
    supabase: {
      from: () => ({
        select: () => Promise.resolve({ data: [], error: { message: 'Database not configured' } }),
        insert: () => Promise.resolve({ data: null, error: { message: 'Database not configured' } }),
        update: () => Promise.resolve({ data: null, error: { message: 'Database not configured' } }),
        delete: () => Promise.resolve({ data: null, error: { message: 'Database not configured' } })
      })
    }
  };
} else {
  const supabase = createClient(supabaseUrl, supabaseKey);
  module.exports = { supabase };
}
