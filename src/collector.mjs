import {createTransport} from './transport.mjs';
import {normalizeLegacy} from './legacy.mjs';
import {collectSource} from './source.mjs';

export async function collect({baseUrl, archive, mode = 'legacy'}) {
  if (mode === 'legacy') return collectLegacy({baseUrl, archive});
  if (mode === 'source') return collectSource({baseUrl, archive});
  throw new Error(`不支持的领取模式：${mode}`);
}

async function collectLegacy({baseUrl, archive}) {
  const transport = createTransport(baseUrl);
  const response = await transport.request('/legacy');
  if (!response.ok) throw new Error(`摘要领取失败：${response.status}`);
  const records = [normalizeLegacy(response.json())];
  await archive.commit({records, exchanges: transport.exchanges});
  return {records, complete: true, issues: [], evidenceCount: transport.exchanges.length};
}
