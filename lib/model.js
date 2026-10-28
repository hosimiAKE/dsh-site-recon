// The framework's model: what "wide" and "deep" mean, and how both become
// countable state instead of good intentions.

/** Source roles. Breadth is measured against these, never against a page count. */
export const SOURCE_ROLES = [
  {
    key: 'primary',
    label: '一手官方',
    hint: '主体自己的产品页、公告、说明；它如何描述自己',
  },
  {
    key: 'docs',
    label: '技术文档',
    hint: '参考文档、架构说明、规范；实施细节与硬约束',
  },
  {
    key: 'pricing',
    label: '价格条款',
    hint: '定价、配额、许可、SLA；真实成本与商业边界',
  },
  {
    key: 'release',
    label: '发布与路线',
    hint: '更新日志、发布说明、路线图；承诺是否兑现、成熟度',
  },
  {
    key: 'engineering',
    label: '工程深潜',
    hint: '工程博客、白皮书、论文；机制、取舍、失败经验',
  },
  {
    key: 'thirdparty',
    label: '独立分析',
    hint: '第三方评测、分析机构、行业媒体；外部视角与水份',
  },
  {
    key: 'community',
    label: '社区摩擦',
    hint: '论坛、问答、issue；真实使用中的坑与限制',
  },
  {
    key: 'customer',
    label: '落地案例',
    hint: '客户案例、迁移故事、复盘；真实收益与代价',
  },
  {
    key: 'regulatory',
    label: '法规标准',
    hint: '法规、标准、审计与合规材料；不可协商的约束',
  },
  {
    key: 'competitor',
    label: '对照基线',
    hint: '竞品与替代方案；判断"是否特别"的参照系',
  },
  {
    key: 'data',
    label: '量化数据',
    hint: '基准、统计、市场报告；可比较的数字',
  },
];

export const ROLE_KEYS = SOURCE_ROLES.map((r) => r.key);
export const ROLE_BY_KEY = new Map(SOURCE_ROLES.map((r) => [r.key, r]));
export const DEFAULT_ROLES = [
  'primary', 'docs', 'release', 'engineering',
  'thirdparty', 'community', 'competitor', 'data',
];

/** Evidence levels: how much weight a single record can carry. */
export const LEVELS = [
  { key: 'primary', label: 'L1 一手原文', hint: '官方文档、公告、规范原文' },
  { key: 'measured', label: 'L2 实测数据', hint: '可复现的测量、基准、成本核算' },
  { key: 'independent', label: 'L3 独立来源', hint: '第三方评测、分析、审计' },
  { key: 'anecdotal', label: 'L4 个体转述', hint: '帖子、评论、二手引用' },
];

export const LEVEL_KEYS = LEVELS.map((l) => l.key);
export const LEVEL_BY_KEY = new Map(LEVELS.map((l) => [l.key, l]));

/**
 * The eight rungs a claim must climb before it counts as understood rather
 * than merely reported. Keys are stable: they are persisted per claim.
 */
export const DEPTH_RUNGS = [
  {
    key: 'mechanism',
    label: '机制',
    ask: '把宣称翻译成因果链：输入什么、经过什么、输出什么。说不清机制，说明还没读懂。',
  },
  {
    key: 'evidence',
    label: '证据',
    ask: '支撑这条判断最硬的一手材料是哪一句？它不是"提到过"，而是"说过这件事"。',
  },
  {
    key: 'preconditions',
    label: '前提',
    ask: '要成立需要哪些条件、投入、依赖？这笔成本由谁承担？',
  },
  {
    key: 'alternatives',
    label: '替代解释',
    ask: '同样的现象还有哪些解释？你排除了哪些，凭什么？',
  },
  {
    key: 'counter',
    label: '反证',
    ask: '什么材料能推翻它？现有材料里有没有互相矛盾的说法？',
  },
  {
    key: 'boundary',
    label: '边界',
    ask: '什么情况下失效？适用范围到哪里为止？',
  },
  {
    key: 'consequence',
    label: '二阶后果',
    ask: '若它成立，会连锁引发什么？谁会因此受益、谁会受损？',
  },
  {
    key: 'implication',
    label: '我方含义',
    ask: '对提问者的处境意味着什么？下一步该做什么、先验证什么？',
  },
];

export const RUNG_KEYS = DEPTH_RUNGS.map((r) => r.key);

/** The universal decomposition applied to any question before searching. */
export const SUBQUESTION_SEEDS = [
  { key: 'definition', ask: '它是什么——先用对方的语言说清，不要套我们自己的框架' },
  { key: 'mechanism', ask: '它到底怎么运作——机制层面的因果链' },
  { key: 'cost', ask: '代价与门槛——钱、人、时间、迁移成本、锁定' },
  { key: 'limits', ask: '失效条件与反例——什么情况下不成立' },
  { key: 'comparison', ask: '与替代方案的差异基线——和谁比、差在哪' },
  { key: 'implication', ask: '对我们处境的含义——该做什么、先验证什么' },
];

export const CLAIM_STATUS = {
  unsupported: { label: '无证据', tone: 'blocker' },
  'single-source': { label: '孤证', tone: 'warn' },
  supported: { label: '已支持', tone: 'ok' },
  contested: { label: '存疑', tone: 'warn' },
};

/** Status is derived from the ledger, never asserted by the model. */
export function claimStatus(claim, evidenceItems) {
  const byId = new Map(evidenceItems.map((e) => [e.id, e]));
  const linked = (claim.evidence || []).map((id) => byId.get(id)).filter(Boolean);
  if (!linked.length) return { status: 'unsupported', linked };
  if (linked.some((e) => e.contests)) return { status: 'contested', linked };
  const sources = new Set(linked.map((e) => e.sourceId || e.url));
  if (sources.size >= 2) return { status: 'supported', linked };
  return { status: 'single-source', linked };
}

export function probeScore(claim) {
  const answers = claim?.probe?.answers || {};
  const filled = RUNG_KEYS.filter((k) => String(answers[k] || '').trim().length >= 24);
  return {
    answered: filled.length,
    total: RUNG_KEYS.length,
    percent: Math.round((filled.length / RUNG_KEYS.length) * 100),
    missing: RUNG_KEYS.filter((k) => !filled.includes(k)),
  };
}

export function coverage(brief, sources) {
  const roles = brief?.breadth?.roles?.length ? brief.breadth.roles : DEFAULT_ROLES;
  const rows = roles.map((key) => {
    const role = ROLE_BY_KEY.get(key) || { key, label: key, hint: '' };
    const owned = sources.filter((s) => s.role === key);
    const fetched = owned.filter((s) => s.status === 'fetched');
    return {
      key,
      label: role.label,
      hint: role.hint,
      total: owned.length,
      fetched: fetched.length,
      covered: fetched.length > 0,
      urls: fetched.slice(0, 3).map((s) => s.url),
    };
  });
  const covered = rows.filter((r) => r.covered).length;
  return { rows, covered, total: rows.length, percent: rows.length ? Math.round((covered / rows.length) * 100) : 0 };
}

export function levelMix(evidenceItems) {
  const counts = new Map(LEVEL_KEYS.map((k) => [k, 0]));
  for (const item of evidenceItems) {
    const key = LEVEL_BY_KEY.has(item.strength) ? item.strength : 'anecdotal';
    counts.set(key, counts.get(key) + 1);
  }
  return LEVEL_KEYS.map((key) => ({ key, label: LEVEL_BY_KEY.get(key).label, count: counts.get(key) }));
}

/**
 * Everything still missing, ranked by how much it would change the report.
 * This is the tool the model is meant to call instead of asking "am I done?".
 */
export function gaps(state) {
  const { brief, sources, evidence, claims } = state;
  const cov = coverage(brief, sources);
  const items = [];

  for (const row of cov.rows) {
    if (!row.covered) {
      items.push({
        kind: 'breadth',
        severity: 'high',
        subject: row.label,
        detail: row.total
          ? `${row.total} 个来源登记了但没有一个真正读进来`
          : '这一类来源完全没有覆盖',
        action: `找一条 ${row.label}（${row.hint}），recon_fetch 读进来并记一条证据`,
      });
    }
  }

  for (const claim of claims) {
    const { status, linked } = claimStatus(claim, evidence);
    const probe = probeScore(claim);
    if (status === 'unsupported') {
      items.push({
        kind: 'support',
        severity: 'high',
        subject: claim.id,
        detail: `「${clip(claim.text, 60)}」还没有任何证据`,
        action: '为它记录一条原文引用，或把它降级为待验证的假设',
      });
    } else if (status === 'single-source') {
      items.push({
        kind: 'support',
        severity: 'medium',
        subject: claim.id,
        detail: `只有 1 个来源（${linked[0]?.id || '?'}），无法排除单一视角`,
        action: '换一类来源角色交叉验证，或明确标注为孤证',
      });
    }
    if (status === 'contested') {
      items.push({
        kind: 'conflict',
        severity: 'high',
        subject: claim.id,
        detail: '存在互相矛盾的两条证据',
        action: '判断分歧原因是时间、口径还是立场，并在报告里写出取舍',
      });
    }
    if (probe.percent < 50) {
      items.push({
        kind: 'depth',
        severity: status === 'supported' ? 'medium' : 'low',
        subject: claim.id,
        detail: `深度阶梯只答了 ${probe.answered}/8`,
        action: `先补 ${probe.missing.slice(0, 2).join(' / ')}`,
      });
    } else if (!claim.probe?.answers?.counter) {
      items.push({
        kind: 'depth',
        severity: 'low',
        subject: claim.id,
        detail: '没有写下任何反证或反方观点',
        action: '主动检索一次反面说法（“X 的问题 / X 的替代 / X 失败”）',
      });
    }
  }

  const unverified = evidence.filter((e) => e.verified === false);
  for (const item of unverified) {
    items.push({
      kind: 'evidence',
      severity: 'medium',
      subject: item.id,
      detail: '引文未能在已保存的正文快照中定位',
      action: '重新读取该页并记录页面里逐字存在的句子，或改为注明来源不可核',
    });
  }

  const orphans = evidence.filter((e) => !claims.some((c) => (c.evidence || []).includes(e.id)));
  if (orphans.length) {
    items.push({
      kind: 'evidence',
      severity: 'low',
      subject: `${orphans.length} 条证据`,
      detail: `收集了但没有挂到任何论点上：${orphans.slice(0, 5).map((e) => e.id).join(', ')}`,
      action: '挂到对应论点，或删除以免报告里出现无主的材料',
    });
  }

  const order = { high: 0, medium: 1, low: 2 };
  items.sort((a, b) => order[a.severity] - order[b.severity]);
  const blockers = items.filter((i) => i.severity === 'high').length;
  return { coverage: cov, items, blockers, levels: levelMix(evidence) };
}

export function clip(text, max = 160) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

export function table(headers, rows) {
  const head = `| ${headers.join(' | ')} |`;
  const rule = `| ${headers.map(() => '---').join(' | ')} |`;
  const body = rows.map((r) => `| ${r.map((c) => String(c ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ')).join(' | ')} |`);
  return [head, rule, ...body].join('\n');
}
