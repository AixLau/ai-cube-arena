import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { RunRecord, RunSummary } from '../../shared/types.ts';

const RUN_DIR = path.join(path.resolve(process.env.DATA_DIR || path.join(import.meta.dirname, '../../data')), 'runs');
const SAFE_ID = /^[0-9a-f-]{36}$/;
export const MAX_REPORT_BYTES = 8 * 1024 * 1024;

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

/** 单用户升级兼容：首次带 owner cookie 访问时，将旧记录绑定到该浏览器会话。 */
export async function migrateLegacyRuns(ownerId: string): Promise<void> {
  let changed = false;
  try {
    for (const f of await readdir(RUN_DIR)) {
      if (!f.endsWith('.json')) continue;
      const file = path.join(RUN_DIR, f);
      try {
        const record = JSON.parse(await readFile(file, 'utf8')) as RunRecord;
        if (record.ownerId) continue;
        record.ownerId = ownerId;
        await writeFile(file, JSON.stringify(record));
        changed = true;
      } catch { /* 跳过损坏文件 */ }
    }
  } catch { /* 目录不存在 */ }
  if (changed) index = null;
}

export async function saveRun(record: RunRecord): Promise<boolean> {
  await mkdir(RUN_DIR, { recursive: true });
  let toSave = record;
  let serialized = JSON.stringify(toSave);
  let incomplete = false;
  if (Buffer.byteLength(serialized, 'utf8') > MAX_REPORT_BYTES) {
    incomplete = true;
    toSave = { ...record, reportIncomplete: true, traces: {} };
    serialized = JSON.stringify(toSave);
  }
  await writeFile(path.join(RUN_DIR, `${record.id}.json`), serialized);
  const list = await listRuns();
  const { traces: _t, ...summary } = toSave;
  const i = list.findIndex((r) => r.id === record.id);
  if (i >= 0) list[i] = summary;
  else list.unshift(summary);
  return incomplete;
}

export async function loadRun(id: string): Promise<RunRecord | null> {
  if (!SAFE_ID.test(id)) return null;
  try {
    return JSON.parse(await readFile(path.join(RUN_DIR, `${id}.json`), 'utf8'));
  } catch {
    return null;
  }
}
