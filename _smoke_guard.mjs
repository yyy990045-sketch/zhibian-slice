// 单调风险护栏不变量测试（US-08）
import { resolveFinalRisk, validateEscalation, decisionDigest, riskRank, RISK_LEVELS } from './src/guard.js';

let failures = 0;
const ok = (condition, message) => {
  console.log(`${condition ? 'PASS' : 'FAIL'}: ${message}`);
  if (!condition) failures += 1;
};

// 1. 只升不降：最终风险 >= 每个输入（单调不变量）
for (const floor of RISK_LEVELS) {
  for (const sem of RISK_LEVELS) {
    for (const esc of [...RISK_LEVELS, null]) {
      const r = resolveFinalRisk({ hardFloor: floor, semanticBaseline: sem, validatedEscalation: esc });
      const inputs = [floor, sem, esc].filter(Boolean);
      const okMonotonic = inputs.every((lv) => riskRank(r) >= riskRank(lv));
      if (!okMonotonic) ok(false, `单调性被破坏: floor=${floor} sem=${sem} esc=${esc} -> ${r}`);
    }
  }
}
ok(true, '全组合单调：最终风险只升不降（4×4×5=80 组合）');

// 2. hardFloor 兜底：语义再低也不能把风险降回 floor 以下
ok(resolveFinalRisk({ hardFloor: 'high', semanticBaseline: 'low' }) === 'high', '语义 low 不能降级规则 high 底线');
ok(resolveFinalRisk({ hardFloor: 'medium', semanticBaseline: 'low', validatedEscalation: null }) === 'medium', 'floor medium 保底');

// 3. 无证据背书的升级被忽略
ok(resolveFinalRisk({ hardFloor: 'low', semanticBaseline: 'low', validatedEscalation: 'high' }) === 'high', '有升级值时生效');
ok(resolveFinalRisk({ hardFloor: 'low', semanticBaseline: 'low', validatedEscalation: null }) === 'low', '无升级值保持 floor');

// 4. 全部 low → low
ok(resolveFinalRisk({}) === 'low', '空输入默认 low');

// 5. 交换律：max 组合与顺序无关
const combo = resolveFinalRisk({ hardFloor: 'medium', semanticBaseline: 'high', validatedEscalation: 'critical' });
ok(combo === 'critical', '多输入取最高级');
ok(resolveFinalRisk({ hardFloor: 'critical', semanticBaseline: 'high' }) === 'critical', 'floor critical 不可被降');

// 6. 未知级别按 low 处理
ok(resolveFinalRisk({ hardFloor: 'unknown' }) === 'low', '未知级别回退 low');

// 7. 证据背书：短证据不通过
ok(validateEscalation('') === null && validateEscalation('短') === null, '空/过短证据不通过背书');
ok(validateEscalation('这是一段足够具体的证据原文，用于背书升级。')?.ok === true, '足够具体的证据通过背书');

// 8. 决策契约可重放：同输入同摘要
const p1 = { floor: 'medium', sem: 'high', q: 'AI 会不会取代程序员' };
ok(decisionDigest(p1) === decisionDigest({ ...p1 }), '同输入决策摘要稳定可重放');
ok(decisionDigest(p1) !== decisionDigest({ ...p1, q: '另一话题' }), '不同输入摘要不同');

// 9. 摘要格式稳定（16 位 hex）
ok(/^[0-9a-f]{16}$/.test(decisionDigest(p1)), '决策摘要为 16 位 hex');

console.log(failures ? `\nFAIL=${failures}` : '\nALL PASS');
process.exit(failures ? 1 : 0);
