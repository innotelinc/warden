#!/usr/bin/env node
/**
 * Put the Android upload key somewhere that is not this machine.
 *
 * The upload keystore is the app's identity: Play remembers it, and a release
 * signed with anything else is rejected. Losing it to a dead disk therefore costs
 * a support round-trip to reset the upload key, and there is no automation that
 * can recover from it — the key is generated once, by hand, and never derived.
 *
 * This writes a self-contained bundle (keystore, password, restore notes) to a
 * directory you choose, then reads it back and checks the certificate fingerprint
 * which `verify-apk-signature.py` also refuses to publish without. The copy is
 * only durable if that directory is somewhere that outlives the machine: a
 * password manager, a synced folder, a USB stick in a drawer. The script cannot
 * pick that for you, so it prints exactly what to store and what it checks.
 *
 *   node scripts/backup-upload-key.mjs \
 *     --keystore ~/.warden-secrets/warden-upload.keystore \
 *     --password-file ~/.warden-secrets/warden-upload-password.txt \
 *     --dest ~/Documents/warden-upload-key
 *
 * Exit status: 0 the bundle was written and verified, 1 it was not.
 */

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function parseArgs(argv) {
  const args = { dest: path.join(os.homedir(), 'Documents', 'warden-upload-key') };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--keystore') args.keystore = argv[++i];
    else if (flag === '--password-file') args.passwordFile = argv[++i];
    else if (flag === '--dest') args.dest = argv[++i];
    else if (flag === '--keytool') args.keytool = argv[++i];
    else if (flag === '--help' || flag === '-h') args.help = true;
    else throw new Error(`unknown argument: ${flag}`);
  }
  return args;
}

const expand = (value) =>
  value.startsWith('~') ? path.join(os.homedir(), value.slice(1)) : path.resolve(value);

function pinnedFingerprint() {
  const script = fs.readFileSync(new URL('./verify-apk-signature.py', import.meta.url), 'utf8');
  const match = /UPLOAD_KEY_SHA256 = "([0-9A-F:]+)"/.exec(script);
  if (!match) throw new Error('could not find UPLOAD_KEY_SHA256 in verify-apk-signature.py');
  return match[1].toUpperCase();
}

function findKeytool(explicit) {
  const binary = process.platform === 'win32' ? 'keytool.exe' : 'keytool';
  const candidates = [explicit, process.env.KEYTOOL, path.join(os.homedir(), 'jdk')].filter(Boolean);

  for (const candidate of candidates) {
    let stats;
    try {
      stats = fs.statSync(candidate);
    } catch {
      continue;
    }

    // A path straight to the tool, or an unpacked JDK: look one level in for a
    // `bin/` beside it, which is how the portable JDK is laid out.
    if (stats.isFile()) return candidate;

    const guesses = [path.join(candidate, 'bin', binary)];
    try {
      for (const entry of fs.readdirSync(candidate)) guesses.push(path.join(candidate, entry, 'bin', binary));
    } catch {
      // unreadable directory: fall through to the next candidate
    }
    const found = guesses.find((guess) => fs.existsSync(guess));
    if (found) return found;
  }

  return binary;
}

/** The certificate fingerprint, read out of a keystore with keytool. */
function fingerprintOf(keytool, keystore, password) {
  let output;
  try {
    output = execFileSync(keytool, ['-list', '-v', '-keystore', keystore, '-storepass:env', 'WARDEN_KEY_PASS'], {
      env: { ...process.env, WARDEN_KEY_PASS: password },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    throw new Error(
      `keytool could not open the keystore (${error.message.split('\n')[0]}). ` +
        'Pass --keytool, or put one on PATH, so the copy can be verified.',
    );
  }
  const match = /SHA256:\s*([0-9A-F:]{95})/i.exec(output);
  if (!match) throw new Error('keytool printed no SHA256 fingerprint');
  return match[1].toUpperCase();
}

const args = parseArgs(process.argv.slice(2));
if (args.help || !args.keystore || !args.passwordFile) {
  console.log(
    'usage: node scripts/backup-upload-key.mjs --keystore <file> --password-file <file> [--dest <dir>]',
  );
  process.exit(args.help ? 0 : 1);
}

const keystore = expand(args.keystore);
const passwordFile = expand(args.passwordFile);
const dest = expand(args.dest);
const pinned = pinnedFingerprint();

for (const required of [keystore, passwordFile]) {
  if (!fs.existsSync(required)) {
    console.error(`missing: ${required}`);
    process.exit(1);
  }
}

const password = fs.readFileSync(passwordFile, 'utf8').trim();
const keytool = findKeytool(args.keytool);

let sourceFingerprint;
try {
  sourceFingerprint = fingerprintOf(keytool, keystore, password);
} catch (error) {
  // A keystore that will not open is the wrong file or the wrong password, and
  // the stack trace helps nobody: say which and stop.
  console.error(error.message);
  process.exit(1);
}
console.log(`keystore:    ${keystore}`);
console.log(`fingerprint: ${sourceFingerprint}`);

if (sourceFingerprint !== pinned) {
  console.error(
    `\nrefusing to back this up: it is not the key the build checks for.\n` +
      `  expected: ${pinned}\n  found:    ${sourceFingerprint}\n` +
      `Rotating the upload key means changing UPLOAD_KEY_SHA256 in scripts/verify-apk-signature.py and docs/MOBILE.md.`,
  );
  process.exit(1);
}

fs.mkdirSync(dest, { recursive: true, mode: 0o700 });

const copied = {
  keystore: path.join(dest, 'warden-upload.keystore'),
  password: path.join(dest, 'warden-upload-password.txt'),
  readme: path.join(dest, 'RESTORE.md'),
};

fs.copyFileSync(keystore, copied.keystore);
fs.chmodSync(copied.keystore, 0o600);
fs.writeFileSync(copied.password, `${password}\n`, { mode: 0o600 });
fs.writeFileSync(
  copied.readme,
  `# WARDEN Android upload key

Fingerprint (SHA-256): ${sourceFingerprint}
Alias: warden
Type: PKCS12, 4096-bit RSA
Backed up: ${new Date().toISOString()}

This is the key Play knows as WARDEN's upload key. A release signed with anything
else is rejected at upload, and losing this file costs a Play support request to
reset the key. Store this directory somewhere that outlives the laptop — a
password manager entry, a synced folder, an encrypted disk — and not only here.

## Restoring it

1. Put the two files where the build expects them:

       mkdir -p ~/.warden-secrets
       cp warden-upload.keystore warden-upload-password.txt ~/.warden-secrets/
       chmod 600 ~/.warden-secrets/warden-upload-password.txt

2. Check the fingerprint still matches. From the repository root:

       keytool -list -v -keystore ~/.warden-secrets/warden-upload.keystore \\
         -storepass:env WARDEN_KEY_PASS

   with WARDEN_KEY_PASS set from the password file. It must print
   ${sourceFingerprint}

3. Re-create the repository secrets (base64 with no line breaks and no BOM):

       base64 -w0 ~/.warden-secrets/warden-upload.keystore > /tmp/keystore.b64
       gh secret set ANDROID_KEYSTORE_BASE64 < /tmp/keystore.b64
       gh secret set ANDROID_KEYSTORE_PASSWORD   # paste the password, hidden
       gh secret set ANDROID_KEY_ALIAS --body warden
       gh secret set ANDROID_KEY_PASSWORD        # same password
       rm /tmp/keystore.b64

4. Prove it: run Mobile (Android) with dry_run ticked. "Decode keystore" must
   execute rather than skip, and the APK signing check must pass.
`,
  { mode: 0o600 },
);

// Read the copy back and verify it independently, so "backed up" is a fact
// rather than a file that happens to exist.
let copyFingerprint;
try {
  copyFingerprint = fingerprintOf(keytool, copied.keystore, password);
} catch (error) {
  console.error(`\nthe copy could not be verified: ${error.message}`);
  process.exit(1);
}
const originalHash = crypto.createHash('sha256').update(fs.readFileSync(keystore)).digest('hex');
const copyHash = crypto.createHash('sha256').update(fs.readFileSync(copied.keystore)).digest('hex');

console.log(`\nwrote ${dest}`);
console.log(`  ${path.basename(copied.keystore)}  (${fs.statSync(copied.keystore).size} bytes)`);
console.log(`  ${path.basename(copied.password)}`);
console.log(`  ${path.basename(copied.readme)}`);
console.log(`  copy fingerprint: ${copyFingerprint}`);
console.log(`  identical bytes:  ${originalHash === copyHash ? 'yes' : 'NO'}`);

if (copyFingerprint !== pinned || originalHash !== copyHash) {
  console.error('\nthe copy does not match what was backed up — do not rely on it');
  process.exit(1);
}

console.log(
  '\nverified. Copy that directory somewhere that survives this machine:\n' +
    '  - attach both files to a password-manager entry, or\n' +
    '  - mirror it into a synced folder or an encrypted drive.\n' +
    'The repository secrets are not a backup: GitHub never hands a secret value back.',
);
