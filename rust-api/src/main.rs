use axum::{
    Json, Router,
    extract::{Query, State},
    http::{
        Method, StatusCode,
        header::{CONTENT_TYPE, HeaderValue},
    },
    response::{IntoResponse, Response},
    routing::get,
};
use market_data::{MarketDataClient, now_iso};
use serde_json::json;
use std::{env, net::SocketAddr, path::PathBuf};
use tower_http::{
    cors::{Any, CorsLayer},
    services::{ServeDir, ServeFile},
    trace::TraceLayer,
};

#[derive(Clone)]
struct AppState {
    market: MarketDataClient,
}

#[derive(Debug, Clone, serde::Deserialize)]
struct QuoteQuery {
    symbols: String,
}

#[derive(Debug, Clone, serde::Deserialize)]
struct SearchQuery {
    keyword: String,
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            env::var("RUST_LOG").unwrap_or_else(|_| "info,tower_http=warn".to_string()),
        )
        .init();

    let state = AppState {
        market: MarketDataClient::new().expect("failed to create market data client"),
    };

    let dist_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("dist");
    let static_files =
        ServeDir::new(&dist_path).not_found_service(ServeFile::new(dist_path.join("index.html")));

    let app = Router::new()
        .route("/api/health", get(health))
        .route("/api/quotes", get(quotes_handler))
        .route("/api/fx", get(fx_handler))
        .route("/api/search", get(search_handler))
        .fallback_service(static_files)
        .with_state(state)
        .layer(
            CorsLayer::new()
                .allow_origin(Any)
                .allow_methods([Method::GET])
                .allow_headers(Any),
        )
        .layer(TraceLayer::new_for_http());

    let port = env::var("PORT")
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(8787);
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .expect("failed to bind API port");

    println!("FundPilot Rust API listening on http://{addr}");
    axum::serve(listener, app).await.expect("API server failed");
}

async fn health() -> Response {
    json_response(
        StatusCode::OK,
        json!({
            "ok": true,
            "service": "FundPilot Client Rust API",
            "time": now_iso()
        }),
    )
}

async fn quotes_handler(
    State(state): State<AppState>,
    Query(query): Query<QuoteQuery>,
) -> Response {
    let symbols = query
        .symbols
        .split(',')
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .collect::<Vec<_>>();

    if symbols.is_empty() {
        return json_response(
            StatusCode::BAD_REQUEST,
            json!({ "error": "missing symbols query parameter" }),
        );
    }

    json_response(
        StatusCode::OK,
        state.market.get_quote_response(symbols).await,
    )
}

async fn fx_handler(State(state): State<AppState>) -> Response {
    json_response(StatusCode::OK, state.market.get_usd_cny_rate().await)
}

async fn search_handler(
    State(state): State<AppState>,
    Query(query): Query<SearchQuery>,
) -> Response {
    json_response(
        StatusCode::OK,
        state.market.search_symbols(query.keyword).await,
    )
}

fn json_response<T: serde::Serialize>(status: StatusCode, payload: T) -> Response {
    let mut response = (status, Json(payload)).into_response();
    response.headers_mut().insert(
        CONTENT_TYPE,
        HeaderValue::from_static("application/json; charset=utf-8"),
    );
    response
}
