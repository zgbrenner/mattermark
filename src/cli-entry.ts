/**
 * cli-entry.ts — additive command router for Mattermark 0.2.
 *
 * Existing commands continue to run through cli.ts unchanged. New commands are
 * handled here so the mature CLI surface does not need a risky large rewrite.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { openWorkspace, workspaceExists, type Workspace } from './workspace.js';
import { preflightWorkspaceDocument } from './preflight.js';
import { evidenceKeyForWorkspace, exportWorkspaceEvidence } from './workspace-evidence.js';
import { parseEvidenceBundle, verifyEvidenceBundle } from './evidence.js';
import { verifyEvidenceArtifact } from './evidence-artifact.js';

class UsageError extends Error {}
class CliError extends Error {}
type Values = Record<string, string | boolean | undefined>;

const EXTENDED = new Set(['preflight', 'key', 'export', 'verify']);
const USAGE = `Usage: mattermark <command> [options]

New in 0.2:
  preflight <file>              Compare durable and search-safe marking before issuance
  key                           Display the evidence signing-key fingerprint
  export <token> --out <file>   Create a signed portable evidence bundle
  verify <bundle>               Verify a bundle without opening a Mattermark vault

Run mattermark help <command> for details.`;

const HELP: Record<string, string> = {
  preflight: `Usage: mattermark preflight <file> [--rebuild-pdf] [--homoglyph-density <0..1>] [--json]

Analyzes capacity, routine-transform survival, and excerpt recovery without
writing an artifact or changing the evidence ledger.`,
  key: `Usage: mattermark key [--json]

Displays the SHA-256 fingerprint of the workspace evidence key. Publish or
exchange this fingerprint through a trusted channel so other people can pin it.`,
  export: `Usage: mattermark export <token-or-short-id> --out <file> [--artifact <file>] [--json]

Creates a signed portable evidence bundle. The bundle contains sensitive matter
and recipient metadata. --artifact binds a recovered file after confirming that
it attributes to the requested copy.`,
  verify: `Usage: mattermark verify <bundle> [--artifact <file>] [--expect-key <sha256:...>] [--json]

Verifies a bundle offline and without a vault passphrase. --expect-key pins the
signing key. --artifact re-hashes the supplied file and re-runs mark detection.`,
};

function parse(
  args: string[],
  options: Record<string, { type: 'string' | 'boolean' }>,
): { values: Values; positionals: string[] } {
  try {
    const parsed = parseArgs({ args, options, allowPositionals: true, strict: true });
    return { values: parsed.values as Values, positionals: parsed.positionals };
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : String(err));
  }
}

function one(positionals: string[], command: string): string {
  if (positionals.length !== 1) throw new UsageError(`${command} takes exactly one positional argument`);
  return positionals[0];
}

function none(positionals: string[], command: string): void {
  if (positionals.length !== 0) throw new UsageError(`${command} takes no positional arguments`);
}

function vaultDir(values: Values): string {
  const configured = values.vault as string | undefined ?? process.env.MATTERMARK_VAULT;
  return resolve(configured && configured.length > 0 ? configured : 'mattermark-vault');
}

function read(path: string): Buffer {
  try {
    return readFileSync(path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw new CliError(`Cannot read ${path}: no such file.`);
    if (code === 'EISDIR') throw new CliError(`Cannot read ${path}: it is a directory.`);
    throw err;
  }
}

function promptHidden(question: string): Promise<string> {
  if (!process.stdin.isTTY) {
    throw new CliError('Set MATTERMARK_PASSPHRASE or run this command in an interactive terminal.');
  }
  return new Promise((resolvePass) => {
    process.stderr.write(question);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    let pass = '';
    const finish = () => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.off('data', onData);
    };
    const onData = (chunk: Buffer) => {
      for (const ch of chunk.toString('utf8')) {
        if (ch === '\u0003') {
          finish();
          process.stderr.write('\n');
          process.exit(130);
        }
        if (ch === '\r' || ch === '\n') {
          finish();
          process.stderr.write('\n');
          resolvePass(pass);
          return;
        }
        if (ch === '\u007f' || ch === '\b') {
          if (pass.length) {
            pass = pass.slice(0, -1);
            process.stderr.write('\b \b');
          }
        } else {
          pass += ch;
          process.stderr.write('*');
        }
      }
    };
    process.stdin.on('data', onData);
  });
}

async function openVault(values: Values): Promise<Workspace> {
  const dir = vaultDir(values);
  if (!workspaceExists(dir)) throw new CliError(`No vault at ${dir}. Run mattermark init first.`);
  const pass = process.env.MATTERMARK_PASSPHRASE || await promptHidden('Vault passphrase: ');
  try {
    return openWorkspace(dir, pass);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('decryption failed')) throw new CliError('Could not unlock the vault: wrong passphrase or tampering.');
    throw err;
  }
}

function density(values: Values): number | undefined {
  if (values['homoglyph-density'] === undefined) return undefined;
  const value = Number(values['homoglyph-density']);
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new UsageError('--homoglyph-density must be a number between 0 and 1');
  }
  return value;
}

async function preflight(args: string[]): Promise<void> {
  const { values, positionals } = parse(args, {
    'rebuild-pdf': { type: 'boolean' },
    'homoglyph-density': { type: 'string' },
    json: { type: 'boolean' },
    vault: { type: 'string' },
  });
  const file = one(positionals, 'preflight');
  const ws = await openVault(values);
  const result = preflightWorkspaceDocument(
    ws,
    { name: basename(file), bytes: read(file) },
    { rebuildPdf: values['rebuild-pdf'] === true, maxHomoglyphDensity: density(values) },
  );
  if (values.json === true) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`Preflight: ${result.name} (${result.format}, ${result.sourceCharacters} characters)`);
  if (result.blockedReason) console.log(`\nBlocked: ${result.blockedReason}`);
  for (const profile of result.profiles) {
    const survived = profile.transformTests.filter((test) => test.recovered).length;
    console.log(`\n${profile.profile.toUpperCase()}`);
    console.log(`  Markable: ${profile.markable ? 'yes' : 'no'}`);
    console.log(`  Durable: ${profile.durable ? 'yes' : 'no'}`);
    console.log(`  Exact search preserved: ${profile.exactSearchPreserved ? 'yes' : 'no'}`);
    console.log(`  Transform survival: ${survived}/${profile.transformTests.length}`);
    console.log(`  Excerpts: ${profile.excerpts.map((e) => `${Math.round(e.fraction * 100)}% ${e.recovered}/${e.windows}`).join(', ')}`);
    for (const warning of profile.warnings) console.log(`  Warning: ${warning}`);
  }
  console.log(`\nRecommendation: ${result.recommendation}`);
}

async function key(args: string[]): Promise<void> {
  const { values, positionals } = parse(args, {
    json: { type: 'boolean' }, vault: { type: 'string' },
  });
  none(positionals, 'key');
  const ws = await openVault(values);
  const result = evidenceKeyForWorkspace(ws);
  if (values.json === true) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`Evidence key: ${result.keyid}`);
    console.log('Pin or publish this fingerprint through a trusted organizational channel.');
  }
}

async function exportEvidence(args: string[]): Promise<void> {
  const { values, positionals } = parse(args, {
    out: { type: 'string' }, artifact: { type: 'string' }, json: { type: 'boolean' }, vault: { type: 'string' },
  });
  const token = one(positionals, 'export');
  if (typeof values.out !== 'string' || values.out.length === 0) throw new UsageError('export requires --out <file>');
  const ws = await openVault(values);
  const artifactPath = values.artifact as string | undefined;
  const bundle = exportWorkspaceEvidence(ws, token, artifactPath ? {
    artifact: { name: basename(artifactPath), bytes: read(artifactPath) },
  } : {});
  const output = resolve(values.out as string);
  writeFileSync(output, JSON.stringify(bundle, null, 2) + '\n', 'utf8');
  if (values.json === true) {
    console.log(JSON.stringify({ out: output, keyid: bundle.verificationMaterial.publicKey.keyid }, null, 2));
  } else {
    console.log(`Evidence bundle written to ${output}`);
    console.log('WARNING: this bundle contains sensitive matter and recipient metadata.');
  }
}

async function verify(args: string[]): Promise<void> {
  const { values, positionals } = parse(args, {
    artifact: { type: 'string' }, 'expect-key': { type: 'string' }, json: { type: 'boolean' },
  });
  const file = one(positionals, 'verify');
  const bundle = parseEvidenceBundle(read(file).toString('utf8'));
  const result = verifyEvidenceBundle(bundle, { expectedKeyid: values['expect-key'] as string | undefined });
  const artifactPath = values.artifact as string | undefined;
  if (artifactPath) {
    const artifact = verifyEvidenceArtifact(bundle, { name: basename(artifactPath), bytes: read(artifactPath) });
    result.artifact = artifact;
    if (!artifact.digestMatches || !artifact.markMatches) {
      result.valid = false;
      result.trust = 'invalid';
      if (!artifact.digestMatches) result.errors.push('supplied artifact digest does not match the evidence statement');
      if (!artifact.markMatches) result.errors.push('supplied artifact does not contain the protected copy mark');
    }
  }
  if (values.json === true) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(result.valid ? `VALID (${result.trust})` : 'INVALID');
    console.log(`Key: ${result.keyid}`);
    for (const error of result.errors) console.log(`Error: ${error}`);
    for (const warning of result.warnings) console.log(`Warning: ${warning}`);
  }
  if (!result.valid) throw new CliError('Evidence verification failed.');
}

async function run(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];
  if (command === 'help' && args[1] && EXTENDED.has(args[1])) {
    console.log(HELP[args[1]]);
    return;
  }
  if (command && EXTENDED.has(command) && (args.includes('--help') || args.includes('-h'))) {
    console.log(HELP[command]);
    return;
  }
  if (!command || !EXTENDED.has(command)) {
    await import('./cli.js');
    return;
  }
  try {
    if (command === 'preflight') await preflight(args.slice(1));
    else if (command === 'key') await key(args.slice(1));
    else if (command === 'export') await exportEvidence(args.slice(1));
    else await verify(args.slice(1));
  } catch (err) {
    if (err instanceof UsageError) {
      process.stderr.write(`${err.message}\n\n${USAGE}\n`);
      process.exitCode = 2;
      return;
    }
    if (err instanceof CliError) {
      process.stderr.write(`${err.message}\n`);
      process.exitCode = 1;
      return;
    }
    throw err;
  }
}

run().catch((err) => {
  // Known parse and verifier errors should still be friendly when they come
  // from untrusted bundle input.
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
