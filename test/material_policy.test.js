const assert = require('node:assert/strict');

const { isMaterialField, sanitizeMaterialValues } = require('../src/material_policy');

async function main() {
  // 字段识别
  assert.equal(isMaterialField('面料成分'), true);
  assert.equal(isMaterialField('材质'), true);
  assert.equal(isMaterialField('材料成分'), true);
  assert.equal(isMaterialField('颜色'), false);
  assert.equal(isMaterialField('尺寸'), false);

  // 非材质字段、无聚酯冲突：原样返回
  assert.deepEqual(sanitizeMaterialValues('颜色', ['红色', '蓝色']), { values: ['红色', '蓝色'], note: '' });

  // 单值 / 空值：不处理
  assert.deepEqual(sanitizeMaterialValues('面料成分', ['涤纶']), { values: ['涤纶'], note: '' });
  assert.deepEqual(sanitizeMaterialValues('面料成分', []), { values: [], note: '' });

  // 成分/材质字段多值 → 只保留第一个（AI/知识库的主选值）
  const single = sanitizeMaterialValues('面料成分', ['棉', '涤纶']);
  assert.deepEqual(single.values, ['棉']);
  assert.ok(single.note.includes('单一材质'));

  // 涤纶与聚酯同现 → 保第一个，即使字段名不含材质词
  const poly = sanitizeMaterialValues('里料', ['涤纶', '聚酯纤维']);
  assert.deepEqual(poly.values, ['涤纶']);
  assert.ok(poly.note.includes('同属一种纤维'));

  // 材质字段上 涤纶+聚酯+棉：聚酯去重 + 单一材质，最终只留 涤纶
  const mixed = sanitizeMaterialValues('材质', ['涤纶', '聚酯纤维', '棉']);
  assert.deepEqual(mixed.values, ['涤纶']);
  assert.ok(mixed.note.includes('同属一种纤维'));
  assert.ok(mixed.note.includes('单一材质'));

  // 单个值内同时含两词（页面合并选项）不受影响
  const merged = sanitizeMaterialValues('面料成分', ['聚酯纤维(涤纶）', '棉']);
  assert.deepEqual(merged.values, ['聚酯纤维(涤纶）']);
  assert.ok(merged.note.includes('单一材质'));

  // 字符串输入（逗号/中文逗号分隔）同样裁剪
  assert.deepEqual(sanitizeMaterialValues('材质', '涤纶，聚酯纤维').values, ['涤纶']);
  assert.deepEqual(sanitizeMaterialValues('颜色', '红色,蓝色').values, ['红色', '蓝色']);

  // 非材质字段的多聚酯系变体（高弹聚酯纤维）也只留一个
  assert.deepEqual(sanitizeMaterialValues('图案', ['聚酯', '高弹聚酯纤维']).values, ['聚酯']);

  console.log('material_policy.test.js 全部通过');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
