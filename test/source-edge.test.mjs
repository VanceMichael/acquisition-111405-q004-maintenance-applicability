import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {collect} from '../src/collector.mjs';
import {openArchive} from '../src/archive.mjs';
import {evaluate, containsReference} from '../src/conditions.mjs';

// 边界测试使用独立的最小本地 HTTP 源，按路由表响应；采集代码仍只经 HTTP 取数。
async function startMini(routes) {
  const seen = [];
  const server = createServer((request, response) => {
    seen.push(request.url);
    const route = routes.find(item => item.path === request.url);
    if (!route) { response.writeHead(404).end('未声明'); return; }
    if (route.status && route.status !== 200) { response.writeHead(route.status).end(route.text ?? '错误'); return; }
    const body = route.raw ?? Buffer.from(JSON.stringify(route.body));
    response.writeHead(200, {'content-type': route.type ?? 'application/json'}).end(body);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    seen: () => [...seen],
    close: () => new Promise((resolve, reject) => {
      // 先强制结束 keep-alive 连接，再关闭监听，避免空闲套接字拖住进程退出。
      server.closeAllConnections();
      server.close(error => error ? reject(error) : resolve());
    })
  };
}

async function withArchive(run) {
  const directory = await mkdtemp(join(tmpdir(), 'source-edge-'));
  try {
    await run(directory);
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
}

const catalog = (issue, definitions) => ({path: '/conditions', body: {issue, definitions}});
const config = body => ({path: '/configuration', body});
const manual = (issue, modules) => ({path: '/manual', body: {issue, conditions: '/conditions', modules}});
const modulePage = (id, issue, resources) => ({path: `/module/${id}`, body: {issue, resources}});
const image = (id, status) => ({path: `/image/${id}`, body: `drawing-${id}`, ...(status ? {status} : {})});

test('确定不适用：eq 严格失败给出 inapplicable，不领取任何插图', async () => {
  const source = await startMini([
    manual('i1', [{id: 'm1', href: '/module/m1', condition: {eq: ['model', 'B']}}]),
    config({model: 'C'}), catalog('i1', {}), modulePage('m1', 'i1', ['/image/1']), image('1')
  ]);
  await withArchive(async directory => {
    const result = await collect({baseUrl: source.baseUrl, archive: await openArchive(directory), mode: 'source'});
    assert.equal(result.records[0].applicability, 'inapplicable');
    assert.equal(result.complete, true);
    assert.deepEqual(result.records[0].resources, []);
    assert.equal(source.seen().includes('/image/1'), false);
  });
  await source.close();
});

test('三值逻辑：all/any/not 对 unknown 传播，不塌缩成 inapplicable', async () => {
  const definitions = {
    knownTrue: {eq: ['model', 'B']},
    knownFalse: {eq: ['model', 'C']}
  };
  const problems = [];
  const context = {configuration: {model: 'B', option: null}, definitions, problems};
  assert.equal(evaluate({all: [{ref: 'knownTrue'}, {eq: ['option', true]}]}, context).result, null);
  assert.equal(evaluate({any: [{ref: 'knownFalse'}, {eq: ['option', true]}]}, context).result, null);
  assert.equal(evaluate({any: [{ref: 'knownTrue'}, {eq: ['option', true]}]}, context).result, true);
  assert.equal(evaluate({not: {eq: ['option', true]}}, context).result, null);
  assert.equal(evaluate({not: {ref: 'knownFalse'}}, context).result, true);
  assert.equal(evaluate({all: []}, context).result, true);
  assert.equal(evaluate({any: []}, context).result, false);
});

test('严格相等：字符串 "1" 与数字 1 不隐式转换', async () => {
  const problems = [];
  const outcome = evaluate({eq: ['revision', 1]}, {
    configuration: {revision: '1'}, definitions: {}, problems
  });
  assert.equal(outcome.result, false);
  assert.equal(problems.length, 0);
  const missing = evaluate({eq: ['revision', 1]}, {configuration: {revision: null}, definitions: {}, problems: []});
  assert.equal(missing.result, null);
  assert.deepEqual(missing.unknownKeys, ['revision']);
});

test('ref 循环与缺失定义登记依据并返回 unknown，不抛异常', async () => {
  const problems = [];
  const cyclic = evaluate({ref: 'c1'}, {
    configuration: {model: 'B'},
    definitions: {c1: {ref: 'c2'}, c2: {ref: 'c1'}},
    problems
  });
  assert.equal(cyclic.result, null);
  assert.ok(problems.some(issue => issue.code === 'CONDITION_CYCLE'));
  const absent = evaluate({all: [{ref: 'nope'}, {eq: ['model', 'B']}]}, {
    configuration: {model: 'B'}, definitions: {}, problems: []
  });
  assert.equal(absent.result, null);
  assert.deepEqual(absent.missing, ['$.all[0].ref(nope)']);
  assert.ok(containsReference({all: [{ref: 'x'}]}));
  assert.equal(containsReference({all: [{eq: ['a', 1]}]}), false);
});

test('未声明语法不被猜测，按 unknown 缺口处理', async () => {
  const problems = [];
  const outcome = evaluate({contains: ['title', 'x']}, {
    configuration: {title: 'xyz'}, definitions: {}, problems
  });
  assert.equal(outcome.result, null);
  assert.equal(problems[0].code, 'CONDITION_UNSUPPORTED');
});

test('版本不一致只挡引用目录的模块，内联条件模块独立确认并保留', async () => {
  const source = await startMini([
    manual('i1', [
      {id: 'inline', href: '/module/inline', condition: {eq: ['model', 'B']}},
      {id: 'shared', href: '/module/shared', condition: {ref: 'c1'}}
    ]),
    config({model: 'B'}),
    catalog('i9', {c1: {eq: ['model', 'B']}}),
    modulePage('inline', 'i1', []),
    modulePage('shared', 'i1', [])
  ]);
  await withArchive(async directory => {
    const result = await collect({baseUrl: source.baseUrl, archive: await openArchive(directory), mode: 'source'});
    assert.equal(result.records.length, 1);
    assert.equal(result.records[0].moduleId, 'inline');
    assert.equal(result.records[0].applicability, 'applicable');
    assert.equal(result.complete, false);
    assert.ok(result.issues.some(issue => issue.code === 'CONDITION_ISSUE_MISMATCH'));
    assert.ok(result.issues.some(issue => issue.code === 'MODULE_BLOCKED_CATALOG'));
    assert.equal(source.seen().includes('/module/shared'), false);
  });
  await source.close();
});

test('适用模块的单张插图失败不伪造成功，作业包标记不完整且其余证据保留', async () => {
  const source = await startMini([
    manual('i1', [{id: 'm1', href: '/module/m1', condition: {eq: ['model', 'B']}}]),
    config({model: 'B'}), catalog('i1', {}),
    modulePage('m1', 'i1', ['/image/ok', '/image/bad']),
    {path: '/image/ok', body: 'ok'}, image('bad', 410)
  ]);
  await withArchive(async directory => {
    const result = await collect({baseUrl: source.baseUrl, archive: await openArchive(directory), mode: 'source'});
    const record = result.records[0];
    assert.equal(record.applicability, 'applicable');
    assert.deepEqual(record.resources, ['/image/ok']);
    assert.deepEqual(record.resourceFailures, ['/image/bad']);
    assert.equal(result.complete, false);
    assert.ok(result.issues.some(issue => issue.code === 'RESOURCE_UNAVAILABLE'));
    const snapshot = (await openArchive(directory)).snapshot();
    assert.ok(snapshot.evidence.some(item => item.url.endsWith('/image/ok')));
  });
  await source.close();
});

test('重复资源链接只领取一次，重复领取保持同一记录修订且不堆积问题', async () => {
  const source = await startMini([
    manual('i1', [{id: 'm1', href: '/module/m1', condition: {eq: ['model', 'B']}}]),
    config({model: 'B'}), catalog('i1', {}),
    modulePage('m1', 'i1', ['/image/ok', '/image/ok']), {path: '/image/ok', body: 'ok'}
  ]);
  await withArchive(async directory => {
    const archive = await openArchive(directory);
    const first = await collect({baseUrl: source.baseUrl, archive, mode: 'source'});
    const firstRunCount = source.seen().filter(path => path === '/image/ok').length;
    const again = await collect({baseUrl: source.baseUrl, archive: await openArchive(directory), mode: 'source'});
    assert.deepEqual(first.records[0].resources, ['/image/ok']);
    assert.equal(firstRunCount, 1, '同一作业包内重复链接不重复拉取');
    const snapshot = (await openArchive(directory)).snapshot();
    assert.equal(snapshot.records.length, 1, '重复领取不增加记录修订');
    assert.equal(snapshot.issues.length, again.issues.length);
  });
  await source.close();
});

test('空模块清单是有效空结果：complete=true，区别于错误缺口', async () => {
  const source = await startMini([
    manual('i1', []), config({model: 'B'}), catalog('i1', {})
  ]);
  await withArchive(async directory => {
    const result = await collect({baseUrl: source.baseUrl, archive: await openArchive(directory), mode: 'source'});
    assert.deepEqual(result.records, []);
    assert.deepEqual(result.issues, []);
    assert.equal(result.complete, true);
    assert.ok(result.evidenceCount >= 3, '索引、配置、目录原文仍作为证据归档');
  });
  await source.close();
});

test('越界资源链接不发出请求，模块保留但作业包不完整，其他模块不受影响', async () => {
  const source = await startMini([
    manual('i1', [
      {id: 'm1', href: '/module/m1', condition: {eq: ['model', 'B']}},
      {id: 'm2', href: '/module/m2', condition: {eq: ['model', 'B']}}
    ]),
    config({model: 'B'}), catalog('i1', {}),
    modulePage('m1', 'i1', ['http://example.invalid/image/1']),
    modulePage('m2', 'i1', [])
  ]);
  await withArchive(async directory => {
    const result = await collect({baseUrl: source.baseUrl, archive: await openArchive(directory), mode: 'source'});
    assert.equal(result.records.length, 2);
    const broken = result.records.find(record => record.moduleId === 'm1');
    assert.deepEqual(broken.resources, []);
    assert.deepEqual(broken.resourceFailures, ['http://example.invalid/image/1']);
    assert.equal(result.complete, false);
    assert.ok(result.issues.some(issue => issue.code === 'REQUEST_FAILED' && /越界/.test(issue.message)));
    const fine = result.records.find(record => record.moduleId === 'm2');
    assert.equal(fine.applicability, 'applicable');
  });
  await source.close();
});

test('章节响应版本与手册不一致时该模块不入库，问题带来源定位', async () => {
  const source = await startMini([
    manual('i1', [{id: 'm1', href: '/module/m1', condition: {eq: ['model', 'B']}}]),
    config({model: 'B'}), catalog('i1', {}), modulePage('m1', 'i2', [])
  ]);
  await withArchive(async directory => {
    const result = await collect({baseUrl: source.baseUrl, archive: await openArchive(directory), mode: 'source'});
    assert.deepEqual(result.records, []);
    assert.equal(result.complete, false);
    assert.equal(result.issues[0].code, 'MODULE_ISSUE_MISMATCH');
    assert.equal(result.issues[0].location, '/module/m1');
  });
  await source.close();
});
