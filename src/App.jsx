import {
  Activity,
  AlertTriangle,
  BarChart3,
  Bot,
  Briefcase,
  CheckCircle2,
  CircleDollarSign,
  Clock3,
  Download,
  LineChart,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Trash2,
  TrendingDown,
  TrendingUp,
  Users
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { loadFx, loadQuotes, searchSymbols } from "./lib/api.js";
import { analyzeAsset, buildPortfolio, RISK_PROFILES } from "./lib/strategy.js";

const DEFAULT_HOLDINGS = [
  { id: "cn:510300", market: "cn", code: "510300", targetWeight: 24, units: 1000, note: "A股核心宽基" },
  { id: "cn:159915", market: "cn", code: "159915", targetWeight: 16, units: 1000, note: "成长弹性" },
  { id: "fund:161725", market: "fund", code: "161725", targetWeight: 12, units: 3000, note: "消费主题基金" },
  { id: "us:VOO", market: "us", code: "VOO", targetWeight: 28, units: 6, note: "美股核心ETF" },
  { id: "us:AAPL", market: "us", code: "AAPL", targetWeight: 20, units: 5, note: "美股科技龙头" }
];

const MARKET_OPTIONS = [
  { value: "cn", label: "A股/场内基金", prefix: "cn:" },
  { value: "fund", label: "开放式基金", prefix: "fund:" },
  { value: "us", label: "美股/美股ETF", prefix: "us:" }
];

const REFRESH_SECONDS = 30;

export default function App() {
  const [holdings, setHoldings] = useLocalStorage("ta-fund-holdings", DEFAULT_HOLDINGS);
  const [capital, setCapital] = useLocalStorage("ta-fund-capital", 200000);
  const [riskKey, setRiskKey] = useLocalStorage("ta-fund-risk", "balanced");
  const [quotes, setQuotes] = useState([]);
  const [fx, setFx] = useState({ rate: 7.2, source: "fallback" });
  const [selectedId, setSelectedId] = useState(holdings[0]?.id || "");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");
  const [lastRefresh, setLastRefresh] = useState(null);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [secondsLeft, setSecondsLeft] = useState(REFRESH_SECONDS);
  const [filter, setFilter] = useState("all");

  const symbols = useMemo(() => holdings.map((item) => item.id), [holdings]);

  const refreshQuotes = useCallback(async () => {
    if (!symbols.length) {
      setQuotes([]);
      return;
    }

    setIsLoading(true);
    setError("");
    try {
      const [quotePayload, fxPayload] = await Promise.all([loadQuotes(symbols), loadFx()]);
      setQuotes(quotePayload.quotes || []);
      setFx(fxPayload);
      setLastRefresh(new Date());
      setSecondsLeft(REFRESH_SECONDS);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : String(requestError));
    } finally {
      setIsLoading(false);
    }
  }, [symbols]);

  useEffect(() => {
    refreshQuotes();
  }, [refreshQuotes]);

  useEffect(() => {
    if (!autoRefresh) return undefined;
    const timer = window.setInterval(() => {
      setSecondsLeft((value) => {
        if (value <= 1) {
          refreshQuotes();
          return REFRESH_SECONDS;
        }
        return value - 1;
      });
    }, 1000);
    return () => window.clearInterval(timer);
  }, [autoRefresh, refreshQuotes]);

  useEffect(() => {
    if (holdings.length && !holdings.some((item) => item.id === selectedId)) {
      setSelectedId(holdings[0].id);
    }
  }, [holdings, selectedId]);

  const portfolio = useMemo(
    () => buildPortfolio(holdings, quotes, Number(capital || 0), riskKey, { USD: fx.rate, CNY: 1 }),
    [holdings, quotes, capital, riskKey, fx.rate]
  );

  const filteredRows = useMemo(() => {
    if (filter === "all") return portfolio.rows;
    return portfolio.rows.filter((row) => row.market === filter || row.quote?.market === filter);
  }, [portfolio.rows, filter]);

  const selectedRow = useMemo(
    () => portfolio.rows.find((row) => row.id === selectedId) || portfolio.rows[0],
    [portfolio.rows, selectedId]
  );

  const marketMood = useMemo(() => {
    const valid = portfolio.rows
      .map((row) => row.quote?.changePercent)
      .filter((value) => Number.isFinite(value));
    if (!valid.length) return 0;
    return valid.reduce((sum, value) => sum + value, 0) / valid.length;
  }, [portfolio.rows]);

  const analysis = useMemo(
    () => analyzeAsset(selectedRow, portfolio, marketMood),
    [selectedRow, portfolio, marketMood]
  );

  const positiveCount = portfolio.rows.filter((row) => (row.quote?.changePercent || 0) > 0).length;
  const negativeCount = portfolio.rows.filter((row) => (row.quote?.changePercent || 0) < 0).length;
  const okCount = portfolio.rows.filter((row) => row.quote?.status === "OK").length;
  const errorCount = portfolio.rows.filter((row) => row.quote?.status === "ERROR").length;

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">
            <Bot size={22} />
          </div>
          <div>
            <strong>FundPilot</strong>
            <span>基金方案客户端</span>
          </div>
        </div>

        <nav className="nav-stack" aria-label="主导航">
          <a href="#dashboard" className="nav-item active">
            <BarChart3 size={18} />
            行情总览
          </a>
          <a href="#portfolio" className="nav-item">
            <Briefcase size={18} />
            组合方案
          </a>
          <a href="#agents" className="nav-item">
            <Users size={18} />
            智能体决策
          </a>
        </nav>

        <div className="source-box">
          <span className="eyebrow">数据源</span>
          <p>东方财富 · 天天基金估值 · CNBC</p>
          <small>USD/CNY: {fx.rate?.toFixed?.(4) || "--"} · {fx.source}</small>
        </div>
      </aside>

      <main className="workspace">
        <header className="topbar">
          <div>
            <span className="eyebrow">实时自选与组合再平衡</span>
            <h1>基金方案工作台</h1>
          </div>
          <div className="topbar-actions">
            <label className="switch">
              <input type="checkbox" checked={autoRefresh} onChange={(event) => setAutoRefresh(event.target.checked)} />
              <span />
              {autoRefresh ? `自动刷新 ${secondsLeft}s` : "手动刷新"}
            </label>
            <button className="icon-button" type="button" onClick={refreshQuotes} title="立即刷新">
              {isLoading ? <Loader2 className="spin" size={18} /> : <RefreshCw size={18} />}
            </button>
          </div>
        </header>

        {error ? (
          <div className="alert">
            <AlertTriangle size={18} />
            {error}
          </div>
        ) : null}

        <section id="dashboard" className="summary-grid">
          <MetricCard
            icon={<CircleDollarSign size={20} />}
            label="计划资金"
            value={formatCny(Number(capital || 0))}
            tone="blue"
            sub={`目标权重 ${portfolio.totalTargetWeight.toFixed(1)}%`}
          />
          <MetricCard
            icon={<Activity size={20} />}
            label="组合涨跌"
            value={formatPercent(portfolio.weightedChange)}
            tone={portfolio.weightedChange >= 0 ? "red" : "green"}
            sub={`${positiveCount} 涨 / ${negativeCount} 跌`}
          />
          <MetricCard
            icon={<Clock3 size={20} />}
            label="数据覆盖"
            value={isLoading ? "更新中" : `${okCount}/${portfolio.rows.length || 0}`}
            tone="amber"
            sub={errorCount ? `${errorCount} 个源异常` : lastRefresh ? `刷新 ${lastRefresh.toLocaleTimeString("zh-CN")}` : "尚未刷新"}
          />
          <MetricCard
            icon={<ShieldCheck size={20} />}
            label="风险档位"
            value={portfolio.risk.label}
            tone="violet"
            sub={`单标上限 ${portfolio.risk.maxSingleWeight}%`}
          />
        </section>

        <section id="portfolio" className="layout-grid">
          <div className="panel watch-panel">
            <div className="panel-header">
              <div>
                <span className="eyebrow">Watchlist</span>
                <h2>自选基金与股票</h2>
              </div>
              <button className="text-button" type="button" onClick={exportPlan}>
                <Download size={16} />
                导出方案
              </button>
            </div>

            <ControlStrip
              filter={filter}
              setFilter={setFilter}
              riskKey={riskKey}
              setRiskKey={setRiskKey}
              capital={capital}
              setCapital={setCapital}
            />

            <AddHoldingForm onAdd={(holding) => addHolding(holding, holdings, setHoldings, setSelectedId)} />

            <QuoteTable
              rows={filteredRows}
              selectedId={selectedRow?.id}
              onSelect={setSelectedId}
              onUpdate={(id, patch) => updateHolding(id, patch, setHoldings)}
              onRemove={(id) => removeHolding(id, setHoldings)}
            />
          </div>

          <div className="panel plan-panel">
            <div className="panel-header">
              <div>
                <span className="eyebrow">Plan</span>
                <h2>组合方案</h2>
              </div>
              <SlidersHorizontal size={20} />
            </div>

            <div className="risk-copy">{portfolio.risk.description}</div>

            <AllocationBars regions={portfolio.regions} />

            <div className="rebalance-list">
              {portfolio.rows.slice(0, 6).map((row) => (
                <div className="rebalance-row" key={row.id}>
                  <div>
                    <strong>{row.quote?.name || row.code}</strong>
                    <span>{row.code} · {row.targetWeight.toFixed(1)}%</span>
                  </div>
                  <div className={row.rebalanceAmount >= 0 ? "amount buy" : "amount sell"}>
                    {row.rebalanceAmount >= 0 ? "买入" : "卖出"} {formatCny(Math.abs(row.rebalanceAmount))}
                  </div>
                </div>
              ))}
            </div>

            {portfolio.warnings.length ? (
              <div className="warning-list">
                {portfolio.warnings.map((warning) => (
                  <div key={warning}>
                    <AlertTriangle size={16} />
                    {warning}
                  </div>
                ))}
              </div>
            ) : (
              <div className="ok-state">
                <CheckCircle2 size={18} />
                当前方案权重与风险约束匹配。
              </div>
            )}
          </div>
        </section>

        <section id="agents" className="panel agents-panel">
          <div className="panel-header">
            <div>
              <span className="eyebrow">FundPilot Decision Room</span>
              <h2>{selectedRow?.quote?.name || selectedRow?.code || "请选择标的"}</h2>
            </div>
            <div className="score-pill">综合分 {analysis.score}</div>
          </div>

          <div className="agent-grid">
            {analysis.agents.map((agent) => (
              <AgentCard key={agent.key} agent={agent} />
            ))}
          </div>

          <div className="decision-grid">
            <DebateCard icon={<TrendingUp size={18} />} side={analysis.debate.bull} tone="red" />
            <DebateCard icon={<TrendingDown size={18} />} side={analysis.debate.bear} tone="green" />
            <div className={`decision-card trader ${analysis.trade.tone}`}>
              <div className="decision-title">
                <LineChart size={18} />
                交易员
              </div>
              <strong>{analysis.trade.action}</strong>
              <p>{analysis.trade.orderHint}</p>
              <span>建议权重 {analysis.trade.recommendedWeight.toFixed(1)}% · 置信度 {analysis.trade.confidence}%</span>
            </div>
            <div className="decision-card">
              <div className="decision-title">
                <ShieldCheck size={18} />
                {analysis.risk.title}
              </div>
              <strong>风险分 {analysis.risk.riskScore}</strong>
              <p>{analysis.risk.message}</p>
              <span>单标上限 {analysis.risk.maxSingleWeight}%</span>
            </div>
          </div>
        </section>
      </main>
    </div>
  );

  function exportPlan() {
    const payload = {
      exportedAt: new Date().toISOString(),
      capital,
      risk: RISK_PROFILES[riskKey],
      fx,
      holdings,
      quotes
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `fund-plan-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    URL.revokeObjectURL(url);
  }
}

function ControlStrip({ filter, setFilter, riskKey, setRiskKey, capital, setCapital }) {
  return (
    <div className="control-strip">
      <div className="segmented">
        {[
          ["all", "全部"],
          ["cn", "A股"],
          ["fund", "基金"],
          ["us", "美股"]
        ].map(([value, label]) => (
          <button key={value} className={filter === value ? "active" : ""} type="button" onClick={() => setFilter(value)}>
            {label}
          </button>
        ))}
      </div>

      <label className="field compact">
        <span>计划资金</span>
        <input type="number" min="0" step="1000" value={capital} onChange={(event) => setCapital(Number(event.target.value))} />
      </label>

      <label className="field compact">
        <span>风险</span>
        <select value={riskKey} onChange={(event) => setRiskKey(event.target.value)}>
          {Object.entries(RISK_PROFILES).map(([key, profile]) => (
            <option value={key} key={key}>
              {profile.label}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

function AddHoldingForm({ onAdd }) {
  const [market, setMarket] = useState("cn");
  const [code, setCode] = useState("");
  const [targetWeight, setTargetWeight] = useState(10);
  const [units, setUnits] = useState(0);
  const [note, setNote] = useState("");
  const [results, setResults] = useState([]);
  const [isSearching, setIsSearching] = useState(false);
  const [searchError, setSearchError] = useState("");

  useEffect(() => {
    const keyword = code.trim();
    if (keyword.length < 2) {
      setResults([]);
      setSearchError("");
      return undefined;
    }

    let cancelled = false;
    const timer = window.setTimeout(async () => {
      setIsSearching(true);
      setSearchError("");
      try {
        const nextResults = await searchSymbols(keyword);
        if (!cancelled) setResults(nextResults);
      } catch (error) {
        if (!cancelled) {
          setResults([]);
          setSearchError(error instanceof Error ? error.message : String(error));
        }
      } finally {
        if (!cancelled) setIsSearching(false);
      }
    }, 350);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [code]);

  function submit(event) {
    event.preventDefault();
    const normalized = code.trim().toUpperCase();
    if (!normalized) return;
    onAdd({
      market,
      code: normalized,
      id: `${market}:${normalized}`,
      targetWeight: Number(targetWeight || 0),
      units: Number(units || 0),
      note
    });
    setCode("");
    setUnits(0);
    setNote("");
  }

  function chooseResult(result) {
    setMarket(result.market);
    setCode(result.code);
    setNote(result.name);
    setResults([]);
  }

  return (
    <form className="add-form" onSubmit={submit}>
      <label className="field">
        <span>市场</span>
        <select value={market} onChange={(event) => setMarket(event.target.value)}>
          {MARKET_OPTIONS.map((option) => (
            <option value={option.value} key={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      <label className="field code-field">
        <span>代码</span>
        <div className="input-with-icon">
          <Search size={16} />
          <input placeholder={MARKET_OPTIONS.find((item) => item.value === market)?.prefix + "代码"} value={code} onChange={(event) => setCode(event.target.value)} />
        </div>
        {(results.length || isSearching || searchError) ? (
          <div className="search-results">
            {isSearching ? <div className="search-state">搜索真实数据中...</div> : null}
            {searchError ? <div className="search-state error">{searchError}</div> : null}
            {results.map((result) => (
              <button type="button" key={result.id} onClick={() => chooseResult(result)}>
                <strong>{result.name}</strong>
                <span>{result.id} · {result.assetType} · {result.source}</span>
              </button>
            ))}
          </div>
        ) : null}
      </label>
      <label className="field tiny">
        <span>目标%</span>
        <input type="number" min="0" max="100" step="0.5" value={targetWeight} onChange={(event) => setTargetWeight(event.target.value)} />
      </label>
      <label className="field tiny">
        <span>份额</span>
        <input type="number" min="0" step="0.01" value={units} onChange={(event) => setUnits(event.target.value)} />
      </label>
      <label className="field note-field">
        <span>备注</span>
        <input placeholder="核心/卫星/观察" value={note} onChange={(event) => setNote(event.target.value)} />
      </label>
      <button className="primary-button" type="submit">
        <Plus size={16} />
        添加
      </button>
    </form>
  );
}

function QuoteTable({ rows, selectedId, onSelect, onUpdate, onRemove }) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>标的</th>
            <th>最新</th>
            <th>涨跌幅</th>
            <th>开高低</th>
            <th>目标%</th>
            <th>份额</th>
            <th>再平衡</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const quote = row.quote;
            const direction = (quote?.changePercent || 0) >= 0 ? "up" : "down";
            return (
              <tr key={row.id} className={selectedId === row.id ? "selected" : ""} onClick={() => onSelect(row.id)}>
                <td>
                  <div className="asset-cell">
                    <strong>{quote?.name || row.code}</strong>
                    <span>{row.id} · {marketLabel(row.market)} · {row.note || "未备注"}</span>
                    {quote?.error ? <small className="row-error">{quote.error}</small> : null}
                  </div>
                </td>
                <td>
                  <strong>{formatPrice(quote?.price, quote?.currency)}</strong>
                  <span className="muted">{quote?.source || "--"}</span>
                </td>
                <td>
                  <span className={`change ${direction}`}>{formatPercent(quote?.changePercent)}</span>
                  <span className="muted">{formatSigned(quote?.change)}</span>
                </td>
                <td>
                  <span>{formatRange(quote)}</span>
                  <span className="muted">{quote?.tradeTime || quote?.estimateTime || quote?.lastUpdated?.slice(11, 19) || "--"}</span>
                </td>
                <td>
                  <input
                    className="table-input"
                    type="number"
                    min="0"
                    max="100"
                    step="0.5"
                    value={row.targetWeight}
                    onClick={(event) => event.stopPropagation()}
                    onChange={(event) => onUpdate(row.id, { targetWeight: Number(event.target.value) })}
                  />
                </td>
                <td>
                  <input
                    className="table-input"
                    type="number"
                    min="0"
                    step="0.01"
                    value={row.units}
                    onClick={(event) => event.stopPropagation()}
                    onChange={(event) => onUpdate(row.id, { units: Number(event.target.value) })}
                  />
                </td>
                <td>
                  <span className={row.rebalanceAmount >= 0 ? "buy" : "sell"}>{row.rebalanceAmount >= 0 ? "买" : "卖"} {formatCny(Math.abs(row.rebalanceAmount))}</span>
                  <span className="muted">{row.rebalanceUnits ? `${Math.abs(row.rebalanceUnits).toFixed(2)} 份` : "--"}</span>
                </td>
                <td>
                  <button className="icon-button danger" type="button" title="删除" onClick={(event) => {
                    event.stopPropagation();
                    onRemove(row.id);
                  }}>
                    <Trash2 size={16} />
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function MetricCard({ icon, label, value, sub, tone }) {
  return (
    <div className={`metric-card ${tone}`}>
      <div className="metric-icon">{icon}</div>
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{sub}</small>
    </div>
  );
}

function AllocationBars({ regions }) {
  const items = [
    { key: "cn", label: "A股/场内", value: regions.cn || 0, className: "cn" },
    { key: "fund", label: "开放基金", value: regions.fund || 0, className: "fund" },
    { key: "us", label: "美股", value: regions.us || 0, className: "us" }
  ];

  return (
    <div className="allocation">
      {items.map((item) => (
        <div className="allocation-row" key={item.key}>
          <div>
            <span>{item.label}</span>
            <strong>{item.value.toFixed(1)}%</strong>
          </div>
          <div className="bar">
            <i className={item.className} style={{ width: `${Math.min(item.value, 100)}%` }} />
          </div>
        </div>
      ))}
    </div>
  );
}

function AgentCard({ agent }) {
  return (
    <div className="agent-card">
      <div className="agent-top">
        <strong>{agent.title}</strong>
        <span>{agent.score}</span>
      </div>
      <div className="score-track">
        <i style={{ width: `${agent.score}%` }} />
      </div>
      <h3>{agent.verdict}</h3>
      <p>{agent.detail}</p>
    </div>
  );
}

function DebateCard({ side, tone, icon }) {
  return (
    <div className={`decision-card ${tone}`}>
      <div className="decision-title">
        {icon}
        {side.title}
      </div>
      <strong>{side.score}</strong>
      {side.points.map((point) => (
        <p key={point}>{point}</p>
      ))}
    </div>
  );
}

function addHolding(holding, holdings, setHoldings, setSelectedId) {
  if (holdings.some((item) => item.id === holding.id)) {
    setSelectedId(holding.id);
    return;
  }
  setHoldings([...holdings, holding]);
  setSelectedId(holding.id);
}

function updateHolding(id, patch, setHoldings) {
  setHoldings((items) => items.map((item) => (item.id === id ? { ...item, ...patch } : item)));
}

function removeHolding(id, setHoldings) {
  setHoldings((items) => items.filter((item) => item.id !== id));
}

function useLocalStorage(key, initialValue) {
  const [value, setValue] = useState(() => {
    try {
      const saved = window.localStorage.getItem(key);
      return saved ? JSON.parse(saved) : initialValue;
    } catch {
      return initialValue;
    }
  });

  useEffect(() => {
    window.localStorage.setItem(key, JSON.stringify(value));
  }, [key, value]);

  return [value, setValue];
}

function marketLabel(market) {
  if (market === "cn") return "A股";
  if (market === "fund") return "开放基金";
  if (market === "us") return "美股";
  return market;
}

function formatPercent(value) {
  if (!Number.isFinite(value)) return "--";
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function formatSigned(value) {
  if (!Number.isFinite(value)) return "--";
  return `${value >= 0 ? "+" : ""}${value.toFixed(3)}`;
}

function formatPrice(value, currency = "CNY") {
  if (!Number.isFinite(value)) return "--";
  const symbol = currency === "USD" ? "$" : "¥";
  return `${symbol}${value.toLocaleString("zh-CN", { minimumFractionDigits: value > 100 ? 2 : 3, maximumFractionDigits: value > 100 ? 2 : 3 })}`;
}

function formatCny(value) {
  const number = Number(value || 0);
  return `¥${number.toLocaleString("zh-CN", { maximumFractionDigits: 0 })}`;
}

function formatRange(quote) {
  if (!quote || !Number.isFinite(quote.open) || !Number.isFinite(quote.high) || !Number.isFinite(quote.low)) return "--";
  return `${quote.open.toFixed(3)} / ${quote.high.toFixed(3)} / ${quote.low.toFixed(3)}`;
}
