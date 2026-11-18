import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {openArchive} from '../src/archive.mjs';
import {collect} from '../src/collector.mjs';

// 仅测试用的最小来源，按“方法 路径”返回声明的响应并记录实际访问。
async function startStub(routes) {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push({method: request.method, path: request.url});
    const route = routes[request.method + ' ' + request.url];
    if (route === undefined) { response.writeHead(404).end('未声明'); return; }
    const body = typeof route === 'string' ? route : JSON.stringify(route);
    response.writeHead(200, {'content-type': typeof route === 'string' ? 'text/plain' : 'application/json'});
    response.end(body);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    requests: () => structuredClone(requests),
    close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }),
  };
}

async function withSource(routes, run) {
  const directory = await mkdtemp(join(tmpdir(), 'boundary-'));
  const source = await startStub(routes);
  try {
    const archive = await openArchive(directory);
    return {result: await collect({baseUrl: source.baseUrl, archive, mode: 'source'}), archive, source};
  } finally {
    await source.close().catch(() => {});
    await rm(directory, {recursive: true, force: true});
  }
}

const baseRoutes = routes => ({
  'GET /configuration': {},
  'GET /conditions': {issue: 'i1', definitions: {}},
  ...routes,
});

test('条件目录版本冲突不切断可独立确认的内联章节', async () => {
  const routes = baseRoutes({
    'GET /manual': {
      issue: 'i1',
      conditions: '/conditions',
      modules: [
        {id: 'inline', href: '/module/inline', condition: {eq: ['model', 'B']}},
        {id: 'shared', href: '/module/shared', condition: {ref: 'c1'}},
      ],
    },
    'GET /configuration': {model: 'B'},
    'GET /conditions': {issue: 'i2', definitions: {c1: {eq: ['model', 'B']}}},
    'GET /module/inline': {issue: 'i1', resources: ['/image/1']},
    'GET /image/1': 'drawing',
  });
  const {result, source} = await withSource(routes, null);
  assert.equal(result.records.length, 2);
  const inline = result.records.find(record => record.moduleId === 'inline');
  const shared = result.records.find(record => record.moduleId === 'shared');
  assert.equal(inline.applicability, 'applicable');
  assert.deepEqual(inline.resources, ['/image/1']);
  assert.equal(inline.contentVerified, true);
  assert.equal(shared.applicability, 'unknown');
  assert.deepEqual(shared.missingConditions, ['c1']);
  assert.deepEqual(shared.resources, []);
  assert.equal(result.complete, false);
  const codes = result.issues.map(issue => issue.code);
  assert.ok(codes.includes('conditions-issue-mismatch'));
  assert.ok(result.issues.every(issue => typeof issue.url === 'string' && issue.url.startsWith('http://')));
  assert.equal(source.requests().some(request => request.path === '/module/shared'), false);
});

test('空值与缺键都留待确认，不当作不适用', async () => {
  for (const configuration of [{model: null}, {}, {model: 'B', other: true}]) {
    const routes = baseRoutes({
      'GET /manual': {
        issue: 'i1',
        conditions: '/conditions',
        modules: [{id: 'm1', href: '/module/m1', condition: {eq: ['option', true]}}],
      },
      'GET /configuration': configuration,
      'GET /module/m1': {issue: 'i1', resources: ['/image/1']},
      'GET /image/1': 'drawing',
    });
    const {result, source} = await withSource(routes, null);
    const [record] = result.records;
    assert.equal(record.applicability, 'unknown', JSON.stringify(configuration));
    assert.deepEqual(record.missingConditions, ['option']);
    assert.deepEqual(record.resources, []);
    assert.equal(result.complete, false);
    assert.equal(source.requests().some(request => request.path === '/module/m1'), false);
    assert.equal(source.requests().some(request => request.path === '/image/1'), false);
  }
});

test('all/any/not 按三值逻辑短路，确定结论不依赖未决分支', async () => {
  const routes = baseRoutes({
    'GET /manual': {
      issue: 'i1',
      conditions: '/conditions',
      modules: [
        {id: 'and-false', href: '/module/a', condition: {all: [{eq: ['model', 'X']}, {eq: ['option', true]}]}},
        {id: 'or-true', href: '/module/b', condition: {any: [{eq: ['model', 'B']}, {eq: ['option', true]}]}},
        {id: 'not-unknown', href: '/module/c', condition: {not: {eq: ['option', true]}}},
        {id: 'and-true', href: '/module/d', condition: {all: [{eq: ['model', 'B']}]}},
      ],
    },
    'GET /configuration': {model: 'B'},
    'GET /module/b': {issue: 'i1', resources: []},
    'GET /module/d': {issue: 'i1', resources: []},
  });
  const {result, source} = await withSource(routes, null);
  const byId = Object.fromEntries(result.records.map(record => [record.moduleId, record]));
  assert.equal(byId['and-false'].applicability, 'inapplicable');
  assert.deepEqual(byId['and-false'].missingConditions, []);
  assert.equal(byId['or-true'].applicability, 'applicable');
  assert.equal(byId['not-unknown'].applicability, 'unknown');
  assert.deepEqual(byId['not-unknown'].missingConditions, ['option']);
  assert.equal(byId['and-true'].applicability, 'applicable');
  assert.equal(source.requests().some(request => request.path === '/module/a'), false);
  assert.equal(source.requests().some(request => request.path === '/module/c'), false);
  assert.equal(result.complete, false);
});

test('相等判定不做隐式类型转换，确定的不适用仍可判定', async () => {
  const routes = baseRoutes({
    'GET /manual': {
      issue: 'i1',
      conditions: '/conditions',
      modules: [
        {id: 'string-vs-number', href: '/module/a', condition: {eq: ['count', 2]}},
        {id: 'bool-vs-string', href: '/module/b', condition: {eq: ['flag', 'true']}},
      ],
    },
    'GET /configuration': {count: '2', flag: true},
  });
  const {result} = await withSource(routes, null);
  assert.deepEqual(result.records.map(record => record.applicability), ['inapplicable', 'inapplicable']);
  assert.equal(result.complete, true);
});

test('章节内容版本不一致时不拼成作业包，也不领取其资源', async () => {
  const routes = baseRoutes({
    'GET /manual': {
      issue: 'i1',
      conditions: '/conditions',
      modules: [{id: 'm1', href: '/module/m1', condition: {eq: ['model', 'B']}}],
    },
    'GET /configuration': {model: 'B'},
    'GET /module/m1': {issue: 'i2', resources: ['/image/1']},
    'GET /image/1': 'drawing',
  });
  const {result, source} = await withSource(routes, null);
  const [record] = result.records;
  assert.equal(record.applicability, 'applicable');
  assert.deepEqual(record.resources, []);
  assert.equal(record.contentVerified, false);
  assert.equal(result.complete, false);
  assert.ok(result.issues.some(issue => issue.code === 'module-issue-mismatch'));
  assert.equal(source.requests().some(request => request.path === '/image/1'), false);
});

test('重复章节只保留一条记录并留下缺口', async () => {
  const routes = baseRoutes({
    'GET /manual': {
      issue: 'i1',
      conditions: '/conditions',
      modules: [
        {id: 'm1', href: '/module/m1', condition: {eq: ['model', 'B']}},
        {id: 'm1', href: '/module/m1', condition: {eq: ['model', 'B']}},
      ],
    },
    'GET /configuration': {model: 'B'},
    'GET /module/m1': {issue: 'i1', resources: []},
  });
  const {result, source} = await withSource(routes, null);
  assert.equal(result.records.length, 1);
  assert.equal(result.complete, false);
  assert.ok(result.issues.some(issue => issue.code === 'module-duplicate'));
  assert.equal(source.requests().filter(request => request.path === '/module/m1').length, 1);
});

test('缺少条件目录链接不影响内联章节，且每次落库身份稳定', async () => {
  const routes = baseRoutes({
    'GET /manual': {
      issue: 'i1',
      modules: [{id: 'm1', href: '/module/m1', condition: {eq: ['model', 'B']}}],
    },
    'GET /configuration': {model: 'B'},
    'GET /module/m1': {issue: 'i1', resources: ['/image/1']},
    'GET /image/1': 'drawing',
  });
  const directory = await mkdtemp(join(tmpdir(), 'stable-'));
  const source = await startStub(routes);
  try {
    const first = await collect({baseUrl: source.baseUrl, archive: await openArchive(directory), mode: 'source'});
    assert.equal(first.records[0].applicability, 'applicable');
    assert.equal(first.complete, false);
    assert.ok(first.issues.some(issue => issue.code === 'conditions-link-invalid'));
    const second = await collect({baseUrl: source.baseUrl, archive: await openArchive(directory), mode: 'source'});
    assert.equal(second.records[0].id, first.records[0].id);
    const stored = (await openArchive(directory)).snapshot();
    assert.equal(stored.records.length, 1);
    assert.equal(stored.records[0].id, first.records[0].id);
    assert.ok(stored.issues.length >= 2);
  } finally {
    await source.close();
    await rm(directory, {recursive: true, force: true});
  }
});

test('同一归档中人工摘要记录在新来源导入后仍可读取', async () => {
  const routes = {
    'GET /legacy': {id: 'manual-summary', chapter: 'inspection', issue: '0'},
    'GET /manual': {
      issue: 'i1',
      conditions: '/conditions',
      modules: [{id: 'm1', href: '/module/m1', condition: {eq: ['model', 'B']}}],
    },
    'GET /configuration': {model: 'B'},
    'GET /conditions': {issue: 'i1', definitions: {}},
    'GET /module/m1': {issue: 'i1', resources: []},
  };
  const directory = await mkdtemp(join(tmpdir(), 'mixed-'));
  const source = await startStub(routes);
  try {
    await collect({baseUrl: source.baseUrl, archive: await openArchive(directory)});
    const sourced = await collect({baseUrl: source.baseUrl, archive: await openArchive(directory), mode: 'source'});
    assert.equal(sourced.complete, true);
    assert.deepEqual(sourced.issues, []);
    const reopened = await openArchive(directory);
    const snapshot = reopened.snapshot();
    assert.equal(snapshot.records.some(record => record.id === 'manual-summary'), true);
    assert.equal(snapshot.records.some(record => record.id === 'module:i1:m1'), true);
    assert.deepEqual(await reopened.raw(snapshot.evidence[0].hash), Buffer.from(JSON.stringify(
      {id: 'manual-summary', chapter: 'inspection', issue: '0'})));
  } finally {
    await source.close();
    await rm(directory, {recursive: true, force: true});
  }
});
