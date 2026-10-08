const assert = require('node:assert/strict');

const { matchLocally } = require('../src/option_matcher');

// exact：两侧 trim 后全等
assert.deepEqual(matchLocally(' 不锈钢 ', ['钢', '不锈钢']), { option: '不锈钢', method: 'exact' });

// normalized：全角/括注/大小写差异被抹平后相等
assert.deepEqual(matchLocally('不锈钢（SUS304）', ['不锈钢', '铁']), { option: '不锈钢', method: 'normalized' });

// contains：页面选项包含 AI 值
assert.deepEqual(matchLocally('棉', ['纯棉面料', '麻布']), { option: '纯棉面料', method: 'contains' });

// included_by：AI 值包含页面选项
assert.deepEqual(matchLocally('纯棉面料制品', ['纯棉面料']), { option: '纯棉面料', method: 'included_by' });

// 无命中：返回 null（不兜底、不猜测，由调用方走原路径）
assert.equal(matchLocally('钢', ['纺织品材质', '非纺织品材质']), null);

// 空值/空选项：返回 null
assert.equal(matchLocally('', ['钢']), null);
assert.equal(matchLocally('钢', []), null);
assert.equal(matchLocally(null, ['钢']), null);

console.log('matchLocally: all assertions passed');
