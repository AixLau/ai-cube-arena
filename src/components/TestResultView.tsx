import type { ConnectionTestResult, ToolSupport } from '../../shared/types.ts';
import { formatMs } from '../lib/format.ts';

const TOOL_TEXT: Record<ToolSupport, string> = {
  supported: '支持工具调用',
  not_called: '未调用工具',
  rejected: '不支持工具调用',
  unknown: '未知',
};

export default function TestResultView({ result }: { result: ConnectionTestResult }) {
  return (
    <div className={`test-result ${result.ok ? 'ok' : 'bad'}`}>
      <div className="test-row">
        <strong>{result.ok ? '✓ 连接成功' : '✕ 连接失败'}</strong>
        <span className="num">{result.httpStatus ? `HTTP ${result.httpStatus}` : ''} {result.latencyMs !== null ? `· ${formatMs(result.latencyMs)}` : ''}</span>
      </div>
      {result.endpoint && <div className="test-endpoint mono">{result.endpoint}</div>}
      <p>{result.message}</p>
      {result.ok && (
        <p>
          <span className={`tag ${result.toolSupport === 'supported' ? 'ok' : 'warn'}`}>{TOOL_TEXT[result.toolSupport]}</span> {result.toolMessage}
          {!result.usageReported && <><br />接口未返回 Token 用量，评测中 Token 与费用将显示为「未知」。</>}
        </p>
      )}
      {result.hints.length > 0 && (
        <ul>
          {result.hints.map((h) => <li key={h}>{h}</li>)}
        </ul>
      )}
      {result.detail && (
        <details>
          <summary>原始响应（已脱敏）</summary>
          <pre>{result.detail}</pre>
        </details>
      )}
    </div>
  );
}
