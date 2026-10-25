import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { RunRecord, RunSummary } from '../../shared/types.ts';

const RUN_DIR = path.join(path.resolve(process.env.DATA_DIR || path.join(import.meta.dirname, '../../data')), 'runs');
const SAFE_ID = /^[0-9a-f-]{36}$/;

let index: RunSummary[] | null = null;

export async function listRuns(): Promise<RunSummary[]> {
  if (index) return index;
  index = [];
  try {
    for (const f of await readdir(RUN_DIR)) {
      if (!f.endsWith('.json')) continue;
      try {
        const { traces: _t, ...summary } = JSON.parse(await readFile(path.join(RUN_DIR, f), 'utf8')) as RunRecord;
        index.push(summary);
      } catch {
        /* 跳过损坏文件 */
      }
    }
  } catch {
    /* 目录不存在 */
  }
  index.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return index;
}

export async function saveRun(record: RunRecord) {
  await mkdir(RUN_DIR, { recursive: true });
  await writeFile(path.join(RUN_DIR, `${record.id}.json`), JSON.stringify(record));
  const list = await listRuns();
  const { traces: _t, ...summary } = record;
  const i = list.findIndex((r) => r.id === record.id);
  if (i >= 0) list[i] = summary;
  else list.unshift(summary);
}

export async function loadRun(id: string): Promise<RunRecord | null> {
  if (!SAFE_ID.test(id)) return null;
  try {
    return JSON.parse(await readFile(path.join(RUN_DIR, `${id}.json`), 'utf8'));
  } catch {
    return null;
  }
}
