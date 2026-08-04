#!/usr/bin/env node
/**
 * bin.ts — the published `mattermark` executable.
 *
 * cli-help-banner.ts keeps the general help complete. cli-entry.ts handles the
 * portable-evidence and preflight commands introduced in 0.2, then delegates
 * every established command to cli.ts unchanged.
 */

import './cli-help-banner.js';
import './cli-entry.js';
