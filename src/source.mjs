import {createTransport} from './transport.mjs';

const UNKNOWN = Symbol('unknown');
const NODE_BUDGET = 10_000;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function describe(value) {
  try {
    const text = JSON.stringify(value);
    if (text === undefined) return String(value);
    return text.length > 120 ? `${text.slice(0, 117)}...` : text;
  } catch {
    return String(value);
  }
}

function absoluteUrl(base, path) {
  try { return new URL(path, base).href; }
  catch { return String(path); }
}

function result(value, {missing = [], problems = [], keys = {}, refs = {}, contaminated = false} = {}) {
  return {value, missing: new Set(missing), problems, keys, refs, contaminated};
}

function failure(code, message, url, {missing = [], keys = {}, refs = {}, contaminated = false} = {}) {
  return result(UNKNOWN, {missing, keys, refs, contaminated, problems: [{code, message, url}]});
}

function merge(nodes) {
  return {
    problems: nodes.flatMap(node => node.problems),
    keys: Object.assign({}, ...nodes.map(node => node.keys)),
    refs: Object.assign({}, ...nodes.map(node => node.refs)),
    contaminated: nodes.some(node => node.contaminated),
  };
}

/*
 * 三值语义：true 适用、false 不适用、UNKNOWN 无法判定。
 * 未知不会被假值兜底；无法判定、语法未声明或引用无法闭合时保持 UNKNOWN，
 * 并记录缺失的条件与来源位置，供调用方放入待确认清单。
 */
function evaluateNode(node, environment, origin, stack) {
  if (environment.budget.remaining <= 0) {
    return failure('condition-too-complex', '条件表达式超过可解释的规模上限', origin, {contaminated: true});
  }
  environment.budget.remaining -= 1;
  if (node === null || node === undefined) {
    return failure('condition-missing', '缺少可解释的条件表达式', origin);
  }
  if (!isPlainObject(node)) {
    return failure('condition-invalid', `条件表达式必须是对象，实际为 ${describe(node)}`, origin);
  }
  const operators = Object.keys(node);
  if (operators.length !== 1) {
    return failure('condition-invalid', '条件表达式必须且只能包含一个操作符', origin);
  }
  const operator = operators[0];
  const argument = node[operator];

  if (operator === 'all' || operator === 'any') {
    if (!Array.isArray(argument) || argument.length === 0) {
      return failure('condition-invalid', `${operator} 需要非空数组`, origin);
    }
    const evaluated = [];
    const missing = new Set();
    let value;
    for (const child of argument) {
      const childResult = evaluateNode(child, environment, origin, stack);
      evaluated.push(childResult);
      if (operator === 'all' && childResult.value === false) { value = false; break; }
      if (operator === 'any' && childResult.value === true) { value = true; break; }
      if (childResult.value === UNKNOWN) for (const name of childResult.missing) missing.add(name);
    }
    const merged = merge(evaluated);
    if (value === undefined) value = missing.size || evaluated.some(item => item.value === UNKNOWN) ? UNKNOWN : operator === 'all';
    return result(value, {...merged, missing: value === UNKNOWN ? missing : [], keys: merged.keys});
  }

  if (operator === 'not') {
    const child = evaluateNode(argument, environment, origin, stack);
    return result(child.value === UNKNOWN ? UNKNOWN : !child.value, {
      missing: child.missing,
      problems: child.problems,
      keys: child.keys,
      refs: child.refs,
      contaminated: child.contaminated,
    });
  }

  if (operator === 'ref') {
    if (typeof argument !== 'string' || !argument) {
      return failure('condition-invalid', 'ref 需要非空定义名', origin);
    }
    if (stack.includes(argument)) {
      const cycle = [...new Set([...stack.slice(stack.indexOf(argument)), argument])];
      return failure('condition-cycle', `条件定义循环引用：${cycle.join(' -> ')}`, origin,
        {missing: cycle, contaminated: true});
    }
    if (!environment.definitionsUsable) {
      return failure('definitions-unusable',
        `条件目录未通过版本核对，无法用定义 ${argument} 解释该章节`,
        environment.conditionsUrl || environment.manualUrl, {missing: [argument]});
    }
    if (!Object.prototype.hasOwnProperty.call(environment.definitions, argument)) {
      return failure('definition-missing', `条件目录缺少定义 ${argument}`, origin, {missing: [argument]});
    }
    if (environment.cache.has(argument)) {
      const cached = environment.cache.get(argument);
      return result(cached.value, {
        missing: cached.missing,
        problems: cached.problems,
        keys: cached.keys,
        refs: cached.refs,
      });
    }
    const definition = environment.definitions[argument];
    const refs = {[argument]: structuredClone(definition)};
    if (!isPlainObject(definition)) {
      return failure('definition-invalid', `条件定义 ${argument} 不是有效表达式`,
        environment.conditionsUrl, {missing: [argument], refs});
    }
    const child = evaluateNode(definition, environment, environment.conditionsUrl, [...stack, argument]);
    const resolved = result(child.value, {
      missing: child.missing,
      problems: child.problems,
      keys: child.keys,
      refs: {...refs, ...child.refs},
      contaminated: child.contaminated,
    });
    // 参与过循环检测的结果依赖当时的引用链，不能跨上下文复用。
    if (!resolved.contaminated) environment.cache.set(argument, resolved);
    return resolved;
  }

  if (operator === 'eq') {
    if (!Array.isArray(argument) || argument.length !== 2) {
      return failure('condition-invalid', 'eq 需要 [键, 值] 两元数组', origin);
    }
    const [key, expected] = argument;
    if (typeof key !== 'string' || !key) {
      return failure('condition-invalid', 'eq 的键必须是非空字符串', origin);
    }
    if (expected !== null && typeof expected === 'object') {
      return failure('condition-invalid', 'eq 的值必须是标量', origin);
    }
    if (!environment.configurationUsable) {
      return failure('configuration-unavailable', `设备配置不可用，无法判断 ${key}`,
        environment.configurationUrl, {missing: [key]});
    }
    if (!Object.prototype.hasOwnProperty.call(environment.configuration, key)) {
      return failure('configuration-missing', `设备配置缺少 ${key}`,
        environment.configurationUrl, {missing: [key]});
    }
    const actual = environment.configuration[key];
    const keys = {[key]: actual};
    if (actual === null) {
      return failure('configuration-unknown', `设备配置 ${key} 为空，无法判断`,
        environment.configurationUrl, {missing: [key], keys});
    }
    if (typeof actual === 'object') {
      return failure('configuration-invalid', `设备配置 ${key} 不是标量，无法判断`,
        environment.configurationUrl, {missing: [key], keys});
    }
    if (expected === null) {
      return failure('configuration-unknown', `设备配置 ${key} 的期望值为空，无法判断`,
        environment.configurationUrl, {missing: [key], keys});
    }
    // 严格比较，不做字符串、数字或布尔的隐式类型转换。
    return result(actual === expected, {keys});
  }

  return failure('condition-unsupported', `不支持的条件操作符 ${operator}`, origin);
}

function sortObject(object) {
  return Object.fromEntries(Object.keys(object).sort().map(key => [key, object[key]]));
}

export function evaluateCondition(condition, {
  configuration = {},
  configurationUsable = true,
  definitions = {},
  definitionsUsable = true,
  manualUrl = '',
  conditionsUrl = '',
  configurationUrl = '',
} = {}) {
  const environment = {
    configuration,
    configurationUsable,
    definitions,
    definitionsUsable,
    manualUrl,
    conditionsUrl,
    configurationUrl,
    cache: new Map(),
    budget: {remaining: NODE_BUDGET},
  };
  const outcome = evaluateNode(condition, environment, manualUrl || conditionsUrl || configurationUrl, []);
  return {
    applicability: outcome.value === UNKNOWN ? 'unknown' : outcome.value ? 'applicable' : 'inapplicable',
    missingConditions: [...outcome.missing].sort(),
    usedConfiguration: sortObject(outcome.keys),
    usedDefinitions: sortObject(outcome.refs),
    problems: outcome.problems,
  };
}

function parseJson(response, label) {
  try { return {value: response.json()}; }
  catch { return {problem: `${label}不是有效 JSON`}; }
}

export async function collectSource({baseUrl, archive}) {
  const transport = createTransport(baseUrl);
  const issues = [];
  const records = [];
  const issueKeys = new Set();

  const manualUrl = absoluteUrl(transport.origin, '/manual');
  const configurationUrl = absoluteUrl(transport.origin, '/configuration');

  function report(code, message, url, details = {}) {
    const item = {code, message, url, ...details};
    const key = JSON.stringify(item);
    if (issueKeys.has(key)) return;
    issueKeys.add(key);
    issues.push(item);
  }

  function receipt() {
    return archive.commit({records, exchanges: transport.exchanges, issues}).then(() => ({
      records,
      complete: issues.length === 0,
      issues,
      evidenceCount: transport.exchanges.length,
    }));
  }

  let manualResponse;
  try {
    manualResponse = await transport.request('/manual');
  } catch (error) {
    report('manual-unavailable', `无法领取来源手册：${error.message}`, manualUrl);
    return receipt();
  }
  if (!manualResponse.ok) {
    report('manual-unavailable', `来源手册返回 ${manualResponse.status}`, manualUrl,
      {status: manualResponse.status});
    return receipt();
  }
  const parsedManual = parseJson(manualResponse, '来源手册');
  if ('problem' in parsedManual) {
    report('manual-invalid', parsedManual.problem, manualUrl, {status: manualResponse.status});
    return receipt();
  }
  const manual = parsedManual.value;
  if (!isPlainObject(manual)) {
    report('manual-invalid', '来源手册不是对象', manualUrl);
    return receipt();
  }
  if (typeof manual.issue !== 'string' || !manual.issue) {
    report('manual-invalid', '来源手册缺少非空的 issue', manualUrl);
    return receipt();
  }
  if (!Array.isArray(manual.modules)) {
    report('manual-invalid', '来源手册缺少 modules 数组', manualUrl);
    return receipt();
  }

  // 设备配置：null 与缺键都表示未知，保持未知而不是不适用。
  let configuration = {};
  let configurationUsable = false;
  try {
    const configurationResponse = await transport.request('/configuration');
    if (!configurationResponse.ok) {
      report('configuration-unavailable', `设备配置返回 ${configurationResponse.status}`,
        configurationUrl, {status: configurationResponse.status});
    } else {
      const parsed = parseJson(configurationResponse, '设备配置');
      if ('problem' in parsed) {
        report('configuration-invalid', parsed.problem, configurationUrl,
          {status: configurationResponse.status});
      } else if (!isPlainObject(parsed.value)) {
        report('configuration-invalid', '设备配置不是键值对象', configurationUrl,
          {status: configurationResponse.status});
      } else {
        configuration = parsed.value;
        configurationUsable = true;
      }
    }
  } catch (error) {
    report('configuration-unavailable', `无法领取设备配置：${error.message}`, configurationUrl);
  }

  // 条件目录 issue 与手册不一致时，不能拿它解释任何 ref；
  // 但手册内联的条件仍可独立判断，不应因目录冲突而全部被挡住。
  let conditionsUrl = null;
  let definitions = {};
  let definitionsUsable = false;
  if (typeof manual.conditions !== 'string' || !manual.conditions) {
    report('conditions-link-invalid', '来源手册缺少条件目录地址', manualUrl);
  } else {
    conditionsUrl = absoluteUrl(transport.origin, manual.conditions);
    try {
      const conditionsResponse = await transport.request(manual.conditions);
      if (!conditionsResponse.ok) {
        report('conditions-unavailable', `条件目录返回 ${conditionsResponse.status}`,
          conditionsUrl, {status: conditionsResponse.status});
      } else {
        const parsed = parseJson(conditionsResponse, '条件目录');
        if ('problem' in parsed) {
          report('conditions-invalid', parsed.problem, conditionsUrl,
            {status: conditionsResponse.status});
        } else if (!isPlainObject(parsed.value)) {
          report('conditions-invalid', '条件目录不是对象', conditionsUrl,
            {status: conditionsResponse.status});
        } else if (typeof parsed.value.issue !== 'string' || !parsed.value.issue
          || !isPlainObject(parsed.value.definitions)) {
          report('conditions-invalid', '条件目录缺少 issue 或 definitions 对象', conditionsUrl,
            {status: conditionsResponse.status});
        } else if (parsed.value.issue !== manual.issue) {
          report('conditions-issue-mismatch',
            `条件目录 issue ${parsed.value.issue} 与手册 issue ${manual.issue} 不一致`, conditionsUrl,
            {status: conditionsResponse.status, expectedIssue: manual.issue, actualIssue: parsed.value.issue});
        } else {
          definitions = parsed.value.definitions;
          definitionsUsable = true;
        }
      }
    } catch (error) {
      report('conditions-unavailable', `无法领取条件目录：${error.message}`, conditionsUrl);
    }
  }

  const seenModules = new Set();

  // 返回本次实际领取到且与手册同一 issue 的插图；仅有 applicable 才调用。
  async function fetchModule(module, moduleUrl) {
    const empty = {resources: [], verified: false};
    let moduleResponse;
    try {
      moduleResponse = await transport.request(module.href);
    } catch (error) {
      report('module-unavailable', `无法领取章节内容：${error.message}`, moduleUrl, {moduleId: module.id});
      return empty;
    }
    if (!moduleResponse.ok) {
      report('module-unavailable', `章节内容返回 ${moduleResponse.status}`, moduleUrl,
        {status: moduleResponse.status, moduleId: module.id});
      return empty;
    }
    const parsed = parseJson(moduleResponse, '章节内容');
    if ('problem' in parsed) {
      report('module-invalid', parsed.problem, moduleUrl,
        {status: moduleResponse.status, moduleId: module.id});
      return empty;
    }
    const content = parsed.value;
    if (!isPlainObject(content) || typeof content.issue !== 'string') {
      report('module-invalid', '章节内容缺少 issue', moduleUrl,
        {status: moduleResponse.status, moduleId: module.id});
      return empty;
    }
    if (content.issue !== manual.issue) {
      report('module-issue-mismatch',
        `章节 issue ${content.issue} 与手册 issue ${manual.issue} 不一致`, moduleUrl,
        {status: moduleResponse.status, moduleId: module.id,
          expectedIssue: manual.issue, actualIssue: content.issue});
      return empty;
    }
    if (!Array.isArray(content.resources)) {
      report('module-invalid', '章节内容缺少 resources 数组', moduleUrl,
        {status: moduleResponse.status, moduleId: module.id});
      return empty;
    }

    const resources = [];
    const fetched = new Set();
    let verified = true;
    for (const reference of content.resources) {
      if (typeof reference !== 'string' || !reference) {
        report('resource-invalid', `章节 ${module.id} 含有无效的资源引用`, moduleUrl,
          {moduleId: module.id});
        verified = false;
        continue;
      }
      if (fetched.has(reference)) continue;
      fetched.add(reference);
      const resourceUrl = absoluteUrl(transport.origin, reference);
      try {
        const resourceResponse = await transport.request(reference);
        if (!resourceResponse.ok) {
          report('resource-unavailable', `插图 ${reference} 返回 ${resourceResponse.status}`, resourceUrl,
            {status: resourceResponse.status, moduleId: module.id, resource: reference});
          verified = false;
          continue;
        }
        resources.push(reference);
      } catch (error) {
        report('resource-unavailable', `无法领取插图 ${reference}：${error.message}`, resourceUrl,
          {moduleId: module.id, resource: reference});
        verified = false;
      }
    }
    return {resources, verified};
  }

  for (const module of manual.modules) {
    if (!isPlainObject(module) || typeof module.id !== 'string' || !module.id) {
      report('module-invalid', '手册含有缺少非空 id 的章节', manualUrl);
      continue;
    }
    if (seenModules.has(module.id)) {
      report('module-duplicate', `手册重复声明章节 ${module.id}`, manualUrl, {moduleId: module.id});
      continue;
    }
    seenModules.add(module.id);

    const hasHref = typeof module.href === 'string' && Boolean(module.href);
    const moduleUrl = hasHref ? absoluteUrl(transport.origin, module.href) : manualUrl;
    if (!hasHref) report('module-invalid', `章节 ${module.id} 缺少内容地址`, manualUrl, {moduleId: module.id});

    const evaluation = evaluateCondition(module.condition, {
      configuration,
      configurationUsable,
      definitions,
      definitionsUsable,
      manualUrl,
      conditionsUrl: conditionsUrl ?? manualUrl,
      configurationUrl,
    });
    for (const problem of evaluation.problems) {
      report(problem.code, problem.message, problem.url, {moduleId: module.id});
    }

    // 仅 applicable 领取章节与插图；unknown 保留缺失依据，也不生成空章节。
    // contentVerified 只适用于已领取的章节：未领取时为 null，领取后核对通过为 true。
    let resources = [];
    let contentVerified = null;
    if (evaluation.applicability === 'applicable' && hasHref) {
      ({resources, verified: contentVerified} = await fetchModule(module, moduleUrl));
    }

    records.push({
      id: `module:${manual.issue}:${module.id}`,
      moduleId: module.id,
      issue: manual.issue,
      applicability: evaluation.applicability,
      resources,
      missingConditions: evaluation.missingConditions,
      condition: module.condition === undefined ? null : structuredClone(module.condition),
      href: hasHref ? module.href : null,
      contentVerified,
      basis: {
        configuration: evaluation.usedConfiguration,
        definitions: evaluation.usedDefinitions,
      },
    });
  }

  return receipt();
}
