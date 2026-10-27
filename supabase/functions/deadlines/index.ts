import postgres from 'npm:postgres@3.4.5';
import { createHandler } from './handler.ts';
import { parsePresets } from './ics.ts';
import presetsYaml from './presets.generated.ts';

// The table already exists (created by server.js on Render); this role owns it, so RLS doesn't apply
const sql = postgres(Deno.env.get('SUPABASE_DB_URL')!, { prepare: false, max: 3 });

Deno.serve(createHandler({
  presets: parsePresets(presetsYaml),
  store: {
    async save({ taskId, voterId, phase, bucket }) {
      if (bucket === null) {
        await sql`DELETE FROM effort_estimates WHERE task_id = ${taskId} AND voter_id = ${voterId} AND phase = ${phase}`;
      } else {
        await sql`INSERT INTO effort_estimates (task_id, voter_id, phase, bucket) VALUES (${taskId}, ${voterId}, ${phase}, ${bucket})
          ON CONFLICT (task_id, voter_id, phase) DO UPDATE SET bucket = EXCLUDED.bucket, updated_at = now()`;
      }
    },
    async rows(voterId) {
      return await sql`SELECT task_id, phase, bucket, count(*)::int AS n, bool_or(voter_id = ${voterId}) AS mine
        FROM effort_estimates GROUP BY task_id, phase, bucket` as any;
    },
  },
}));
