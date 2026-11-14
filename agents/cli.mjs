import { readFile } from 'node:fs/promises';
import { AGENT_SCHEMA_VERSION, createAgent } from './index.mjs';
import { createMockProviders } from './mock.mjs';

const args = process.argv.slice(2);
const offline = args[0] === '--offline';
const mock = args[0] === '--mock' || args[0]?.startsWith('--mock=');
const scenario = mock ? args[0].split('=')[1] : undefined;
const paths = offline || mock ? args.slice(1) : args;
if (paths.length !== 1 || paths[0].startsWith('-') ||
  (scenario !== undefined && !['default', 'search-unavailable', 'route-unavailable'].includes(scenario))) {
  console.error('用法：node agents/cli.mjs [--offline | --mock[=search-unavailable|route-unavailable]] <任务 JSON 文件>');
  process.exitCode = paths[0] === '--help' ? 0 : 2;
} else {
  try {
    const request = JSON.parse(await readFile(paths[0], 'utf8'));
    const agent = createAgent({ providers: offline ? {} : mock ? createMockProviders({ scenario }) : undefined });
    const { result } = await agent.runWorkflow(request ?? {});
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.status === 'ok' ? 0 : 1;
  } catch {
    console.log(JSON.stringify({ schemaVersion: AGENT_SCHEMA_VERSION, runId: null, nodeId: null, attempt: null, status: 'error', error: {
      code: 'INVALID_REQUEST_FILE', message: '无法读取结构化任务 JSON', retryable: false
    } }, null, 2));
    process.exitCode = 2;
  }
}
