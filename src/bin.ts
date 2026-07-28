#!/usr/bin/env node
/**
 * bin.ts — the published `mattermark` executable.
 *
 * This is the distribution entry point. It exists only to carry the
 * `#!/usr/bin/env node` shebang (which tsc preserves verbatim at the top of
 * the emitted dist/bin.js) and to hand control to the CLI. Importing cli.js
 * runs its top-level `main(process.argv.slice(2))`, so there is nothing else
 * to do here — keep it a one-line shim so the real surface stays in cli.ts.
 */

import './cli.js';
