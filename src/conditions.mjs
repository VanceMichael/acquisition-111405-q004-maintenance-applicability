// 适用条件解释器。
//
// 结果是三值的：
//   true        条件成立（applicable）
//   false       条件确定不成立（inapplicable）
//   null        依据不足，无法判断（unknown），绝不能解释成不适用
//
// 支持的表达式语法（来源契约明确的子集）：
//   {all: [expr, ...]} / {any: [expr, ...]} / {not: expr}
//   {ref: '定义id'} / {eq: [配置键, 期望值]}
// 未声明的语法一律视为解释缺口（unknown）并登记问题，不猜测其含义。

const isPlainObject = value =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const unique = values => [...new Set(values)];

export function containsReference(expression) {
  if (!isPlainObject(expression)) return false;
  const keys = Object.keys(expression);
  if (keys.length !== 1) return false;
  const operator = keys[0];
  if (operator === 'ref') return true;
  if (operator === 'all' || operator === 'any') {
    return Array.isArray(expression[operator]) && expression[operator].some(containsReference);
  }
  if (operator === 'not') return containsReference(expression.not);
  return false;
}

// 判断表达式是否属于契约声明的语法形状（不解析 ref 指向）。
function isDeclaredShape(expression) {
  if (!isPlainObject(expression)) return false;
  const keys = Object.keys(expression);
  if (keys.length !== 1) return false;
  const [operator] = keys;
  if (operator === 'all' || operator === 'any') {
    return Array.isArray(expression[operator]) && expression[operator].every(isDeclaredShape);
  }
  if (operator === 'not') return isDeclaredShape(expression.not);
  if (operator === 'ref') return typeof expression.ref === 'string' && expression.ref.length > 0;
  if (operator === 'eq') {
    return Array.isArray(expression.eq) && expression.eq.length === 2
      && typeof expression.eq[0] === 'string' && expression.eq[0].length > 0;
  }
  return false;
}

const joinPath = (base, segment) => (base ? `${base}.${segment}` : segment);

/**
 * 解释一个条件表达式。
 * @returns {{result: boolean|null, missing: string[], unknownKeys: string[], problems: Array}}
 *   missing      无法解析的条件定义/表达式位置
 *   unknownKeys  解释过程中读到的、值为 null 或缺失的设备配置键
 *   problems     语法不支持等可复核问题（带来源定位）
 */
export function evaluate(expression, {configuration, definitions, location = '$', problems = []} = {}) {
  const missing = [];
  const unknownKeys = [];

  const resolve = (node, path, stack, memo) => {
    if (!isDeclaredShape(node)) {
      missing.push(path);
      problems.push({
        code: 'CONDITION_UNSUPPORTED',
        location: path,
        message: '条件表达式不在来源契约声明的语法范围内'
      });
      return null;
    }
    const [operator] = Object.keys(node);

    if (operator === 'eq') {
      const [key, expected] = node.eq;
      if (!(key in configuration) || configuration[key] === null) {
        unknownKeys.push(key);
        return null;
      }
      // 严格相等，禁止隐式类型转换。
      return Object.is(configuration[key], expected);
    }

    if (operator === 'not') {
      const child = resolve(node.not, joinPath(path, 'not'), stack, memo);
      return child === null ? null : !child;
    }

    if (operator === 'all' || operator === 'any') {
      const children = node[operator];
      const values = children.map((child, index) =>
        resolve(child, joinPath(path, `${operator}[${index}]`), stack, memo));
      if (operator === 'all') {
        if (values.includes(false)) return false;
        return values.includes(null) ? null : true;
      }
      if (values.includes(true)) return true;
      return values.includes(null) ? null : false;
    }

    // operator === 'ref'
    const id = node.ref;
    const refPath = joinPath(path, `ref(${id})`);
    if (stack.includes(id)) {
      missing.push(refPath);
      problems.push({
        code: 'CONDITION_CYCLE',
        location: refPath,
        definition: id,
        message: `共用条件定义 ${id} 存在互相引用，解释在环路上中止`
      });
      return null;
    }
    if (memo.has(id)) return memo.get(id);
    if (!Object.prototype.hasOwnProperty.call(definitions, id)) {
      missing.push(refPath);
      problems.push({
        code: 'CONDITION_MISSING',
        location: refPath,
        definition: id,
        message: `条件目录缺少定义 ${id}`
      });
      memo.set(id, null);
      return null;
    }
    const value = resolve(definitions[id], `definitions.${id}`, [...stack, id], memo);
    memo.set(id, value);
    return value;
  };

  const result = resolve(expression, location, [], new Map());
  return {result, missing: unique(missing), unknownKeys: unique(unknownKeys), problems};
}
