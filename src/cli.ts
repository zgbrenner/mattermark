/**
 * cli.ts — the Mattermark command line (Slice 4).
 *
 * A thin surface over workspace.ts, written for the person who actually
 * sends the documents — a paralegal or associate, not a cryptographer.
 * Everything substantive lives in the workspace layer; this file parses
 * arguments, prompts for the passphrase, formats output, and maps failures
 * to exit codes:
 *
 *   0 — success
 *   1 — operational failure (wrong passphrase, no vault, missing file)
 *   2 — usage error (unknown command or flag; usage goes to stderr)
 *
 * Expected failures print one friendly line and never a stack trace.
 * Unexpected failures crash loudly — a swallowed bug in an evidence tool is
 * worse than an ugly stack.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import {
  Workspace,
  initWorkspace,
  openWorkspace,
  workspaceExists,
  renderReportMarkdown,
  SchemeName,
  ProtectOutcome,
  EvidenceReport,
} from './workspace.js';
import type { LayerReport } from './orchestrator.js';
import type { DeliveryMethod, ProtectedCopy } from './registry.js';
import { openTimestampsAnchor } from './ledger/opentimestamps.js';

/* -------------------------------- plumbing -------------------------------- */

/** Usage mistakes: exit 2, message + usage on stderr. */
class UsageError extends Error {}
/** Expected operational failures: exit 1, one friendly line, no stack. */
class CliError extends Error {}

// ANSI color only when stdout is a real terminal and NO_COLOR is unset.
const COLOR = process.stdout.isTTY === true && process.env.NO_COLOR === undefined;
const paint = (code: number) => (s: string) => (COLOR ? `\u001b[${code}m${s}\u001b[0m` : s);
const bold = paint(1);
const dim = paint(2);
const red = paint(31);
const green = paint(32);
const yellow = paint(33);

const DELIVERIES: DeliveryMethod[] = ['email', 'secure-link', 'physical', 'portal', 'other'];

type Values = Record<string, string | boolean | undefined>;

function parseOrUsage(
  args: string[],
  options: Record<string, { type: 'string' | 'boolean' }>,
): { values: Values; positionals: string[] } {
  try {
    const r = parseArgs({ args, options, allowPositionals: true, strict: true });
    return { values: r.values as unknown as Values, positionals: r.positionals };
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : String(err));
  }
}

function onePositional(positionals: string[], cmd: string, what: string): string {
  if (positionals.length !== 1) throw new UsageError(`${cmd} takes exactly one ${what} argument`);
  return positionals[0];
}

function noPositionals(positionals: string[], cmd: string): void {
  if (positionals.length > 0) throw new UsageError(`${cmd} takes no positional arguments`);
}

function vaultDirOf(values: Values): string {
  const v = (values.vault as string | undefined) ?? process.env.MATTERMARK_VAULT;
  return resolve(v && v.length > 0 ? v : 'mattermark-vault');
}

function readInput(path: string): Buffer {
  try {
    return readFileSync(path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw new CliError(`Cannot read ${path} — no such file.`);
    if (code === 'EISDIR') throw new CliError(`Cannot read ${path} — it is a directory, not a file.`);
    throw err;
  }
}

/** Translate known workspace/ledger failures into one-line human messages. */
function asFriendly(err: unknown): Error {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes('decryption failed')) {
    return new CliError('Could not unlock the vault — wrong passphrase, or the file was tampered with.');
  }
  if (msg.includes('hash chain broken')) {
    return new CliError(
      'The vault ledger failed its integrity check — it was altered outside this tool. ' +
        'Do not rely on it; restore from a known-good backup.',
    );
  }
  if (msg.includes('not supported by this build')) {
    return new CliError(`This vault needs a different version of Mattermark: ${msg}.`);
  }
  return err instanceof Error ? err : new Error(msg);
}

/* ------------------------------- passphrase ------------------------------- */

/**
 * Hidden interactive prompt on raw stdin: echo '*' per keystroke, handle
 * backspace, and treat Ctrl-C as a clean abort (restore the terminal first).
 */
function promptHidden(question: string): Promise<string> {
  const stdin = process.stdin;
  const stderr = process.stderr;
  if (!stdin.isTTY) {
    throw new CliError(
      'This command needs the vault passphrase. Set MATTERMARK_PASSPHRASE, or run it in an interactive terminal.',
    );
  }
  return new Promise((resolvePw) => {
    stderr.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    let pw = '';
    const finish = (): void => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off('data', onData);
    };
    const onData = (chunk: Buffer): void => {
      for (const ch of chunk.toString('utf8')) {
        if (ch === '\u0003') {
          // Ctrl-C: restore the terminal before leaving
          finish();
          stderr.write('\n');
          process.exit(130);
        }
        if (ch === '\r' || ch === '\n') {
          finish();
          stderr.write('\n');
          resolvePw(pw);
          return;
        }
        if (ch === '\u007f' || ch === '\b') {
          if (pw.length > 0) {
            pw = pw.slice(0, -1);
            stderr.write('\b \b');
          }
          continue;
        }
        pw += ch;
        stderr.write('*');
      }
    };
    stdin.on('data', onData);
  });
}

async function getPassphrase(question: string): Promise<string> {
  const env = process.env.MATTERMARK_PASSPHRASE;
  if (env !== undefined && env !== '') return env;
  return promptHidden(question);
}

async function openVault(dir: string): Promise<Workspace> {
  if (!workspaceExists(dir)) {
    throw new CliError(
      `No vault at ${dir}. Run \`mattermark init\` first, or point --vault (or MATTERMARK_VAULT) at the right folder.`,
    );
  }
  const pass = await getPassphrase('Vault passphrase: ');
  try {
    return openWorkspace(dir, pass);
  } catch (err) {
    throw asFriendly(err);
  }
}

/* -------------------------------- formatting ------------------------------ */

function row(label: string, value: string): string {
  return `  ${label.padEnd(17)}${value}`;
}

/** Word-wrap prose to a fixed width with a two-space indent. */
function wrap(text: string, width = 78, indent = '  '): string {
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  const lines: string[] = [];
  let line = '';
  for (const w of words) {
    if (line !== '' && (indent + line + ' ' + w).length > width) {
      lines.push(indent + line);
      line = w;
    } else {
      line = line === '' ? w : `${line} ${w}`;
    }
  }
  if (line !== '') lines.push(indent + line);
  return lines.join('\n');
}

function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const fmt = (r: string[]): string => r.map((c, i) => c.padEnd(widths[i])).join('  ').trimEnd();
  return [dim(fmt(headers)), ...rows.map(fmt)].join('\n');
}

function channelSummary(layers: LayerReport[]): string {
  if (layers.length === 0) return 'none';
  return layers
    .map((l) =>
      l.embedded
        ? `${l.codec} (${l.payload ?? 'full'} frame x${l.copiesEmbedded.toFixed(1)})`
        : `${l.codec} (not embedded: ${l.reason ?? 'n/a'})`,
    )
    .join(', ');
}

function copyIsDurable(c: ProtectedCopy): boolean {
  return c.channels.some((l) => l.embedded && (l.codec === 'HG' || l.codec === 'LM'));
}

/* --------------------------------- commands ------------------------------- */

async function cmdInit(args: string[]): Promise<void> {
  const { values, positionals } = parseOrUsage(args, {
    org: { type: 'string' },
    scheme: { type: 'string' },
    vault: { type: 'string' },
  });
  noPositionals(positionals, 'init');
  const scheme = (values.scheme as string | undefined) ?? 'ed25519';
  if (scheme !== 'ed25519' && scheme !== 'hmac') {
    throw new UsageError(`--scheme must be ed25519 or hmac, not "${scheme}"`);
  }
  const dir = vaultDirOf(values);
  if (workspaceExists(dir)) {
    throw new CliError(`A vault already exists at ${dir} — refusing to overwrite it.`);
  }

  let pass = process.env.MATTERMARK_PASSPHRASE;
  if (pass === undefined || pass === '') {
    pass = await promptHidden('Choose a vault passphrase (at least 8 characters): ');
    const again = await promptHidden('Type it again to confirm: ');
    if (pass !== again) throw new CliError('The passphrases did not match — nothing was created.');
  }

  let ws: Workspace;
  try {
    ws = initWorkspace(dir, pass, { orgName: values.org as string | undefined, scheme: scheme as SchemeName });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('at least 8')) {
      throw new CliError(
        'The passphrase must be at least 8 characters — it protects the marking key and the evidence ledger.',
      );
    }
    throw asFriendly(err);
  }

  console.log(`Vault created at ${bold(dir)}`);
  console.log('');
  console.log(row('Organization', ws.config.orgName));
  console.log(row('Scheme', ws.config.scheme));
  console.log('');
  console.log(
    yellow(
      wrap(
        'IMPORTANT: if this passphrase is lost, the ability to attribute leaks is lost ' +
          'with it. There is no reset and no recovery. Store it somewhere your firm can rely on.',
      ),
    ),
  );
}

async function cmdProtect(args: string[]): Promise<void> {
  const { values, positionals } = parseOrUsage(args, {
    matter: { type: 'string' },
    recipient: { type: 'string' },
    version: { type: 'string' },
    out: { type: 'string' },
    delivery: { type: 'string' },
    note: { type: 'string' },
    by: { type: 'string' },
    'search-safe': { type: 'boolean' },
    'homoglyph-density': { type: 'string' },
    'rebuild-pdf': { type: 'boolean' },
    vault: { type: 'string' },
  });
  const file = onePositional(positionals, 'protect', '<file>');
  const matter = values.matter as string | undefined;
  const recipient = values.recipient as string | undefined;
  if (!matter || !recipient) {
    throw new UsageError('protect needs both --matter and --recipient — they are what a recovered mark resolves to');
  }
  const delivery = values.delivery as string | undefined;
  if (delivery !== undefined && !DELIVERIES.includes(delivery as DeliveryMethod)) {
    throw new UsageError(`--delivery must be one of: ${DELIVERIES.join(', ')}`);
  }
  let density: number | undefined;
  if (values['homoglyph-density'] !== undefined) {
    density = Number(values['homoglyph-density']);
    if (!Number.isFinite(density) || density < 0 || density > 1) {
      throw new UsageError('--homoglyph-density must be a number between 0 and 1');
    }
  }

  const bytes = readInput(file);
  const ws = await openVault(vaultDirOf(values));

  let outcome: ProtectOutcome;
  try {
    outcome = ws.protect(
      { name: basename(file), bytes },
      {
        matter,
        recipient,
        version: values.version as string | undefined,
        generatedBy: values.by as string | undefined,
        deliveryMethod: delivery as DeliveryMethod | undefined,
        deliveryNote: values.note as string | undefined,
        searchSafe: values['search-safe'] === true,
        maxHomoglyphDensity: density,
        rebuildPdf: values['rebuild-pdf'] === true,
      },
    );
  } catch (err) {
    // The workspace's PDF refusal is already a complete, actionable message.
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('PDF marking is not supported')) throw new CliError(msg);
    throw asFriendly(err);
  }

  const outPath = values.out !== undefined
    ? resolve(values.out as string)
    : join(dirname(resolve(file)), outcome.suggestedName);
  writeFileSync(outPath, outcome.bytes);

  const survived = outcome.transformTests.filter((t) => t.recovered).length;
  const total = outcome.transformTests.length;
  const pct = total > 0 ? Math.round((survived / total) * 100) : 0;
  const c = outcome.copy;

  console.log(`Protected copy written to ${bold(outPath)}`);
  console.log(dim('Deliver that file — keep the original unsent.'));
  console.log('');
  console.log(row('Matter', c.identity.matterRef));
  console.log(row('Recipient', c.identity.recipientId));
  console.log(row('Version', c.identity.version));
  console.log(row('Issued', c.identity.issuedAt));
  if (c.deliveryMethod !== 'unknown') {
    console.log(row('Delivery', c.deliveryMethod + (c.deliveryNote ? ` — ${c.deliveryNote}` : '')));
  }
  console.log(row('Short ID', `${c.shortIdHex}  ${dim('(use with `mattermark report`)')}`));
  console.log(row('Channels', channelSummary(outcome.result.layers)));
  console.log(
    row(
      'Durable',
      outcome.result.durable
        ? `${green('yes')} — expected to survive routine sanitization`
        : `${red('NO')} — this mark will not survive routine sanitization (see below)`,
    ),
  );
  console.log(row('Survival', `survived ${survived} of ${total} simulated transformations (${pct}%)`));

  // Never truncate or summarize these: the homoglyph search-impact disclosure
  // and the non-durability notice must reach the operator verbatim.
  for (const w of outcome.result.warnings) {
    console.log('');
    console.log(yellow(wrap(`WARNING: ${w}`)));
  }
}

async function cmdIdentify(args: string[]): Promise<void> {
  const { values, positionals } = parseOrUsage(args, {
    record: { type: 'boolean' },
    by: { type: 'string' },
    source: { type: 'string' },
    json: { type: 'boolean' },
    vault: { type: 'string' },
  });
  const file = onePositional(positionals, 'identify', '<file>');
  const bytes = readInput(file);
  const ws = await openVault(vaultDirOf(values));

  const outcome = ws.identify(
    { name: basename(file), bytes },
    {
      record: values.record === true,
      actor: values.by as string | undefined,
      sourceDescription: values.source as string | undefined,
    },
  );

  if (values.json === true) {
    console.log(JSON.stringify(outcome, null, 2));
    return;
  }

  const a = outcome.attribution;
  if (a?.copy) {
    if (a.confidence === 'confirmed') {
      console.log(`${bold(green('CONFIRMED'))} — cryptographically verified`);
    } else {
      console.log(`${bold(yellow('CORROBORATED'))} — registry pointer (64-bit), corroborating evidence only`);
    }
    console.log('');
    console.log('This document was issued to:');
    console.log(row('Matter', a.copy.identity.matterRef));
    console.log(row('Recipient', a.copy.identity.recipientId));
    console.log(row('Version', a.copy.identity.version));
    console.log(row('Issued', a.copy.identity.issuedAt));
    console.log(row('Channels', a.channels.join(' + ')));
    console.log(row('Frames', `${a.frames} recovered frame${a.frames === 1 ? '' : 's'}`));
    if (a.confidence === 'corroborated') {
      console.log('');
      console.log(
        wrap(
          'Treat this as supporting evidence: the recovered pointer matches this copy, but it ' +
            'is a 64-bit registry reference, not a self-verifying cryptographic token.',
        ),
      );
    }
    if (values.record === true) {
      console.log('');
      console.log(`Recorded in the investigation ledger${values.by ? ` by ${values.by as string}` : ''}.`);
    }
  } else if (outcome.anyRecovered) {
    console.log(bold(yellow('MARK FOUND — but not from this vault')));
    console.log('');
    console.log(
      wrap(
        "A mark was recovered from this document, but it does not resolve to any copy in this vault's " +
          'registry. It may have been issued from a different vault or by another organization.',
      ),
    );
    if (values.record === true) {
      console.log('');
      console.log('Nothing was recorded — there is no copy of ours to attach the event to.');
    }
  } else {
    console.log(`No mark was found in ${basename(file)}.`);
    console.log('');
    console.log(
      wrap(
        'This does not prove the document was never protected. Routine platform sanitization ' +
          '(Unicode normalization, whitespace collapse, format-character stripping) destroys ' +
          'non-durable marks, and heavy rewriting or retyping can destroy durable ones.',
      ),
    );
    if (values.record === true) {
      console.log('');
      console.log('Nothing was recorded — there is no copy of ours to attach the event to.');
    }
  }
}

async function cmdList(args: string[]): Promise<void> {
  const { values, positionals } = parseOrUsage(args, {
    matter: { type: 'string' },
    json: { type: 'boolean' },
    vault: { type: 'string' },
  });
  noPositionals(positionals, 'list');
  const ws = await openVault(vaultDirOf(values));
  const matter = values.matter as string | undefined;
  const rows = matter !== undefined ? ws.byMatter(matter) : ws.list();

  if (values.json === true) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  if (rows.length === 0) {
    console.log(
      matter !== undefined
        ? `No protected copies on record for matter ${matter}.`
        : 'No protected copies on record yet. Use `mattermark protect` before sending a document.',
    );
    return;
  }
  console.log(
    table(
      ['SHORT ID', 'MATTER', 'RECIPIENT', 'VER', 'ISSUED', 'DURABLE', 'INV'],
      rows.map((c) => [
        c.shortIdHex,
        c.identity.matterRef,
        c.identity.recipientId,
        c.identity.version,
        c.identity.issuedAt.slice(0, 10),
        copyIsDurable(c) ? 'yes' : 'no',
        String(c.investigations.length),
      ]),
    ),
  );
}

async function cmdReport(args: string[]): Promise<void> {
  const { values, positionals } = parseOrUsage(args, {
    out: { type: 'string' },
    json: { type: 'boolean' },
    vault: { type: 'string' },
  });
  const token = onePositional(positionals, 'report', '<token-or-short-id>');
  const ws = await openVault(vaultDirOf(values));

  let rep: EvidenceReport;
  try {
    rep = ws.report(token);
  } catch (err) {
    if (err instanceof Error && err.message.includes('no protected copy')) {
      throw new CliError(
        `No protected copy matches "${token}". Run \`mattermark list\` to see the short IDs on record.`,
      );
    }
    throw asFriendly(err);
  }

  const body = values.json === true ? JSON.stringify(rep, null, 2) : renderReportMarkdown(rep);
  const out = values.out as string | undefined;
  if (out !== undefined) {
    const outPath = resolve(out);
    writeFileSync(outPath, body.endsWith('\n') ? body : body + '\n', 'utf8');
    console.log(`Report written to ${bold(outPath)}`);
  } else {
    console.log(body);
  }
}

async function cmdStatus(args: string[]): Promise<void> {
  const { values, positionals } = parseOrUsage(args, {
    json: { type: 'boolean' },
    vault: { type: 'string' },
  });
  noPositionals(positionals, 'status');
  const ws = await openVault(vaultDirOf(values));
  const st = ws.status();

  if (values.json === true) {
    console.log(JSON.stringify(st, null, 2));
    return;
  }
  console.log(row('Vault', ws.dir));
  console.log(row('Organization', st.config.orgName));
  console.log(row('Scheme', st.config.scheme));
  console.log(row('Copies', String(st.copies)));
  console.log(row('Ledger events', String(st.events)));
  console.log(row('Chain verified', st.chainOk ? green('yes') : red('NO — do not rely on this ledger')));
  console.log(row('Chain head', st.head));
  console.log(row('Merkle root', st.merkleRoot));
  console.log(row('Anchors', String(st.anchors)));
}

async function cmdAnchor(args: string[]): Promise<void> {
  const { values, positionals } = parseOrUsage(args, {
    opentimestamps: { type: 'boolean' },
    ots: { type: 'boolean' },
    local: { type: 'boolean' },
    list: { type: 'boolean' },
    json: { type: 'boolean' },
    vault: { type: 'string' },
  });
  noPositionals(positionals, 'anchor');
  const ws = await openVault(vaultDirOf(values));

  if (values.list === true) {
    const anchors = ws.listAnchors();
    if (values.json === true) {
      console.log(JSON.stringify(anchors, null, 2));
      return;
    }
    if (anchors.length === 0) {
      console.log('No anchors recorded yet. Run `mattermark anchor --opentimestamps` to timestamp the ledger.');
      return;
    }
    console.log(
      table(
        ['RECORDED', 'ANCHOR', 'THIRD-PARTY TIME', 'STATUS'],
        anchors.map((a) => [
          a.recordedAt.slice(0, 19).replace('T', ' '),
          a.proof.anchor,
          a.thirdPartyTime ? 'yes' : 'no',
          a.describe ?? '—',
        ]),
      ),
    );
    return;
  }

  const useOts = values.opentimestamps === true || values.ots === true;
  const useLocal = values.local === true;
  if (useOts === useLocal) {
    throw new UsageError('choose exactly one anchor: --opentimestamps (third-party time) or --local (self-asserted)');
  }

  const anchor = useOts ? openTimestampsAnchor() : ws.localAnchor();

  let stored;
  try {
    stored = await ws.anchorLedger(anchor);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (useOts) {
      throw new CliError(
        `Could not reach an OpenTimestamps calendar: ${msg}. Check the machine's network access and try again; ` +
          'the ledger is unchanged.',
      );
    }
    throw asFriendly(err);
  }

  if (values.json === true) {
    console.log(JSON.stringify(stored, null, 2));
    return;
  }
  console.log(`Anchored the ledger Merkle root through ${bold(stored.proof.anchor)}.`);
  console.log('');
  console.log(row('Merkle root', stored.merkleRoot));
  console.log(row('Recorded', stored.recordedAt));
  console.log(row('Third-party time', stored.thirdPartyTime ? green('yes') : yellow('no (self-asserted)')));
  if (stored.describe) console.log(row('Status', stored.describe));
  if (useOts) {
    console.log('');
    console.log(
      wrap(
        'This is a PENDING OpenTimestamps proof — a calendar promise, not yet in Bitcoin. ' +
          'Re-run `mattermark anchor --opentimestamps` later, or upgrade the stored proof with any ' +
          'OpenTimestamps tool, once the aggregation block confirms (usually within a few hours). ' +
          'Only then is priority provable to a third party.',
      ),
    );
  }
}

/** Contract of src/ui/server.ts, which is optional at runtime. */
interface UiServerModule {
  startUi(
    ws: Workspace,
    opts?: { port?: number; host?: string; open?: boolean },
  ): Promise<{ url: string; close(): Promise<void> }>;
}

async function cmdUi(args: string[]): Promise<void> {
  const { values, positionals } = parseOrUsage(args, {
    port: { type: 'string' },
    'no-open': { type: 'boolean' },
    vault: { type: 'string' },
  });
  noPositionals(positionals, 'ui');
  let port: number | undefined;
  if (values.port !== undefined) {
    port = Number(values.port);
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      throw new UsageError('--port must be an integer between 0 and 65535');
    }
  }
  const ws = await openVault(vaultDirOf(values));

  // The specifier is deliberately typed as plain string so this file
  // typechecks whether or not the UI module exists in this build.
  const spec: string = './ui/server.js';
  let mod: UiServerModule;
  try {
    mod = (await import(spec)) as UiServerModule;
  } catch {
    throw new CliError(
      'The local web UI is not available in this build (src/ui/server.ts failed to load). ' +
        'The rest of the CLI works without it.',
    );
  }

  const { url, close } = await mod.startUi(ws, { port, open: values['no-open'] !== true });
  console.log(`Mattermark UI running at ${bold(url)}`);
  console.log(dim('Local only — nothing leaves this machine. Press Ctrl-C to stop.'));
  await new Promise<void>((done) => {
    const stop = (): void => {
      void close().then(done, done);
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
}

/* ---------------------------------- help ---------------------------------- */

const USAGE = `Usage: mattermark <command> [options]

Commands: init, protect, identify, list, report, anchor, status, ui, help
Global:   --vault <dir> (or MATTERMARK_VAULT); MATTERMARK_PASSPHRASE skips the prompt

Run \`mattermark help\` for a plain-English overview, or
\`mattermark help <command>\` for one command in detail.`;

const GENERAL_HELP = `Mattermark — trace a leaked document back to the recipient it was issued to.

Before a sensitive document goes out, \`protect\` writes a copy that carries
an invisible identifier tied to that one recipient, and records it in an
encrypted, tamper-evident ledger. If the document later surfaces where it
should not, \`identify\` reads the identifier back and tells you whose copy
it was.

Usage: mattermark <command> [options]

Commands:
  init      Set up a vault for your firm or practice group (run once)
  protect   Protect a copy for a recipient before you send it
  identify  Identify who a leaked document was issued to
  list      See every protected copy on record
  report    Produce an evidence report for one protected copy
  anchor    Timestamp the ledger so its records provably predate a dispute
  status    Check the vault and the integrity of its ledger
  ui        Open the point-and-click web interface
  help      Show help for one command, e.g. \`mattermark help protect\`

The vault:
  Keys and the evidence ledger live in one folder — ./mattermark-vault unless
  you pass --vault <dir> or set MATTERMARK_VAULT. Back that folder up.

The passphrase:
  Commands ask for the vault passphrase; typing is hidden. Set
  MATTERMARK_PASSPHRASE to skip the prompt in scripts. If the passphrase is
  lost, the ability to attribute leaks is lost with it. There is no reset.

A typical day:
  mattermark init --org "Dewey & Howe LLP"
  mattermark protect brief.docx --matter M-2026-0141 --recipient jdoe@example.com --delivery email
  mattermark identify leaked.pdf --record --by "K. Reyes" --source "posted to a forum"
  mattermark report 9b3f2ac48e11d07c55aa61f0 --out evidence.md`;

const COMMAND_HELP: Record<string, string> = {
  init: `Set up a vault. Run once per firm or practice group.

Usage: mattermark init [--org <name>] [--scheme ed25519|hmac]

Creates the vault folder holding your organization's marking key and the
encrypted, tamper-evident ledger of protected copies. You will be asked to
choose a passphrase (twice). Everything stays on this machine.

Options:
  --org <name>             Your organization's name, shown on reports
  --scheme ed25519|hmac    Token scheme (default ed25519; hmac produces a
                           shorter mark that fits smaller documents)

If the passphrase is lost, attribution is lost with it. There is no reset.

Example:
  mattermark init --org "Dewey & Howe LLP"`,

  protect: `Protect a copy for a recipient before you send it.

Usage: mattermark protect <file> --matter <ref> --recipient <id> [options]

Marks the document (TXT or DOCX) with an invisible identifier tied to that
one recipient, verifies at issue time what the mark actually survives, and
records the copy in the vault's ledger. Send the written file — not the
original. Protect a separate copy for each recipient.

Options:
  --matter <ref>           Matter or case reference (required)
  --recipient <id>         Who this copy is for, e.g. an email address (required)
  --version <v>            Document version label (default v1)
  --out <file>             Where to write the marked copy (default: next to the input)
  --delivery <method>      email | secure-link | physical | portal | other
  --note <text>            Free-form delivery note, kept in the record
  --by <who>               Who at the firm generated this copy
  --search-safe            Keep exact-match search and spellcheck intact; the
                           mark will NOT survive routine sanitization
                           (a deliberate, disclosed trade-off)
  --homoglyph-density <d>  Cap the confusable-character substitution rate,
                           0 to 1 (lower = more searchable, less resilient)
  --rebuild-pdf            Allow marking a PDF by REBUILDING its text layer.
                           Off by default: the rebuilt PDF keeps the text but
                           discards the original layout, fonts, and images, and
                           the mark is non-durable. Prefer marking the DOCX/text
                           source and exporting to PDF.

Examples:
  mattermark protect brief.docx --matter M-2026-0141 --recipient jdoe@opposing.com --delivery email
  mattermark protect memo.txt --matter M-7 --recipient "Board copy" --search-safe`,

  identify: `Identify who a leaked document was issued to.

Usage: mattermark identify <file> [options]

Reads the invisible identifier out of a recovered document (TXT, DOCX, or
PDF) and matches it against this vault's records. The verdict is graded:
CONFIRMED means the mark re-verified cryptographically; CORROBORATED means a
short registry pointer matched — supporting evidence, not standalone proof.

Options:
  --record         Save this identification to the tamper-evident ledger
  --by <who>       Who performed the identification (for the record)
  --source <desc>  Where the document was found (for the record)
  --json           Machine-readable output

Example:
  mattermark identify leaked.docx --record --by "K. Reyes" --source "attached to anonymous email"`,

  list: `See every protected copy on record.

Usage: mattermark list [--matter <ref>] [--json]

One row per protected copy: who received it, for which matter, when, whether
the mark is durable, and how many investigation events it has (INV).

Example:
  mattermark list --matter M-2026-0141`,

  report: `Produce an evidence report for one protected copy.

Usage: mattermark report <token-or-short-id> [--out <file.md>] [--json]

The report covers the copy's identity, the channels embedded, the issue-time
survival tests, the investigation history, and the ledger integrity proof —
the record you would authenticate under FRE 901(b)(9). Find the short ID
with \`mattermark list\`.

Options:
  --out <file.md>  Write the report to a Markdown file
  --json           Structured JSON instead of Markdown

Example:
  mattermark report 9b3f2ac48e11d07c55aa61f0 --out evidence.md`,

  anchor: `Timestamp the ledger so its records provably predate a dispute.

Usage: mattermark anchor (--opentimestamps | --local) [--json]
       mattermark anchor --list [--json]

The ledger's hash chain proves its records are in order and unaltered, but not
that they existed before a given date. An anchor fixes the ledger's current
state to a clock:

  --opentimestamps  Submit to the OpenTimestamps calendars, which commit your
                    ledger into Bitcoin. Priority becomes provable to anyone who
                    trusts Bitcoin. Needs network access; the fresh proof is
                    PENDING until the Bitcoin block confirms (usually hours).
  --local           Sign with the vault's own key. Instant and offline, but the
                    time is your own word (self-asserted), not a third party's.
  --list            Show the anchors already recorded for this vault.

Every anchor commits to every protected copy issued up to that moment.

Example:
  mattermark anchor --opentimestamps
  mattermark anchor --list`,

  status: `Check the vault and the integrity of its ledger.

Usage: mattermark status [--json]

Shows the organization, scheme, number of protected copies and ledger
events, whether the hash chain verifies, and how many anchors are recorded.
"Chain verified: NO" means the ledger was altered outside this tool — do not
rely on it.`,

  ui: `Open the point-and-click web interface.

Usage: mattermark ui [--port <n>] [--no-open]

Starts a local-only web page for protecting and identifying documents
without the command line. Nothing leaves this machine. Press Ctrl-C to stop.

Options:
  --port <n>  Listen on a specific port (default 8787, or the next open port)
  --no-open   Do not open the browser automatically`,

  help: `Show help.

Usage: mattermark help [command]

Without an argument, prints the plain-English overview. With a command name,
prints that command's options and examples.`,
};

function cmdHelp(args: string[]): number {
  const topic = args[0];
  if (topic === undefined) {
    console.log(GENERAL_HELP);
    return 0;
  }
  const text = COMMAND_HELP[topic];
  if (text === undefined) throw new UsageError(`No such command: ${topic}`);
  console.log(text);
  return 0;
}

/* ---------------------------------- main ---------------------------------- */

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  try {
    if (cmd === undefined || cmd === '--help' || cmd === '-h') return cmdHelp([]);
    if (cmd === 'help') return cmdHelp(rest);
    if (rest.includes('--help') || rest.includes('-h')) return cmdHelp([cmd]);
    switch (cmd) {
      case 'init': await cmdInit(rest); return 0;
      case 'protect': await cmdProtect(rest); return 0;
      case 'identify': await cmdIdentify(rest); return 0;
      case 'list': await cmdList(rest); return 0;
      case 'report': await cmdReport(rest); return 0;
      case 'anchor': await cmdAnchor(rest); return 0;
      case 'status': await cmdStatus(rest); return 0;
      case 'ui': await cmdUi(rest); return 0;
      default: throw new UsageError(`Unknown command: ${cmd}`);
    }
  } catch (err) {
    if (err instanceof UsageError) {
      process.stderr.write(`${err.message}\n\n${USAGE}\n`);
      return 2;
    }
    if (err instanceof CliError) {
      process.stderr.write(`${err.message}\n`);
      return 1;
    }
    throw err; // unexpected: crash with the stack
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    console.error(err);
    process.exitCode = 1;
  },
);
