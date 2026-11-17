import postgres from 'npm:postgres@3.4.5';
import { createHandler } from './handler.ts';
import { parsePresets } from './ics.ts';
import presetsYaml from './presets.generated.ts';

// effort_estimates was created by the old Render server.js; this role owns it, so RLS doesn't apply
const sql = postgres(Deno.env.get('SUPABASE_DB_URL')!, { prepare: false, max: 3 });

// Same table server.js creates for start dates; created here too in case server.js never ran
let startDatesReady: Promise<unknown> | null = null;
const startDatesTable = () => startDatesReady ||= sql`
  CREATE TABLE IF NOT EXISTS event_start_dates (
    task_id    TEXT NOT NULL PRIMARY KEY,
    start_date TEXT NOT NULL,
    votes      JSONB DEFAULT '{}'::JSONB,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`.catch(err => { startDatesReady = null; throw err; });

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
    async startDates() {
      await startDatesTable();
      const rows = await sql`SELECT task_id, start_date, votes, updated_at FROM event_start_dates`;
      const out: Record<string, any> = {};
      rows.forEach((r: any) => {
        out[r.task_id] = { startDate: r.start_date, votes: r.votes || {}, updatedAt: new Date(r.updated_at).toISOString() };
      });
      return out;
    },
    async saveStartDate({ taskId, startDate, voterId }) {
      await startDatesTable();
      await sql`INSERT INTO event_start_dates (task_id, start_date, votes) VALUES (${taskId}, ${startDate}, ${sql.json({ [voterId]: true })})
        ON CONFLICT (task_id) DO UPDATE SET start_date = EXCLUDED.start_date, votes = EXCLUDED.votes, updated_at = now()`;
    },
  },
}));
