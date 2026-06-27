use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::HashMap,
    env,
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::sync::RwLock;

const QUOTE_CACHE_TTL: Duration = Duration::from_secs(15);
const FX_CACHE_TTL: Duration = Duration::from_secs(30 * 60);

#[derive(Clone)]
pub struct MarketDataClient {
    client: reqwest::Client,
    quote_cache: Arc<RwLock<HashMap<String, CachedQuote>>>,
    fx_cache: Arc<RwLock<Option<CachedFx>>>,
}

#[derive(Clone)]
struct CachedQuote {
    quote: Quote,
    cached_at: Instant,
}

#[derive(Clone)]
struct CachedFx {
    fx: FxRate,
    cached_at: Instant,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuoteResponse {
    pub requested: Vec<String>,
    pub quotes: Vec<Quote>,
    pub received_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Quote {
    pub id: String,
    pub code: String,
    pub market: String,
    pub name: String,
    #[serde(rename = "type")]
    pub asset_type: String,
    pub currency: String,
    pub price: Option<f64>,
    pub change: Option<f64>,
    pub change_percent: Option<f64>,
    pub previous_close: Option<f64>,
    pub open: Option<f64>,
    pub high: Option<f64>,
    pub low: Option<f64>,
    pub volume: Option<f64>,
    pub turnover: Option<f64>,
    pub market_cap: Option<f64>,
    pub float_market_cap: Option<f64>,
    pub source: String,
    pub status: String,
    pub last_updated: String,
    pub error: Option<String>,
    pub exchange: Option<String>,
    pub market_status: Option<String>,
    pub trade_time: Option<String>,
    pub nav_date: Option<String>,
    pub estimate_time: Option<String>,
    pub fundamentals: Option<Fundamentals>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Fundamentals {
    pub pe: Option<f64>,
    pub forward_pe: Option<f64>,
    pub eps: Option<f64>,
    pub beta: Option<f64>,
    pub dividend_yield: Option<f64>,
    pub market_cap: Option<f64>,
    pub revenue_ttm: Option<f64>,
    pub year_high: Option<f64>,
    pub year_low: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FxRate {
    pub base: String,
    pub quote: String,
    pub rate: f64,
    pub source: String,
    pub last_updated: String,
    pub warning: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub id: String,
    pub code: String,
    pub market: String,
    pub name: String,
    pub asset_type: String,
    pub exchange: Option<String>,
    pub source: String,
    pub hint: String,
}

#[derive(Debug, Clone)]
struct SymbolItem {
    id: String,
    code: String,
    market: String,
}

impl MarketDataClient {
    pub fn new() -> Result<Self, reqwest::Error> {
        let client = reqwest::Client::builder()
            .user_agent("Mozilla/5.0 TradingAgentsFundClient/1.0")
            .timeout(Duration::from_secs(10))
            .build()?;

        Ok(Self {
            client,
            quote_cache: Arc::new(RwLock::new(HashMap::new())),
            fx_cache: Arc::new(RwLock::new(None)),
        })
    }

    pub async fn get_quote_response(&self, symbols: Vec<String>) -> QuoteResponse {
        QuoteResponse {
            requested: symbols.clone(),
            quotes: self.get_quotes(&symbols).await,
            received_at: now_iso(),
        }
    }

    pub async fn get_quotes(&self, symbols: &[String]) -> Vec<Quote> {
        let normalized = symbols
            .iter()
            .map(|symbol| normalize_symbol(symbol))
            .collect::<Vec<_>>();

        let now = Instant::now();
        let mut pending = Vec::new();
        {
            let cache = self.quote_cache.read().await;
            for item in &normalized {
                let is_fresh = cache
                    .get(&item.id)
                    .map(|cached| now.duration_since(cached.cached_at) < QUOTE_CACHE_TTL)
                    .unwrap_or(false);
                if !is_fresh {
                    pending.push(item.clone());
                }
            }
        }

        if !pending.is_empty() {
            let cn_items = pending
                .iter()
                .filter(|item| item.market == "cn")
                .cloned()
                .collect::<Vec<_>>();
            let fund_items = pending
                .iter()
                .filter(|item| item.market == "fund")
                .cloned()
                .collect::<Vec<_>>();
            let us_items = pending
                .iter()
                .filter(|item| item.market == "us")
                .cloned()
                .collect::<Vec<_>>();

            let (china, funds, us) = tokio::join!(
                fetch_china_quotes(&self.client, cn_items),
                fetch_fund_estimates(&self.client, fund_items),
                fetch_us_quotes(&self.client, us_items)
            );

            let mut cache = self.quote_cache.write().await;
            for quote in china.into_iter().chain(funds).chain(us) {
                cache.insert(
                    quote.id.clone(),
                    CachedQuote {
                        quote,
                        cached_at: now,
                    },
                );
            }
        }

        let cache = self.quote_cache.read().await;
        normalized
            .iter()
            .map(|item| {
                cache
                    .get(&item.id)
                    .map(|cached| cached.quote.clone())
                    .unwrap_or_else(|| error_quote(item, "local", "quote unavailable"))
            })
            .collect()
    }

    pub async fn get_usd_cny_rate(&self) -> FxRate {
        let now = Instant::now();
        {
            let cache = self.fx_cache.read().await;
            if let Some(cached) = cache.as_ref() {
                if now.duration_since(cached.cached_at) < FX_CACHE_TTL {
                    return cached.fx.clone();
                }
            }
        }

        let fetched = match self
            .client
            .get("https://open.er-api.com/v6/latest/USD")
            .send()
            .await
        {
            Ok(response) if response.status().is_success() => {
                match response.json::<Value>().await {
                    Ok(payload) => payload
                        .get("rates")
                        .and_then(|rates| rates.get("CNY"))
                        .and_then(Value::as_f64)
                        .filter(|rate| *rate > 0.0)
                        .map(|rate| FxRate {
                            base: "USD".to_string(),
                            quote: "CNY".to_string(),
                            rate,
                            source: "open.er-api.com".to_string(),
                            last_updated: now_iso(),
                            warning: None,
                        })
                        .unwrap_or_else(|| fallback_fx("missing CNY rate")),
                    Err(error) => fallback_fx(&error.to_string()),
                }
            }
            Ok(response) => fallback_fx(&format!("FX provider returned {}", response.status())),
            Err(error) => fallback_fx(&error.to_string()),
        };

        let mut cache = self.fx_cache.write().await;
        *cache = Some(CachedFx {
            fx: fetched.clone(),
            cached_at: now,
        });
        fetched
    }

    pub async fn search_symbols(&self, keyword: String) -> Vec<SearchResult> {
        let keyword = keyword.trim().to_string();
        if keyword.len() < 2 {
            return Vec::new();
        }

        let (mut cn, mut us) = tokio::join!(
            search_eastmoney(&self.client, &keyword),
            search_nasdaq(&self.client, &keyword)
        );

        let mut merged = if keyword
            .chars()
            .all(|ch| ch.is_ascii_alphabetic() || ch == '.')
        {
            us.append(&mut cn);
            us
        } else {
            cn.append(&mut us);
            cn
        };
        let mut seen = HashMap::new();
        merged
            .drain(..)
            .filter(|item| seen.insert(item.id.clone(), true).is_none())
            .take(12)
            .collect()
    }
}

fn normalize_symbol(input: &str) -> SymbolItem {
    let raw = input.trim();
    let (market, code) = if let Some((prefix, code)) = raw.split_once(':') {
        (normalize_market(prefix), code.trim().to_uppercase())
    } else {
        let code = raw.trim().to_uppercase();
        let market = if code.len() == 6 && code.chars().all(|ch| ch.is_ascii_digit()) {
            "cn".to_string()
        } else {
            "us".to_string()
        };
        (market, code)
    };

    SymbolItem {
        id: format!("{market}:{code}"),
        code,
        market,
    }
}

fn normalize_market(prefix: &str) -> String {
    match prefix.trim().to_ascii_lowercase().as_str() {
        "a" | "cn" | "china" | "ashare" | "etf" => "cn".to_string(),
        "fund" | "openfund" | "mf" => "fund".to_string(),
        "us" | "usa" | "nasdaq" | "nyse" => "us".to_string(),
        other => other.to_string(),
    }
}

async fn fetch_china_quotes(client: &reqwest::Client, items: Vec<SymbolItem>) -> Vec<Quote> {
    if items.is_empty() {
        return Vec::new();
    }

    let secids = items
        .iter()
        .map(|item| guess_china_secid(&item.code))
        .collect::<Vec<_>>()
        .join(",");
    let fields = "f2,f3,f4,f5,f6,f12,f13,f14,f15,f16,f17,f18,f20,f21,f152";

    match client
        .get("https://push2.eastmoney.com/api/qt/ulist.np/get")
        .query(&[("secids", secids.as_str()), ("fields", fields)])
        .header("Referer", "https://quote.eastmoney.com/")
        .send()
        .await
    {
        Ok(response) if response.status().is_success() => match response.json::<Value>().await {
            Ok(payload) => {
                let mut by_code: HashMap<String, Value> = HashMap::new();
                if let Some(rows) = payload
                    .get("data")
                    .and_then(|data| data.get("diff"))
                    .and_then(Value::as_array)
                {
                    for row in rows {
                        if let Some(code) = row.get("f12").and_then(Value::as_str) {
                            by_code.insert(code.to_string(), row.clone());
                        }
                    }
                }

                items
                    .iter()
                    .map(|item| {
                        by_code
                            .get(&item.code)
                            .map(|row| map_eastmoney_quote(item, row))
                            .unwrap_or_else(|| {
                                error_quote(item, "Eastmoney", "symbol not returned")
                            })
                    })
                    .collect()
            }
            Err(error) => items
                .iter()
                .map(|item| error_quote(item, "Eastmoney", &error.to_string()))
                .collect(),
        },
        Ok(response) => {
            let message = format!("Eastmoney returned {}", response.status());
            items
                .iter()
                .map(|item| error_quote(item, "Eastmoney", &message))
                .collect()
        }
        Err(error) => items
            .iter()
            .map(|item| error_quote(item, "Eastmoney", &error.to_string()))
            .collect(),
    }
}

fn map_eastmoney_quote(item: &SymbolItem, row: &Value) -> Quote {
    let scale = china_price_scale(&item.code);
    let name = row
        .get("f14")
        .and_then(Value::as_str)
        .unwrap_or(&item.code)
        .to_string();

    Quote {
        id: item.id.clone(),
        code: item.code.clone(),
        market: "cn".to_string(),
        name: name.clone(),
        asset_type: infer_china_type(&item.code, &name),
        currency: "CNY".to_string(),
        price: scaled_value(row.get("f2"), scale),
        change: scaled_value(row.get("f4"), scale),
        change_percent: scaled_value(row.get("f3"), 100.0),
        previous_close: scaled_value(row.get("f18"), scale),
        open: scaled_value(row.get("f17"), scale),
        high: scaled_value(row.get("f15"), scale),
        low: scaled_value(row.get("f16"), scale),
        volume: value_as_f64(row.get("f5")),
        turnover: value_as_f64(row.get("f6")),
        market_cap: value_as_f64(row.get("f20")),
        float_market_cap: value_as_f64(row.get("f21")),
        source: "Eastmoney".to_string(),
        status: "OK".to_string(),
        last_updated: now_iso(),
        error: None,
        exchange: Some(if value_as_i64(row.get("f13")) == Some(1) {
            "SH".to_string()
        } else {
            "SZ".to_string()
        }),
        market_status: None,
        trade_time: None,
        nav_date: None,
        estimate_time: None,
        fundamentals: None,
    }
}

async fn fetch_fund_estimates(client: &reqwest::Client, items: Vec<SymbolItem>) -> Vec<Quote> {
    if items.is_empty() {
        return Vec::new();
    }

    let mut quotes = Vec::with_capacity(items.len());
    for item in items {
        quotes.push(fetch_one_fund_estimate(client, item).await);
    }
    quotes
}

async fn fetch_one_fund_estimate(client: &reqwest::Client, item: SymbolItem) -> Quote {
    let url = format!(
        "https://fundgz.1234567.com.cn/js/{}.js?rt={}",
        item.code,
        Utc::now().timestamp_millis()
    );

    match client
        .get(url)
        .header("Referer", "https://fund.eastmoney.com/")
        .send()
        .await
    {
        Ok(response) if response.status().is_success() => match response.text().await {
            Ok(text) => parse_fund_estimate(&item, &text)
                .unwrap_or_else(|message| error_quote(&item, "Eastmoney Fund Estimate", &message)),
            Err(error) => error_quote(&item, "Eastmoney Fund Estimate", &error.to_string()),
        },
        Ok(response) => error_quote(
            &item,
            "Eastmoney Fund Estimate",
            &format!("fund estimate returned {}", response.status()),
        ),
        Err(error) => error_quote(&item, "Eastmoney Fund Estimate", &error.to_string()),
    }
}

fn parse_fund_estimate(item: &SymbolItem, text: &str) -> Result<Quote, String> {
    let start = text.find('(').ok_or("fund estimate payload is empty")? + 1;
    let end = text
        .rfind(')')
        .ok_or("fund estimate payload is malformed")?;
    let data: Value = serde_json::from_str(&text[start..end]).map_err(|error| error.to_string())?;
    let price = str_field_as_f64(&data, "gsz");
    let previous_close = str_field_as_f64(&data, "dwjz");
    let change = match (price, previous_close) {
        (Some(price), Some(previous_close)) => Some(price - previous_close),
        _ => None,
    };

    Ok(Quote {
        id: item.id.clone(),
        code: item.code.clone(),
        market: "fund".to_string(),
        name: data
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or(&item.code)
            .to_string(),
        asset_type: "OPEN_FUND".to_string(),
        currency: "CNY".to_string(),
        price,
        change,
        change_percent: str_field_as_f64(&data, "gszzl"),
        previous_close,
        open: None,
        high: None,
        low: None,
        volume: None,
        turnover: None,
        market_cap: None,
        float_market_cap: None,
        source: "Eastmoney Fund Estimate".to_string(),
        status: "OK".to_string(),
        last_updated: now_iso(),
        error: None,
        exchange: None,
        market_status: None,
        trade_time: None,
        nav_date: data
            .get("jzrq")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned),
        estimate_time: data
            .get("gztime")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned),
        fundamentals: None,
    })
}

async fn fetch_us_quotes(client: &reqwest::Client, items: Vec<SymbolItem>) -> Vec<Quote> {
    if items.is_empty() {
        return Vec::new();
    }

    let symbols = items
        .iter()
        .map(|item| item.code.as_str())
        .collect::<Vec<_>>()
        .join("|");

    match client
        .get("https://quote.cnbc.com/quote-html-webservice/quote.htm")
        .query(&[
            ("symbols", symbols.as_str()),
            ("requestMethod", "quick"),
            ("noform", "1"),
            ("partnerId", "2"),
            ("fund", "1"),
            ("output", "json"),
        ])
        .send()
        .await
    {
        Ok(response) if response.status().is_success() => match response.json::<Value>().await {
            Ok(payload) => {
                let mut by_symbol: HashMap<String, Value> = HashMap::new();
                let quick_quote = payload
                    .get("QuickQuoteResult")
                    .and_then(|result| result.get("QuickQuote"));
                match quick_quote {
                    Some(Value::Array(rows)) => {
                        for row in rows {
                            if let Some(symbol) = row.get("symbol").and_then(Value::as_str) {
                                by_symbol.insert(symbol.to_ascii_uppercase(), row.clone());
                            }
                        }
                    }
                    Some(Value::Object(_)) => {
                        if let Some(symbol) = quick_quote
                            .and_then(|row| row.get("symbol"))
                            .and_then(Value::as_str)
                        {
                            by_symbol
                                .insert(symbol.to_ascii_uppercase(), quick_quote.unwrap().clone());
                        }
                    }
                    _ => {}
                }

                items
                    .iter()
                    .map(|item| {
                        by_symbol
                            .get(&item.code)
                            .map(|row| map_cnbc_quote(item, row))
                            .unwrap_or_else(|| error_quote(item, "CNBC", "symbol not returned"))
                    })
                    .collect()
            }
            Err(error) => items
                .iter()
                .map(|item| error_quote(item, "CNBC", &error.to_string()))
                .collect(),
        },
        Ok(response) => {
            let message = format!("CNBC returned {}", response.status());
            items
                .iter()
                .map(|item| error_quote(item, "CNBC", &message))
                .collect()
        }
        Err(error) => items
            .iter()
            .map(|item| error_quote(item, "CNBC", &error.to_string()))
            .collect(),
    }
}

fn map_cnbc_quote(item: &SymbolItem, row: &Value) -> Quote {
    let fundamentals = row.get("FundamentalData");
    let name = row
        .get("name")
        .or_else(|| row.get("shortName"))
        .and_then(Value::as_str)
        .unwrap_or(&item.code)
        .to_string();

    Quote {
        id: item.id.clone(),
        code: item.code.clone(),
        market: "us".to_string(),
        name: name.clone(),
        asset_type: infer_us_type(row, &name),
        currency: row
            .get("currencyCode")
            .and_then(Value::as_str)
            .unwrap_or("USD")
            .to_string(),
        price: str_or_num_as_f64(row.get("last")),
        change: str_or_num_as_f64(row.get("change")),
        change_percent: str_or_num_as_f64(row.get("change_pct")),
        previous_close: str_or_num_as_f64(row.get("previous_day_closing")),
        open: str_or_num_as_f64(row.get("open")),
        high: str_or_num_as_f64(row.get("high")),
        low: str_or_num_as_f64(row.get("low")),
        volume: str_or_num_as_f64(row.get("fullVolume"))
            .or_else(|| str_or_num_as_f64(row.get("volume"))),
        turnover: None,
        market_cap: fundamentals.and_then(|data| str_or_num_as_f64(data.get("mktcap"))),
        float_market_cap: None,
        source: "CNBC".to_string(),
        status: "OK".to_string(),
        last_updated: now_iso(),
        error: None,
        exchange: row
            .get("exchange")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned),
        market_status: row
            .get("mainmktstatus")
            .or_else(|| row.get("curmktstatus"))
            .and_then(Value::as_str)
            .map(ToOwned::to_owned),
        trade_time: row
            .get("last_time")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned),
        nav_date: None,
        estimate_time: None,
        fundamentals: fundamentals.map(|data| Fundamentals {
            pe: str_or_num_as_f64(data.get("pe")),
            forward_pe: str_or_num_as_f64(data.get("fpe")),
            eps: str_or_num_as_f64(data.get("eps")),
            beta: str_or_num_as_f64(data.get("beta")),
            dividend_yield: str_or_num_as_f64(data.get("dividendyield")),
            market_cap: str_or_num_as_f64(data.get("mktcap")),
            revenue_ttm: str_or_num_as_f64(data.get("revenuettm")),
            year_high: str_or_num_as_f64(data.get("yrhiprice")),
            year_low: str_or_num_as_f64(data.get("yrloprice")),
        }),
    }
}

async fn search_eastmoney(client: &reqwest::Client, keyword: &str) -> Vec<SearchResult> {
    let response = client
        .get("https://searchapi.eastmoney.com/api/suggest/get")
        .query(&[
            ("input", keyword),
            ("type", "14"),
            ("token", "D43BF722C8E33BDC906FB84D85E326E8"),
        ])
        .header("Referer", "https://www.eastmoney.com/")
        .send()
        .await;

    let Ok(response) = response else {
        return Vec::new();
    };
    let Ok(payload) = response.json::<Value>().await else {
        return Vec::new();
    };

    let rows = payload
        .get("QuotationCodeTable")
        .and_then(|table| table.get("Data"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    let mut results = Vec::new();
    for row in rows {
        let code = row
            .get("UnifiedCode")
            .or_else(|| row.get("Code"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        if code.is_empty() {
            continue;
        }
        let name = row
            .get("Name")
            .and_then(Value::as_str)
            .unwrap_or(&code)
            .to_string();
        let quote_id = row
            .get("QuoteID")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let security_type = row
            .get("SecurityTypeName")
            .and_then(Value::as_str)
            .unwrap_or("证券");
        let exchange = if quote_id.starts_with("1.") {
            Some("SH".to_string())
        } else if quote_id.starts_with("0.") {
            Some("SZ".to_string())
        } else {
            None
        };
        let market = if security_type.contains("基金")
            && !(code.starts_with("15")
                || code.starts_with("16")
                || code.starts_with("50")
                || code.starts_with("51")
                || code.starts_with("52")
                || code.starts_with("56")
                || code.starts_with("58"))
        {
            "fund"
        } else {
            "cn"
        };

        results.push(SearchResult {
            id: format!("{market}:{code}"),
            code,
            market: market.to_string(),
            name,
            asset_type: security_type.to_string(),
            exchange,
            source: "Eastmoney Search".to_string(),
            hint: "A股/场内基金/开放式基金".to_string(),
        });
    }

    results
}

async fn search_nasdaq(client: &reqwest::Client, keyword: &str) -> Vec<SearchResult> {
    let response = client
        .get("https://api.nasdaq.com/api/autocomplete/slookup/10")
        .query(&[("search", keyword)])
        .header("Origin", "https://www.nasdaq.com")
        .header("Referer", "https://www.nasdaq.com/")
        .send()
        .await;

    let Ok(response) = response else {
        return Vec::new();
    };
    let Ok(payload) = response.json::<Value>().await else {
        return Vec::new();
    };

    payload
        .get("data")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|row| {
            let code = row
                .get("symbol")
                .and_then(Value::as_str)?
                .trim()
                .to_uppercase();
            let name = row
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or(&code)
                .trim()
                .to_string();
            let asset = row
                .get("asset")
                .and_then(Value::as_str)
                .unwrap_or("US")
                .to_string();
            Some(SearchResult {
                id: format!("us:{code}"),
                code,
                market: "us".to_string(),
                name,
                asset_type: asset,
                exchange: row
                    .get("exchange")
                    .and_then(Value::as_str)
                    .filter(|value| !value.is_empty())
                    .map(ToOwned::to_owned),
                source: "Nasdaq Search".to_string(),
                hint: "美股/ETF/基金".to_string(),
            })
        })
        .collect()
}

fn guess_china_secid(code: &str) -> String {
    let sh_prefixes = [
        "50", "51", "52", "56", "58", "60", "68", "69", "90", "110", "113", "118", "132", "204",
        "501", "502", "506", "508", "510", "511", "512", "513", "515", "516", "517", "518", "519",
        "560", "561", "562", "563", "588", "589", "600", "601", "603", "605", "688", "689",
    ];
    let market = if sh_prefixes.iter().any(|prefix| code.starts_with(prefix)) {
        "1"
    } else {
        "0"
    };
    format!("{market}.{code}")
}

fn china_price_scale(code: &str) -> f64 {
    if ["15", "16", "18", "50", "51", "52", "56", "58"]
        .iter()
        .any(|prefix| code.starts_with(prefix))
    {
        1000.0
    } else {
        100.0
    }
}

fn infer_china_type(code: &str, name: &str) -> String {
    if ["15", "16", "18", "50", "51", "52", "56", "58"]
        .iter()
        .any(|prefix| code.starts_with(prefix))
        || name.to_ascii_uppercase().contains("ETF")
        || name.to_ascii_uppercase().contains("LOF")
    {
        "CN_FUND".to_string()
    } else {
        "CN_STOCK".to_string()
    }
}

fn infer_us_type(row: &Value, name: &str) -> String {
    let asset_subtype = row
        .get("assetSubType")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let text = format!("{asset_subtype} {name}").to_ascii_lowercase();
    if text.contains("etf") || text.contains("exchange traded fund") {
        "US_FUND".to_string()
    } else {
        "US_STOCK".to_string()
    }
}

fn fallback_fx(message: &str) -> FxRate {
    let rate = env::var("USD_CNY_FALLBACK")
        .ok()
        .and_then(|value| value.parse::<f64>().ok())
        .unwrap_or(7.2);

    FxRate {
        base: "USD".to_string(),
        quote: "CNY".to_string(),
        rate,
        source: "fallback".to_string(),
        last_updated: now_iso(),
        warning: Some(message.to_string()),
    }
}

fn error_quote(item: &SymbolItem, source: &str, message: &str) -> Quote {
    Quote {
        id: item.id.clone(),
        code: item.code.clone(),
        market: item.market.clone(),
        name: item.code.clone(),
        asset_type: "UNKNOWN".to_string(),
        currency: if item.market == "us" { "USD" } else { "CNY" }.to_string(),
        price: None,
        change: None,
        change_percent: None,
        previous_close: None,
        open: None,
        high: None,
        low: None,
        volume: None,
        turnover: None,
        market_cap: None,
        float_market_cap: None,
        source: source.to_string(),
        status: "ERROR".to_string(),
        last_updated: now_iso(),
        error: Some(message.to_string()),
        exchange: None,
        market_status: None,
        trade_time: None,
        nav_date: None,
        estimate_time: None,
        fundamentals: None,
    }
}

fn scaled_value(value: Option<&Value>, scale: f64) -> Option<f64> {
    value_as_f64(value).map(|number| number / scale)
}

fn value_as_i64(value: Option<&Value>) -> Option<i64> {
    match value? {
        Value::Number(number) => number.as_i64(),
        Value::String(text) => text.parse::<i64>().ok(),
        _ => None,
    }
}

fn value_as_f64(value: Option<&Value>) -> Option<f64> {
    match value? {
        Value::Number(number) => number.as_f64(),
        Value::String(text) => parse_number_text(text),
        _ => None,
    }
}

fn str_field_as_f64(data: &Value, key: &str) -> Option<f64> {
    str_or_num_as_f64(data.get(key))
}

fn str_or_num_as_f64(value: Option<&Value>) -> Option<f64> {
    match value? {
        Value::Number(number) => number.as_f64(),
        Value::String(text) => parse_number_text(text),
        _ => None,
    }
}

fn parse_number_text(text: &str) -> Option<f64> {
    let cleaned = text
        .trim()
        .replace(['$', '%', ','], "")
        .replace("N/A", "")
        .replace("--", "");
    if cleaned.is_empty() || cleaned == "-" {
        return None;
    }
    cleaned.parse::<f64>().ok()
}

pub fn now_iso() -> String {
    Utc::now().to_rfc3339()
}
