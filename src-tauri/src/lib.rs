use market_data::{FxRate, MarketDataClient, QuoteResponse, SearchResult};
use tauri::{Manager, State};

struct DesktopState {
    market: MarketDataClient,
}

#[tauri::command]
async fn get_quotes(
    symbols: Vec<String>,
    state: State<'_, DesktopState>,
) -> Result<QuoteResponse, String> {
    Ok(state.market.get_quote_response(symbols).await)
}

#[tauri::command]
async fn get_fx(state: State<'_, DesktopState>) -> Result<FxRate, String> {
    Ok(state.market.get_usd_cny_rate().await)
}

#[tauri::command]
async fn search_symbols(
    keyword: String,
    state: State<'_, DesktopState>,
) -> Result<Vec<SearchResult>, String> {
    Ok(state.market.search_symbols(keyword).await)
}

pub fn run() {
    let market = MarketDataClient::new().expect("failed to create market data client");

    tauri::Builder::default()
        .manage(DesktopState { market })
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_title("TradingAgents 基金方案客户端");
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![get_quotes, get_fx, search_symbols])
        .run(tauri::generate_context!())
        .expect("error while running TradingAgents desktop client");
}
