let tauriInvokePromise;

async function getTauriInvoke() {
  if (!window.__TAURI_INTERNALS__) return null;
  tauriInvokePromise ||= import("@tauri-apps/api/core").then((module) => module.invoke);
  return tauriInvokePromise;
}

export async function loadQuotes(symbols) {
  const invoke = await getTauriInvoke();
  if (invoke) {
    return invoke("get_quotes", { symbols });
  }

  const response = await fetch(`/api/quotes?symbols=${encodeURIComponent(symbols.join(","))}`);
  if (!response.ok) throw new Error(`行情 API 返回 ${response.status}`);
  return response.json();
}

export async function loadFx() {
  const invoke = await getTauriInvoke();
  if (invoke) {
    return invoke("get_fx");
  }

  const response = await fetch("/api/fx");
  if (!response.ok) throw new Error(`汇率 API 返回 ${response.status}`);
  return response.json();
}

export async function searchSymbols(keyword) {
  const trimmed = keyword.trim();
  if (trimmed.length < 2) return [];

  const invoke = await getTauriInvoke();
  if (invoke) {
    return invoke("search_symbols", { keyword: trimmed });
  }

  const response = await fetch(`/api/search?keyword=${encodeURIComponent(trimmed)}`);
  if (!response.ok) throw new Error(`搜索 API 返回 ${response.status}`);
  return response.json();
}
