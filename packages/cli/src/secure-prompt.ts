import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';

export async function promptHiddenPassphrase(prompt = 'Keystore passphrase: '): Promise<string> {
  if (!stdin.isTTY || !stdout.isTTY) throw new Error('SECURE_INTERACTIVE_INPUT_REQUIRED');
  stdout.write(prompt);
  const muted = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  const input = createInterface({ input: stdin, output: muted, terminal: true });
  try {
    const passphrase = await input.question('');
    stdout.write('\n');
    if (!passphrase) throw new Error('EMPTY_PASSPHRASE');
    return passphrase;
  } finally {
    input.close();
  }
}

export async function withHiddenPassphrase<T>(operation: (passphrase: string) => Promise<T>): Promise<T> {
  const passphrase = await promptHiddenPassphrase();
  try { return await operation(passphrase); }
  finally { /* JavaScript strings cannot be reliably zeroized; do not retain the reference. */ }
}
