// SaaS backend configuration (Supabase).
// The anon key is public by design — Row Level Security is the real boundary.
// Fill these in from your Supabase project: Settings → API.
module.exports = {
  SUPABASE_URL: 'https://mqquxezbmztnvltbkedn.supabase.co',
  SUPABASE_ANON_KEY: 'sb_publishable_wSF02HAz4Uj-IS1oJzA6Fg_jqOSYK-t',
  // custom protocol the OAuth flow returns through (see auth.js / main.js)
  PROTOCOL: 'loveai',
  REDIRECT_URL: 'loveai://auth-callback'
};
