/** 成分/材质类字段的取值约束（纯函数，便于单测）：
 *  1. 成分里的材质最好只选一种：字段名命中 成分/材质/材料 时，多选取值只保留第一个（AI/知识库的主选值）；
 *  2. 涤纶与聚酯是同一种纤维（聚酯纤维=涤纶=Polyester），任何字段都不允许同时保留两个聚酯系值。
 *     页面选项如「聚酯纤维(涤纶)」单个值内同时含两个词，视为一个值，不受影响。 */
const { toArrayValue } = require('./utils');

const MATERIAL_FIELD_RE = /成分|材质|材料/;
const POLYESTER_RE = /涤纶|聚酯/;

function isPolyesterFamily(value) {
  return POLYESTER_RE.test(String(value || ''));
}

function isMaterialField(attrName) {
  return MATERIAL_FIELD_RE.test(String(attrName || ''));
}

/** 裁剪多选取值：返回 { values, note }，note 为裁剪说明（未裁剪时为空串），用于日志与 logs.xlsx 追溯 */
function sanitizeMaterialValues(attrName, values) {
  const list = toArrayValue(values);
  if (list.length <= 1) return { values: list, note: '' };

  const dropped = [];
  const kept = [];
  for (const value of list) {
    // 涤纶/聚酯/聚酯纤维/高弹聚酯纤维 等聚酯系值互为同义，只保留最先出现的一个
    if (isPolyesterFamily(value) && kept.some(isPolyesterFamily)) {
      dropped.push(value);
      continue;
    }
    kept.push(value);
  }

  const notes = [];
  if (dropped.length) {
    notes.push(`涤纶与聚酯同属一种纤维，仅保留「${kept.find(isPolyesterFamily)}」`);
  }

  if (isMaterialField(attrName) && kept.length > 1) {
    dropped.push(...kept.slice(1));
    notes.push(`成分/材质字段仅保留单一材质「${kept[0]}」`);
    kept.length = 1;
  }

  return { values: kept, note: notes.join('；') };
}

module.exports = {
  isMaterialField,
  isPolyesterFamily,
  sanitizeMaterialValues
};
