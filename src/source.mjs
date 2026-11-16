import {createTransport} from './transport.mjs';
import {digest} from './archive.mjs';
import {containsReference, evaluate} from './conditions.mjs';

const isPlainObject = value =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const unique = values => [...new Set(values)];

// 读取 JSON 文档；传输层已保证响应体落为可复核原文。
// 传输层抛出的故障（越界、超限、网络中断）转成可复核问题，
// 由调用方决定挡裁范围，避免一次故障冲掉其他独立可确认的资料。
async function readJson(transport, path, problems, code) {
  let response;
  try {
    response = await transport.request(path);
  } catch (error) {
    problems.push({code: 'REQUEST_FAILED', location: path, message: error.message});
    return null;
  }
  if (!response.ok) {
    problems.push({code, location: path, status: response.status, message: `来源返回 ${response.status}`});
    return null;
  }
  try {
    return response.json();
  } catch (error) {
    problems.push({code, location: path, message: `响应不是有效JSON：${error.message}`});
    return null;
  }
}

async function safeRequest(transport, path, problems) {
  try {
    return await transport.request(path);
  } catch (error) {
    problems.push({code: 'REQUEST_FAILED', location: path, message: error.message});
    return null;
  }
}

/**
 * 配置化领取：采集章节（module）、插图（resource）以及支持适用判断的条件依据。
 * 仅当模块确定适用时才领取插图；无法确认的模块保留为 unknown，绝不改写成 inapplicable。
 * 条件目录与章节版本对不上时，依赖目录的模块不拼成作业包，但独立可确认的资料照常保留。
 */
export async function collectSource({baseUrl, archive}) {
  const transport = createTransport(baseUrl);
  const problems = [];

  const manual = await readJson(transport, '/manual', problems, 'MANUAL_UNAVAILABLE');
  if (manual === null) {
    // 入口文档拿不到，整条领取无法开始；已收原文仍随证据归档。
    await archive.commit({records: [], exchanges: transport.exchanges, issues: problems});
    return {records: [], complete: false, issues: problems, evidenceCount: transport.exchanges.length};
  }
  if (!isPlainObject(manual) || typeof manual.issue !== 'string' || !manual.issue
    || !Array.isArray(manual.modules) || typeof manual.conditions !== 'string' || !manual.conditions) {
    problems.push({
      code: 'MANUAL_MALFORMED',
      location: '/manual',
      message: '手册索引缺少 issue、conditions 或 modules 字段'
    });
    await archive.commit({records: [], exchanges: transport.exchanges, issues: problems});
    return {records: [], complete: false, issues: problems, evidenceCount: transport.exchanges.length};
  }
  const issue = manual.issue;

  // 设备配置：null 与缺失都表示未知，不能当作确定取值。
  const configurationResponse = await safeRequest(transport, '/configuration', problems);
  let configuration = {};
  if (!configurationResponse.ok) {
    problems.push({
      code: 'CONFIGURATION_UNAVAILABLE',
      location: '/configuration',
      status: configurationResponse.status,
      message: `设备配置领取失败：${configurationResponse.status}`
    });
  } else {
    try {
      const parsed = configurationResponse.json();
      if (!isPlainObject(parsed)) throw new Error('配置不是对象');
      configuration = parsed;
    } catch (error) {
      problems.push({code: 'CONFIGURATION_MALFORMED', location: '/configuration', message: error.message});
    }
  }

  // 条件目录：独立校验自身 issue；与手册 issue 不一致时，引用目录的模块整体挡住。
  const catalogResponse = await safeRequest(transport, manual.conditions, problems);
  let catalog = null;
  let catalogUsable = false;
  if (!catalogResponse.ok) {
    problems.push({
      code: 'CONDITIONS_UNAVAILABLE',
      location: manual.conditions,
      status: catalogResponse.status,
      message: `条件目录领取失败：${catalogResponse.status}`
    });
  } else {
    try {
      catalog = catalogResponse.json();
    } catch (error) {
      problems.push({code: 'CONDITIONS_MALFORMED', location: manual.conditions, message: error.message});
    }
    if (catalog !== null) {
      if (!isPlainObject(catalog) || typeof catalog.issue !== 'string' || !catalog.issue
        || !isPlainObject(catalog.definitions)) {
        problems.push({
          code: 'CONDITIONS_MALFORMED',
          location: manual.conditions,
          message: '条件目录缺少 issue 或 definitions'
        });
      } else if (catalog.issue !== issue) {
        problems.push({
          code: 'CONDITION_ISSUE_MISMATCH',
          location: manual.conditions,
          manualIssue: issue,
          catalogIssue: catalog.issue,
          message: `条件目录版本 ${catalog.issue} 与章节版本 ${issue} 不一致`
        });
      } else {
        catalogUsable = true;
      }
    }
  }
  const definitions = catalog && isPlainObject(catalog.definitions) ? catalog.definitions : {};

  const records = [];
  const collected = []; // 本次实际领取原文的 path，用于回填证据

  for (let index = 0; index < manual.modules.length; index++) {
    const entry = manual.modules[index];
    const entryLocation = `modules[${index}]`;
    if (!isPlainObject(entry) || typeof entry.id !== 'string' || !entry.id
      || typeof entry.href !== 'string' || !entry.href) {
      problems.push({code: 'MODULE_MALFORMED', location: entryLocation, message: '章节条目缺少 id 或 href'});
      continue;
    }
    const moduleLocation = `${entryLocation}(${entry.id})`;

    // 版本对不上时，只有不依赖条件目录的内联表达式还能独立解释。
    if (!catalogUsable && containsReference(entry.condition)) {
      problems.push({
        code: 'MODULE_BLOCKED_CATALOG',
        location: moduleLocation,
        moduleId: entry.id,
        message: '条件目录不可用且章节条件引用共用定义，不生成可用作业包'
      });
      continue;
    }

    let applicability;
    let missingConditions = [];
    if (entry.condition === null || entry.condition === undefined) {
      problems.push({
        code: 'CONDITION_MISSING',
        location: `${moduleLocation}.condition`,
        moduleId: entry.id,
        message: '章节未声明适用条件，适用关系无法确认'
      });
      applicability = 'unknown';
      missingConditions = [`${moduleLocation}.condition`];
    } else {
      const outcome = evaluate(entry.condition, {
        configuration,
        definitions,
        location: `${moduleLocation}.condition`,
        problems
      });
      missingConditions = outcome.missing;
      for (const key of outcome.unknownKeys) {
        problems.push({
          code: 'CONFIGURATION_UNKNOWN',
          location: `/configuration#${key}`,
          moduleId: entry.id,
          configurationKey: key,
          message: `设备属性 ${key} 未知，适用判断保留不确定性`
        });
      }
      applicability = outcome.result === null ? 'unknown'
        : outcome.result ? 'applicable' : 'inapplicable';
    }

    // 章节原文：无论适用与否都领取，使每条结论都有同批次原文支撑。
    const moduleResponse = await safeRequest(transport, entry.href, problems);
    if (moduleResponse === null) {
      problems.push({
        code: 'MODULE_UNAVAILABLE',
        location: entry.href,
        moduleId: entry.id,
        message: '章节原文请求未完成'
      });
      continue;
    }
    if (!moduleResponse.ok) {
      problems.push({
        code: 'MODULE_UNAVAILABLE',
        location: entry.href,
        moduleId: entry.id,
        status: moduleResponse.status,
        message: `章节原文领取失败：${moduleResponse.status}`
      });
      continue;
    }
    let modulePayload;
    try {
      modulePayload = moduleResponse.json();
    } catch (error) {
      problems.push({code: 'MODULE_MALFORMED', location: entry.href, moduleId: entry.id, message: error.message});
      continue;
    }
    if (!isPlainObject(modulePayload) || modulePayload.issue !== issue) {
      problems.push({
        code: 'MODULE_ISSUE_MISMATCH',
        location: entry.href,
        moduleId: entry.id,
        manualIssue: issue,
        moduleIssue: isPlainObject(modulePayload) ? modulePayload.issue : undefined,
        message: '章节响应版本与手册索引不一致'
      });
      continue;
    }
    const resources = Array.isArray(modulePayload.resources) ? modulePayload.resources : [];
    if (!Array.isArray(modulePayload.resources)) {
      problems.push({
        code: 'MODULE_MALFORMED',
        location: `${entry.href}#resources`,
        moduleId: entry.id,
        message: '章节 resources 不是数组'
      });
    }
    if (resources.some(href => typeof href !== 'string' || !href)) {
      problems.push({
        code: 'RESOURCE_LINK_INVALID',
        location: `${entry.href}#resources`,
        moduleId: entry.id,
        message: '章节包含无效的资源相对链接'
      });
      continue;
    }
    collected.push(entry.href);

    // 插图只在确定适用时领取；unknown/inapplicable 不得拉取资源。
    const fetchedResources = [];
    const failedResources = [];
    if (applicability === 'applicable') {
      for (const href of unique(resources)) {
        const resourceResponse = await safeRequest(transport, href, problems);
        if (resourceResponse === null) {
          failedResources.push(href);
          problems.push({
            code: 'RESOURCE_UNAVAILABLE',
            location: href,
            moduleId: entry.id,
            message: '插图原文请求未完成'
          });
          continue;
        }
        if (!resourceResponse.ok) {
          failedResources.push(href);
          problems.push({
            code: 'RESOURCE_UNAVAILABLE',
            location: href,
            moduleId: entry.id,
            status: resourceResponse.status,
            message: `插图原文领取失败：${resourceResponse.status}`
          });
          continue;
        }
        fetchedResources.push(href);
        collected.push(href);
      }
    }

    const record = {
      id: `source:module:${entry.id}`,
      moduleId: entry.id,
      issue,
      href: entry.href,
      applicability,
      missingConditions,
      resources: applicability === 'applicable' ? fetchedResources : [],
      resourceLinks: resources,
      resourceFailures: failedResources
    };
    records.push(record);
  }

  // 回填每条记录引用的原文证据（以内容寻址哈希为准，重复 URL 只算一份）。
  const byPath = new Map();
  for (const exchange of transport.exchanges) {
    byPath.set(new URL(exchange.url).pathname, {...exchange, hash: digest(exchange.bytes)});
  }
  const evidenceRefs = [];
  const seen = new Set();
  for (const path of collected) {
    const exchange = byPath.get(path);
    if (exchange && !seen.has(exchange.hash)) {
      seen.add(exchange.hash);
      evidenceRefs.push({url: exchange.url, hash: exchange.hash});
    }
  }
  for (const record of records) record.evidence = evidenceRefs.filter(ref =>
    ref.url.endsWith(record.href) || record.resources.some(href => ref.url.endsWith(href)));

  // 去重问题，避免重复领取在归档里堆积同一缺口。
  const issues = dedupeIssues(problems);
  const complete = issues.length === 0 && records.every(record => record.applicability !== 'unknown')
    && records.every(record => record.resourceFailures.length === 0);

  await archive.commit({records, exchanges: transport.exchanges, issues});
  return {records, complete, issues, evidenceCount: transport.exchanges.length};
}

function dedupeIssues(issues) {
  const keys = new Set();
  const result = [];
  for (const issue of issues) {
    const key = JSON.stringify(issue);
    if (!keys.has(key)) {
      keys.add(key);
      result.push(issue);
    }
  }
  return result;
}
