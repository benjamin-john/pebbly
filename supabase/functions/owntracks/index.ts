// Supabase Edge Function entry point. The work is in handler.js (also run by tests/owntracks_test.js in Node).
// Deployed by .github/workflows/deploy-functions.yml with --no-verify-jwt: OwnTracks sends no Supabase key; the
// personal key in the address is what's checked.
import { handle } from './handler.js';

Deno.serve((req: Request) => handle(req, { env: (name: string) => Deno.env.get(name) }));
