import { useSearchParams } from 'react-router-dom';
import ArenaLive from '../components/arena/ArenaLive.tsx';
import ArenaSetup from '../components/arena/ArenaSetup.tsx';
import { useRunStream } from '../lib/useRunStream.ts';

/** 竞技场：未指定测试时创建测试，指定 ?run= 时实时观看 */
export default function ArenaPage() {
  const [params, setParams] = useSearchParams();
  const runId = params.get('run');
  const view = useRunStream(runId);
  if (runId) return <ArenaLive runId={runId} view={view} onNew={() => setParams({})} />;
  return <ArenaSetup onStarted={(id) => setParams({ run: id })} />;
}
