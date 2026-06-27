export const RISK_PROFILES = {
  steady: {
    label: "稳健",
    maxSingleWeight: 25,
    riskBudget: 35,
    rebalanceThreshold: 3,
    description: "控制单一标的暴露，优先降低回撤。"
  },
  balanced: {
    label: "均衡",
    maxSingleWeight: 35,
    riskBudget: 55,
    rebalanceThreshold: 5,
    description: "在趋势与分散之间保持平衡。"
  },
  growth: {
    label: "进取",
    maxSingleWeight: 45,
    riskBudget: 75,
    rebalanceThreshold: 8,
    description: "允许更高波动，强调趋势延续。"
  }
};

export function buildPortfolio(holdings, quotes, capital, riskKey, fxRates = { USD: 7.2, CNY: 1 }) {
  const quoteById = new Map(quotes.map((quote) => [quote.id, quote]));
  const rows = holdings.map((holding) => {
    const quote = quoteById.get(holding.id);
    const targetWeight = Number(holding.targetWeight || 0);
    const units = Number(holding.units || 0);
    const price = quote?.price ?? null;
    const fxRate = quote?.currency === "USD" ? fxRates.USD || 7.2 : 1;
    const priceCny = price !== null ? price * fxRate : null;
    const currentValue = priceCny !== null ? priceCny * units : 0;
    const targetValue = capital * (targetWeight / 100);
    const drift = capital ? ((currentValue - targetValue) / capital) * 100 : 0;
    const rebalanceAmount = targetValue - currentValue;

    return {
      ...holding,
      quote,
      targetWeight,
      units,
      fxRate,
      priceCny,
      currentValue,
      targetValue,
      rebalanceAmount,
      rebalanceUnits: priceCny ? rebalanceAmount / priceCny : 0,
      drift
    };
  });

  const totalValue = rows.reduce((sum, row) => sum + row.currentValue, 0);
  const totalTargetWeight = rows.reduce((sum, row) => sum + row.targetWeight, 0);
  const weightedChange = rows.reduce((sum, row) => {
    const change = row.quote?.changePercent;
    if (change === null || change === undefined) return sum;
    const baseWeight = totalValue > 0 ? row.currentValue / totalValue : row.targetWeight / 100;
    return sum + change * baseWeight;
  }, 0);
  const risk = RISK_PROFILES[riskKey] || RISK_PROFILES.balanced;
  const regions = rows.reduce(
    (acc, row) => {
      const key = row.quote?.market || row.market;
      acc[key] = (acc[key] || 0) + row.targetWeight;
      return acc;
    },
    { cn: 0, us: 0, fund: 0 }
  );

  const warnings = [];
  if (Math.abs(totalTargetWeight - 100) > 0.5) {
    warnings.push(`目标权重合计为 ${totalTargetWeight.toFixed(1)}%，建议调整到 100%。`);
  }
  const oversized = rows.filter((row) => row.targetWeight > risk.maxSingleWeight);
  if (oversized.length) {
    warnings.push(`${oversized.map((row) => row.code).join("、")} 超过 ${risk.label}配置的单标上限 ${risk.maxSingleWeight}%。`);
  }
  const errors = rows.filter((row) => row.quote?.status === "ERROR");
  if (errors.length) {
    warnings.push(`${errors.map((row) => row.code).join("、")} 当前行情不可用，方案计算已暂时排除其价格。`);
  }

  return {
    rows,
    totalValue,
    totalTargetWeight,
    weightedChange,
    regions,
    warnings,
    risk
  };
}

export function analyzeAsset(row, portfolio, marketMood) {
  const quote = row?.quote;
  if (!quote || quote.status === "ERROR") {
    return emptyAnalysis(row);
  }

  const technical = buildTechnicalAgent(quote);
  const fundamentals = buildFundamentalAgent(quote);
  const sentiment = buildSentimentAgent(quote, marketMood);
  const news = buildNewsAgent(quote, portfolio);
  const debate = buildResearchDebate({ technical, fundamentals, sentiment, news, quote });
  const trade = buildTraderDecision(row, portfolio, debate);
  const risk = buildRiskDecision(row, portfolio, trade);

  return {
    score: Math.round((technical.score + fundamentals.score + sentiment.score + news.score) / 4),
    agents: [fundamentals, sentiment, news, technical],
    debate,
    trade,
    risk
  };
}

function buildTechnicalAgent(quote) {
  const change = quote.changePercent ?? 0;
  const intradayRange = quote.high && quote.low && quote.price ? ((quote.high - quote.low) / quote.price) * 100 : null;
  const closePosition =
    quote.high && quote.low && quote.price && quote.high !== quote.low
      ? ((quote.price - quote.low) / (quote.high - quote.low)) * 100
      : 50;
  let score = 50 + clamp(change * 8, -28, 28) + clamp((closePosition - 50) / 2, -14, 14);
  if (intradayRange !== null && intradayRange > 4) score -= 6;

  return {
    key: "technical",
    title: "技术分析师",
    score: clamp(Math.round(score), 0, 100),
    verdict: score >= 62 ? "趋势偏强" : score <= 42 ? "趋势偏弱" : "震荡观察",
    detail:
      intradayRange === null
        ? "可用分时数据有限，主要参考当日涨跌幅。"
        : `日内振幅 ${intradayRange.toFixed(2)}%，收盘位置约 ${closePosition.toFixed(0)}%。`
  };
}

function buildFundamentalAgent(quote) {
  let score = 55;
  const notes = [];
  const pe = quote.fundamentals?.pe;
  const beta = quote.fundamentals?.beta;
  const dividendYield = quote.fundamentals?.dividendYield;

  if (quote.type?.includes("FUND")) {
    score += 5;
    notes.push("基金/ETF 分散度通常优于单一股票。");
  }

  if (pe) {
    if (pe > 45) {
      score -= 8;
      notes.push(`PE ${pe.toFixed(1)}，估值压力偏高。`);
    } else if (pe > 0 && pe < 22) {
      score += 6;
      notes.push(`PE ${pe.toFixed(1)}，估值相对克制。`);
    }
  }

  if (beta) {
    if (beta > 1.4) {
      score -= 7;
      notes.push(`Beta ${beta.toFixed(2)}，波动敏感度偏高。`);
    } else if (beta < 0.9) {
      score += 4;
      notes.push(`Beta ${beta.toFixed(2)}，波动敏感度较低。`);
    }
  }

  if (dividendYield && dividendYield > 0.015) {
    score += 4;
    notes.push(`股息率 ${(dividendYield * 100).toFixed(2)}%，有现金流支撑。`);
  }

  if (!notes.length) {
    notes.push(quote.market === "cn" ? "A 股基本面字段有限，优先结合指数/行业属性判断。" : "基本面字段有限，保持中性评分。");
  }

  return {
    key: "fundamental",
    title: "基本面分析师",
    score: clamp(Math.round(score), 0, 100),
    verdict: score >= 62 ? "质量支撑" : score <= 42 ? "估值/质量承压" : "基本面中性",
    detail: notes.join(" ")
  };
}

function buildSentimentAgent(quote, marketMood) {
  const change = quote.changePercent ?? 0;
  const marketBias = marketMood >= 0.6 ? 5 : marketMood <= -0.6 ? -5 : 0;
  const score = 50 + clamp(change * 7, -24, 24) + marketBias;
  const moodText = marketMood >= 0.6 ? "组合内风险偏好偏暖" : marketMood <= -0.6 ? "组合内风险偏好偏冷" : "组合内情绪中性";

  return {
    key: "sentiment",
    title: "情绪分析师",
    score: clamp(Math.round(score), 0, 100),
    verdict: score >= 62 ? "买盘情绪较强" : score <= 42 ? "避险情绪升温" : "情绪平衡",
    detail: `${moodText}；该标的当日涨跌幅 ${formatPercent(change)}。`
  };
}

function buildNewsAgent(quote, portfolio) {
  let score = 52;
  const notes = [];
  const regionWeight = portfolio.regions[quote.market] || 0;

  if (quote.market === "us") {
    notes.push("美股资产受隔夜美元流动性、科技权重和美股指数影响更明显。");
  } else if (quote.market === "cn") {
    notes.push("A 股/场内基金受本地政策、行业轮动和北向/成交情绪影响更明显。");
  } else {
    notes.push("开放式基金估值通常滞后确认，适合按区间和仓位计划观察。");
  }

  if (regionWeight > 65) {
    score -= 5;
    notes.push(`当前同市场目标权重 ${regionWeight.toFixed(0)}%，区域集中度较高。`);
  } else if (regionWeight < 45) {
    score += 3;
    notes.push("区域敞口相对分散。");
  }

  return {
    key: "news",
    title: "市场/宏观分析师",
    score: clamp(Math.round(score), 0, 100),
    verdict: score >= 62 ? "宏观顺风" : score <= 42 ? "宏观需防守" : "宏观中性",
    detail: notes.join(" ")
  };
}

function buildResearchDebate({ technical, fundamentals, sentiment, news, quote }) {
  const bullScore = Math.round((technical.score * 0.35 + fundamentals.score * 0.3 + sentiment.score * 0.25 + news.score * 0.1));
  const bearScore = 100 - bullScore + volatilityPenalty(quote);

  return {
    bull: {
      title: "多头研究员",
      score: clamp(bullScore, 0, 100),
      points: [
        `${technical.verdict}，短线价格反馈是主要正/负信号。`,
        `${fundamentals.verdict}，决定是否值得给更高目标权重。`
      ]
    },
    bear: {
      title: "空头研究员",
      score: clamp(Math.round(bearScore), 0, 100),
      points: [
        quote.changePercent < -2 ? "当日跌幅较大，需防止趋势继续扩散。" : "若涨幅过快，追高性价比会下降。",
        quote.market === "fund" ? "开放式基金估值不是最终净值，成交按确认日处理。" : "盘中价格可能受流动性和市场状态影响。"
      ]
    }
  };
}

function buildTraderDecision(row, portfolio, debate) {
  const edge = debate.bull.score - debate.bear.score;
  const drift = row.drift;
  let action = "持有";
  let tone = "neutral";

  if (edge >= 16 && drift < portfolio.risk.rebalanceThreshold) {
    action = "增配";
    tone = "positive";
  } else if (edge <= -14 || drift > portfolio.risk.rebalanceThreshold) {
    action = "减仓";
    tone = "negative";
  } else if (Math.abs(drift) >= portfolio.risk.rebalanceThreshold) {
    action = drift < 0 ? "补足到目标" : "回到目标";
    tone = drift < 0 ? "positive" : "negative";
  }

  const recommendedWeight = clamp(row.targetWeight + edge / 12 - Math.max(drift, 0) / 2, 0, portfolio.risk.maxSingleWeight);

  return {
    action,
    tone,
    confidence: clamp(Math.round(50 + Math.abs(edge) * 0.7), 35, 92),
    recommendedWeight,
    orderHint:
      action === "增配" || action === "补足到目标"
        ? `计划买入约 ${formatMoney(Math.max(row.rebalanceAmount, 0), row.quote.currency)}，优先分批。`
        : action === "减仓" || action === "回到目标"
          ? `计划卖出约 ${formatMoney(Math.max(-row.rebalanceAmount, 0), row.quote.currency)}，避免一次性冲击。`
          : "保持观察，等待权重偏离或趋势信号更清晰。"
  };
}

function buildRiskDecision(row, portfolio, trade) {
  const quote = row.quote;
  const range = quote.high && quote.low && quote.price ? ((quote.high - quote.low) / quote.price) * 100 : 0;
  const concentration = row.targetWeight > portfolio.risk.maxSingleWeight ? "high" : row.targetWeight > portfolio.risk.maxSingleWeight * 0.75 ? "medium" : "low";
  const riskScore = clamp(Math.round(row.targetWeight * 1.2 + range * 5 + Math.max(-(quote.changePercent || 0), 0) * 4), 0, 100);

  return {
    title: "风控与组合经理",
    riskScore,
    concentration,
    maxSingleWeight: portfolio.risk.maxSingleWeight,
    message:
      riskScore >= 62
        ? "仓位或波动风险偏高，建议先控制单笔规模。"
        : trade.action === "增配"
          ? "风险预算允许，但仍建议分批执行。"
          : "当前风险预算可控，按目标权重跟踪即可。"
  };
}

function emptyAnalysis(row) {
  return {
    score: 0,
    agents: [],
    debate: {
      bull: { title: "多头研究员", score: 0, points: ["等待行情恢复后再评估。"] },
      bear: { title: "空头研究员", score: 100, points: ["行情不可用时不建议生成交易动作。"] }
    },
    trade: {
      action: "暂停",
      tone: "neutral",
      confidence: 0,
      recommendedWeight: Number(row?.targetWeight || 0),
      orderHint: "行情不可用，暂停交易建议。"
    },
    risk: {
      title: "风控与组合经理",
      riskScore: 100,
      concentration: "unknown",
      maxSingleWeight: 0,
      message: "先恢复行情数据，再做组合动作。"
    }
  };
}

function volatilityPenalty(quote) {
  if (!quote.high || !quote.low || !quote.price) return 0;
  const range = ((quote.high - quote.low) / quote.price) * 100;
  return range > 4 ? 8 : range > 2.5 ? 4 : 0;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function formatPercent(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return "--";
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function formatMoney(value, currency = "CNY") {
  const number = Number(value || 0);
  const symbol = currency === "USD" ? "$" : "¥";
  return `${symbol}${number.toLocaleString("zh-CN", { maximumFractionDigits: 0 })}`;
}
