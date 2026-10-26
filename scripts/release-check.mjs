import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const root = new URL('..', import.meta.url);

function run(command, args) {
  process.stdout.write(`\n> ${command} ${args.join(' ')}\n`);
  execFileSync(command, args, { cwd: root, stdio: 'inherit', env: process.env });
}

run('npm', ['run', 'typecheck']);
run('npm', ['test']);
run('npm', ['run', 'build']);
run('git', ['diff', '--check']);

// Catch accidental long-lived API keys in tracked source/config files. Test
// fixtures use short synthetic values and are intentionally below this limit.
const tracked = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' })
  .split('\n')
  .filter((file) => file && !file.startsWith('package-lock.json'));
const secretPattern = /sk-[A-Za-z0-9]{32,}/g;
const hits = [];
for (const file of tracked) {
  let source;
  try { source = readFileSync(new URL(file, root), 'utf8'); } catch { continue; }
  secretPattern.lastIndex = 0;
  if (secretPattern.test(source)) hits.push(file);
}
if (hits.length) throw new Error(`可能包含真实 API Key 的文件：${hits.join(', ')}`);

console.log('\nRelease checks passed: typecheck, tests, build, diff check, secret scan.');
