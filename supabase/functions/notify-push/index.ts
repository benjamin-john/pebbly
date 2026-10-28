// Supabase Edge Function entry point. The work is in handler.js (also run by tests/push_test.js in Node).
// Deployed by .github/workflows/deploy-functions.yml with --no-verify-jwt: the database calls it with no
// key, and anyone calling it can only make it send what's already waiting.
import { handle } from './handler.js';

Deno.serve((req: Request) => handle(req, { env: (name: string) => Deno.env.get(name) }));
