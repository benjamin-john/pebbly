// Supabase details (same project as Which day works? and Poll).
// It is safe for these two values to be public: schema.sql locks the tables so the key can
// only call the rsvp_* functions. Never put a "secret" or "service_role" key here.
// Leave both blank to try the app in preview mode (data stays in your own browser only).
window.RSVP_CONFIG = {
  SUPABASE_URL: "https://xujtuijpbwujduuzlwat.supabase.co",
  SUPABASE_KEY: "sb_publishable_bpV96pme2gEyfeelqqDYXA_CpAoj9OZ"
};
