// Summarises the trivy and opengrep JSON reports the way the reviewers score them.
// Exit code 1 if any opengrep ERROR/WARNING or any trivy finding remains.
import { readFileSync } from 'node:fs';

const [trivyPath, opengrepPath] = process.argv.slice(2);
let failing = 0;

const trivy = JSON.parse(readFileSync(trivyPath, 'utf8'));
const trivyCounts = new Map([
  ['Vulnerabilities', 0],
  ['Secrets', 0],
  ['Misconfigurations', 0],
  ['Licenses', 0],
]);
for (const result of trivy.Results ?? []) {
  for (const [kind, items] of Object.entries(result)) {
    if (!trivyCounts.has(kind) || !Array.isArray(items)) continue;
    for (const item of items) {
      trivyCounts.set(kind, (trivyCounts.get(kind) ?? 0) + 1);
      console.log(
        `trivy ${kind} ${item.Severity ?? ''} ${result.Target}: ${item.ID ?? item.RuleID ?? item.Name ?? ''} ${item.Title ?? ''}`,
      );
    }
  }
}
console.log('trivy', Object.fromEntries(trivyCounts));
for (const n of trivyCounts.values()) failing += n;

const og = JSON.parse(readFileSync(opengrepPath, 'utf8'));
const bySeverity = new Map();
for (const r of og.results ?? []) {
  const sev = r.extra?.severity ?? 'INFO';
  bySeverity.set(sev, (bySeverity.get(sev) ?? 0) + 1);
  if (sev !== 'INFO') console.log(`opengrep ${sev} ${r.path}:${r.start.line} ${r.check_id}`);
}
console.log('opengrep', Object.fromEntries(bySeverity), `errors=${(og.errors ?? []).length}`);
failing += (bySeverity.get('ERROR') ?? 0) + (bySeverity.get('WARNING') ?? 0);

process.exit(failing ? 1 : 0);
