// Copies presets.yaml into the Supabase function, which can't read files outside its own folder.
// Run before every deploy (npm run deploy:fn does this).
import { readFileSync, writeFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const yaml = readFileSync(new URL('presets.yaml', root), 'utf8');
writeFileSync(new URL('supabase/functions/deadlines/presets.generated.ts', root),
  `// Generated from presets.yaml by scripts/build-presets.mjs — don't edit\nexport default ${JSON.stringify(yaml)};\n`);
console.log('presets.yaml → supabase/functions/deadlines/presets.generated.ts');
