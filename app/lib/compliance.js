'use strict';
/**
 * 合规校验引擎（离线词典 + 模式匹配，不依赖模型）
 * 用于生成后的二次校验：广告法极限词、医疗功效承诺、违规导流、虚假价格等。
 * 命中结果会返回给前端高亮标注，让用户在发布前就能看到风险。
 *
 * 分级说明：
 *  - high：明确违规，发布前必须修改
 *  - mid ：有风险，需要确认或补充依据
 *  - low ：提示级（soft 词 / 语境豁免），仅提醒，建议人工判断
 *
 * 注意：这是辅助筛查工具，词典无法穷尽，最终仍需人工确认与平台规则核对。
 */

const RULES = [
  {
    id: 'absolute',
    cat: '广告法·极限词',
    sev: 'high',
    words: [
      '最好', '最佳', '最优', '最强', '最便宜', '最低价', '最先进', '最高级', '最顶级', '最划算',
      '第一品牌', '全国第一', '全网第一', '销量第一', '排名第一', '行业第一', '世界第一',
      '唯一', '唯一一款', '独家', '独家秘方', '绝无仅有', '独一无二', '仅此一家',
      '史无前例', '史无前例的', '前所未有', '空前绝后', '绝版',
      '顶级', '顶尖', '极致', '极品', '王牌', '巅峰之作', '王者',
      '国家级', '世界级', '国际级', '国家级认证',
      '绝对', '绝对安全', '绝对有效', '百分百', '100%有效', '100%安全',
      '万能', '全效', '永久有效', '终身有效', '永不',
      '填补空白', '领导者', '领先品牌', '遥遥领先', '无法超越', '秒杀一切', '最强王者',
    ],
    soft: ['极致', '顶尖', '极品', '王牌', '巅峰之作', '王者', '领先品牌'],
    tip: '广告法禁用的绝对化用语，建议改为具体、可验证的表述，例如「同价位里续航表现不错」。',
    fix: {
      最好: '很不错', 最佳: '很好', 最优: '很好', 最强: '很强', 最便宜: '价格很实在', 最低价: '价格很实在',
      唯一: '少见', 独家: '自研', 顶级: '高档', 顶尖: '高档', 极致: '讲究', 极品: '精品',
      绝对: '确实', 百分百: '基本都', 万能: '很全面', 全效: '多效', 永不: '不容易', 永久: '长久',
      第一品牌: '知名品牌', 销量第一: '卖得很好', 全国第一: '很受欢迎', 领导者: '老牌选手',
    },
  },
  {
    id: 'medical',
    cat: '功效承诺·医疗风险',
    sev: 'high',
    words: [
      '治疗', '治愈', '治好', '根治', '药到病除', '特效', '特效药', '有疗效', '见效', '速效',
      '疗程', '处方', '医用', '药用', '药效', '包治', '专治', '断根',
      '祛斑', '祛痘', '祛疤', '除皱', '抗皱', '生发', '防脱', '固发', '丰胸',
      '减肥', '瘦身', '燃脂', '暴瘦', '排毒', '消肿', '溶脂',
      '抗衰老', '抗衰', '逆龄', '美白', '淡斑', '去黄',
      '消炎', '杀菌', '抑菌', '消毒', '抗病毒', '增强免疫', '提高免疫力',
      '降血压', '降血糖', '降血脂', '降尿酸', '助眠', '安神', '壮阳', '补肾',
      '无副作用', '零副作用', '没有副作用', '安全无刺激', '孕妇可用', '婴幼儿可用',
    ],
    soft: ['医用', '药用', '见效', '速效', '疗程', '处方', '助眠', '安神'],
    // 特殊化妆品 / 保健品才允许宣称的功效词（需资质）
    certWords: ['祛斑', '美白', '防脱', '生发', '抗皱', '除皱', '减肥', '瘦身', '燃脂'],
    tip: '涉及医疗功效或绝对安全承诺，普通商品不得宣称。建议改为感官与使用体验描述，如「用起来更清爽」。',
    fix: {
      治疗: '改善体验', 治愈: '改善体验', 治好: '有明显改善', 根治: '从源头缓解',
      美白: '提亮肤色', 淡斑: '改善暗沉', 祛痘: '改善痘痘肌体验', 祛斑: '改善暗沉',
      抗皱: '紧致体验', 除皱: '紧致体验', 减肥: '体重管理期友好', 瘦身: '塑形体验',
      燃脂: '运动搭档', 助眠: '睡前放松感', 安神: '放松感', 杀菌: '清洁',
      抑菌: '清洁', 消炎: '舒缓体验', 无副作用: '用着放心', 零副作用: '用着放心',
      没有副作用: '用着放心', 速效: '上手快', 见效: '有变化',
    },
  },
  {
    id: 'number-claim',
    cat: '功效承诺·量化效果',
    sev: 'high',
    patterns: [
      { re: /(瘦|减|掉)\s*\d+(\.\d+)?\s*(斤|公斤|kg|千克)/g, label: '减重数字承诺' },
      { re: /\d+\s*(天|周|个月)\s*(见效|变白|变瘦|长高|痊愈|改善)/g, label: '限时见效承诺' },
      { re: /(祛|消|去)\s*\d+\s*(年|天)/g, label: '根治年限承诺' },
      { re: /(长高|增高)\s*\d+/g, label: '增高数字承诺' },
    ],
    tip: '量化功效承诺属于虚假宣传高风险项，请删除数字承诺，改为描述使用感受。',
  },
  {
    id: 'price',
    cat: '价格·虚假促销',
    sev: 'mid',
    words: [
      '全网最低价', '史上最低', '亏本', '亏钱卖', '倒贴', '白送', '不要钱', '免费送', '零利润',
      '专柜价', '原价999', '原价上千', '商场同款价', '内部价', '出厂价直供',
    ],
    patterns: [
      { re: /(原价|专柜价|吊牌价)\s*[¥￥]?\s*\d{3,}/g, label: '疑似虚构原价' },
      { re: /(仅限|只限|就)\s*(今天|今天一天|今晚|这一天)/g, label: '疑似虚假限时' },
      { re: /错过(再等|等)\s*(一年|半年|一年)/g, label: '疑似虚假紧迫' },
    ],
    tip: '价格类话术必须是真实信息，不得虚构原价或编造限时，否则平台会判定虚假宣传。',
    fix: {
      亏本: '让利', 白送: '给到', 不要钱: '价格很低', 免费送: '随单送', 零利润: '让利',
      内部价: '渠道价', 史上最低: '近期低价', 全网最低价: '价格很有优势',
    },
  },
  {
    id: 'drain',
    cat: '违规导流·诱导互动',
    sev: 'high',
    words: [
      '加微信', '加V', '加v', '微信号', '加微', '私聊', '私信我', '加我微信', '扫码加',
      '扣扣群', 'QQ群', '加群', '入群', '站外', '下单私聊', '引导到店', '加客服微信',
      '点赞抽奖', '转发抽奖', '关注抽奖', '评论抽奖', '集赞', '砍一刀', '帮我砍', '助力',
      '免费领', '点击领取', '私信领取', '评论区扣1领取', '转发截图',
    ],
    tip: '抖音禁止站外导流与诱导互动（抽奖/集赞/砍价），会被限流甚至封禁，请删除。',
    fix: {
      免费领: '进店看', 点击领取: '点小黄车看', 私信领取: '点小黄车看',
    },
  },
  {
    id: 'platform-super',
    cat: '平台规则·夸大宣传',
    sev: 'mid',
    words: [
      '刷屏', '爆款必买', '闭眼入不踩雷', '全网都在用', '家家都在用', '人手一个',
      '权威认证', '官方指定', '国家专利配方', '祖传秘方', '宫廷配方',
    ],
    tip: '无法提供证明的权威性或社会认同宣称有被判定虚假宣传的风险，建议删除或补充真实依据。',
    fix: {
      爆款必买: '回购很多', 全网都在用: '很多人在用', 人手一个: '很常见',
      权威认证: '有检测报告', 官方指定: '官方出品', 祖传秘方: '老配方', 宫廷配方: '老配方',
    },
  },
];

const SEV_ORDER = { high: 2, mid: 1, low: 0 };

function buildCompiled() {
  return RULES.map((rule) => {
    const softSet = new Set(rule.soft || []);
    return {
      rule,
      softSet,
      patterns: [
        ...(rule.words || []).map((w) => ({ re: new RegExp(escapeRe(w), 'g'), label: w })),
        ...((rule.patterns || []).map((p) => ({ re: p.re, label: p.label }))),
      ],
    };
  });
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const COMPILED = buildCompiled();

/**
 * 上下文豁免：命中词前 4 字内出现否定词（无/不/非/没/零），或紧邻疑问语气（吗/呢/？）时降为提示级
 * 例：「不含美白成分」「有没有美白效果？」
 */
function isExempt(src, hit) {
  const before = src.slice(Math.max(0, hit.start - 4), hit.start);
  const after = src.slice(hit.end, hit.end + 2);
  if (/(无|不|非|没|零)/.test(before)) return true;
  if (/^(吗|呢|？|\?)/.test(after)) return true;
  return false;
}

/** 品类语境补充提示 */
function categoryNote(rule, hit, category) {
  const cat = String(category || '');
  if (!cat) return '';
  if (rule.id === 'medical' && cat.includes('食品')) {
    return '【食品类】普通食品严禁任何功效宣称，此表述必须删除。';
  }
  if (rule.id === 'medical' && rule.certWords?.includes(hit.word)) {
    if (cat.includes('美妆') || cat.includes('护肤')) {
      return '【美妆类】该词属特殊化妆品功效宣称，需特殊化妆品注册证，无证必须删除。';
    }
  }
  return '';
}

/** 计算单个命中的最终严重度（soft 词降级、语境豁免降级） */
function sevOf(rule, softSet, word, src, hit) {
  let sev = rule.sev;
  if (softSet.has(word) || softSet.has(hit.label)) sev = SEV_ORDER[sev] > 1 ? 'mid' : 'low';
  if (isExempt(src, hit)) sev = 'low';
  return sev;
}

/**
 * 扫描文本，返回命中结果
 * @param {string} text
 * @param {{category?:string}} [opts] 品类语境（可选，来自商品表单）
 * @returns {{level:'ok'|'low'|'mid'|'high', hits:Array, summary:string}}
 */
function scan(text, opts = {}) {
  const src = String(text || '');
  const hits = [];
  const seen = new Set();

  for (const { rule, softSet, patterns } of COMPILED) {
    for (const { re, label } of patterns) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(src)) !== null) {
        const start = m.index;
        const end = start + m[0].length;
        const key = `${start}:${end}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const sev = sevOf(rule, softSet, m[0], src, { start, end, label });
        const note = categoryNote(rule, { word: m[0], label }, opts.category);
        hits.push({
          word: m[0],
          label,
          start,
          end,
          cat: rule.cat,
          sev,
          tip: rule.tip + (note ? '\n' + note : ''),
          suggestion: rule.fix?.[m[0]] ?? rule.fix?.[label] ?? '',
        });
        if (m[0].length === 0) re.lastIndex++;
      }
    }
  }

  // 同一区间去重，保留严重度最高的一条
  const merged = [];
  for (const h of hits.sort((a, b) => a.start - b.start || SEV_ORDER[b.sev] - SEV_ORDER[a.sev])) {
    const dup = merged.find((x) => x.start === h.start && x.end === h.end);
    if (!dup) merged.push(h);
    else if (SEV_ORDER[h.sev] > SEV_ORDER[dup.sev]) Object.assign(dup, h);
  }

  merged.sort((a, b) => a.start - b.start);
  const hard = merged.filter((h) => h.sev !== 'low');
  const soft = merged.filter((h) => h.sev === 'low');
  const level = hard.some((h) => h.sev === 'high')
    ? 'high'
    : hard.some((h) => h.sev === 'mid')
      ? 'mid'
      : soft.length
        ? 'low'
        : 'ok';

  let summary;
  if (level === 'ok') summary = '未检出明显的广告法与平台规则风险词';
  else if (level === 'high') summary = `检出 ${hard.length} 处风险表述（含高危项，建议发布前修改）` + (soft.length ? `，另有 ${soft.length} 处提示级表述` : '');
  else if (level === 'mid') summary = `检出 ${hard.length} 处风险表述（建议逐条确认）` + (soft.length ? `，另有 ${soft.length} 处提示级表述` : '');
  else summary = `检出 ${soft.length} 处提示级表述（多为语境相关，人工确认即可）`;

  return { level, hits: merged, summary };
}

/** 分组返回，便于前端按类别展示 */
function groupByCategory(hits) {
  const map = new Map();
  for (const h of hits) {
    if (!map.has(h.cat)) map.set(h.cat, { cat: h.cat, sev: h.sev, tip: h.tip, words: [], suggestions: {} });
    const g = map.get(h.cat);
    if (SEV_ORDER[h.sev] > SEV_ORDER[g.sev]) g.sev = h.sev;
    if (!g.words.includes(h.word)) g.words.push(h.word);
    if (h.suggestion && !g.suggestions[h.word]) g.suggestions[h.word] = h.suggestion;
  }
  return Array.from(map.values());
}

/**
 * 本地兜底改写：按建议词表替换命中词（从后往前，避免位移）。
 * 只有非空建议才替换；无建议的（如导流话术）保留原文并计入 missed，提示人工处理，避免句子破碎。
 * @returns {{text:string, replaced:string[], missed:string[]}}
 */
function safeRewrite(text, hits) {
  let out = String(text || '');
  const list = (hits || [])
    .filter((h) => h.sev !== 'low' && h.suggestion)
    .sort((a, b) => b.start - a.start);
  const replaced = [];
  const missedSet = new Set();
  let last = out.length;
  for (const h of list) {
    if (h.end > last) continue; // 区间重叠，跳过
    out = out.slice(0, h.start) + h.suggestion + out.slice(h.end);
    last = h.start;
    const rec = `${h.word}→${h.suggestion}`;
    if (!replaced.includes(rec)) replaced.push(rec);
  }
  // 无建议的词需要人工处理（删除或重写），保留原文
  for (const h of hits || []) {
    if (h.sev !== 'low' && !h.suggestion) missedSet.add(h.word);
  }
  return { text: out, replaced, missed: Array.from(missedSet) };
}

module.exports = { scan, groupByCategory, safeRewrite, RULES };
