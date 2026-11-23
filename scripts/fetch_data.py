import json
import re
import sys
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
USER_AGENT = "Mozilla/5.0 (compatible; asia-strategy-desk/1.0)"
TIMEOUT_SECONDS = 20
NEWS_WINDOW_HOURS = 60
MAX_ITEMS_PER_THEME = 12

MARKET_GROUPS = [
    {
        "name": "Asia equities",
        "items": [
            {"symbol": "^N225", "label": "Nikkei 225", "country": "Japan"},
            {"symbol": "^KS11", "label": "KOSPI", "country": "Korea"},
            {"symbol": "^TWII", "label": "TAIEX", "country": "Taiwan"},
            {"symbol": "^HSI", "label": "Hang Seng", "country": "Hong Kong"},
            {"symbol": "^HSCE", "label": "HSCEI", "country": "China"},
            {"symbol": "510300.SS", "label": "CSI 300 (ETF)", "country": "China", "proxy": True},
            {"symbol": "^NSEI", "label": "Nifty 50", "country": "India"},
            {"symbol": "^STI", "label": "STI", "country": "Singapore"},
            {"symbol": "^AXJO", "label": "ASX 200", "country": "Australia"},
            {"symbol": "^JKSE", "label": "Jakarta Comp", "country": "Indonesia"},
        ],
    },
    {
        "name": "US and risk",
        "items": [
            {"symbol": "^GSPC", "label": "S&P 500"},
            {"symbol": "^IXIC", "label": "Nasdaq"},
            {"symbol": "^SOX", "label": "SOX (semis)"},
            {"symbol": "^VIX", "label": "VIX"},
        ],
    },
    {
        "name": "Rates, FX, commodities",
        "items": [
            {"symbol": "^TNX", "label": "US 10Y yield", "kind": "yield"},
            {"symbol": "DX-Y.NYB", "label": "DXY"},
            {"symbol": "JPY=X", "label": "USD/JPY"},
            {"symbol": "CNY=X", "label": "USD/CNY"},
            {"symbol": "KRW=X", "label": "USD/KRW"},
            {"symbol": "IDR=X", "label": "USD/IDR"},
            {"symbol": "BZ=F", "label": "Brent"},
            {"symbol": "GC=F", "label": "Gold"},
            {"symbol": "HG=F", "label": "Copper"},
        ],
    },
    {
        "name": "House names",
        "items": [
            {"symbol": "000660.KS", "label": "SK hynix", "country": "Korea"},
            {"symbol": "005930.KS", "label": "Samsung", "country": "Korea"},
            {"symbol": "2330.TW", "label": "TSMC", "country": "Taiwan"},
            {"symbol": "NVDA", "label": "Nvidia"},
            {"symbol": "9988.HK", "label": "Alibaba HK", "country": "China"},
            {"symbol": "0700.HK", "label": "Tencent", "country": "China"},
            {"symbol": "1519.HK", "label": "J&T Global", "country": "China"},
            {"symbol": "GRAB", "label": "Grab", "country": "Singapore"},
        ],
    },
]

GOOGLE_NEWS = "https://news.google.com/rss/search?q={query}+when:2d&hl=en-SG&gl=SG&ceid=SG:en"

NEWS_FEEDS = [
    {"theme": "Korea", "url": GOOGLE_NEWS.format(query=urllib.parse.quote("KOSPI OR Korean stocks OR Bank of Korea"))},
    {"theme": "Japan", "url": GOOGLE_NEWS.format(query=urllib.parse.quote("Nikkei OR TOPIX OR Bank of Japan OR yen"))},
    {"theme": "China / HK", "url": GOOGLE_NEWS.format(query=urllib.parse.quote("China stocks OR Hang Seng OR CSI 300 OR PBOC"))},
    {"theme": "Taiwan", "url": GOOGLE_NEWS.format(query=urllib.parse.quote("TAIEX OR TSMC OR Taiwan stocks"))},
    {"theme": "India", "url": GOOGLE_NEWS.format(query=urllib.parse.quote("Nifty OR Sensex OR RBI OR Indian equities"))},
    {"theme": "ASEAN / Aus", "url": GOOGLE_NEWS.format(query=urllib.parse.quote("Singapore stocks OR Indonesia rupiah OR Thailand stocks OR ASX OR RBA"))},
    {"theme": "AI capex", "url": GOOGLE_NEWS.format(query=urllib.parse.quote("Nvidia OR hyperscaler capex OR AI chips OR HBM memory"))},
    {"theme": "Macro", "url": GOOGLE_NEWS.format(query=urllib.parse.quote("Federal Reserve OR Treasury yields OR dollar index OR inflation"))},
    {"theme": "Oil / Cmdty", "url": GOOGLE_NEWS.format(query=urllib.parse.quote("Brent crude OR OPEC OR copper price OR gold price"))},
    {"theme": "Flows", "url": GOOGLE_NEWS.format(query=urllib.parse.quote("foreign investors Asian equities outflows OR inflows OR hedge funds positioning"))},
    {"theme": "Strategy", "url": GOOGLE_NEWS.format(query=urllib.parse.quote("equity strategist Asia outlook OR Morgan Stanley Asia strategy OR Goldman Asia equities"))},
]

COUNTRY_KEYWORDS = {
    "Japan": ["japan", "nikkei", "topix", "boj", "bank of japan", "yen", "takaichi", "tokyo"],
    "Korea": ["korea", "kospi", "samsung", "sk hynix", "hynix", "seoul", "won "],
    "Taiwan": ["taiwan", "taiex", "tsmc", "taipei"],
    "China": ["china", "chinese", "csi 300", "pboc", "yuan", "alibaba", "tencent", "baidu", "jd.com", "pdd", "xiaomi", "beijing"],
    "Hong Kong": ["hong kong", "hang seng", "hkex", "hsi "],
    "India": ["india", "nifty", "sensex", "rbi", "rupee", "mumbai"],
    "Singapore": ["singapore", "sgx", "grab", "straits times"],
    "Thailand": ["thailand", "thai ", "bangkok"],
    "Indonesia": ["indonesia", "rupiah", "jakarta", "bank indonesia"],
    "Australia": ["australia", "asx", "rba", "aussie"],
    "Malaysia": ["malaysia", "ringgit", "bursa"],
    "Philippines": ["philippines", "peso", "manila"],
    "Brazil": ["brazil", "bovespa", "petrobras"],
    "Mexico": ["mexico", "mexican", "peso mexic"],
}


def http_get(url):
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    last_error = None
    for _ in range(2):
        try:
            with urllib.request.urlopen(request, timeout=TIMEOUT_SECONDS) as response:
                return response.read()
        except (urllib.error.URLError, TimeoutError, ConnectionError) as exc:
            last_error = exc
    raise last_error


def percent_change(current, base):
    if base in (None, 0) or current is None:
        return None
    return round((current / base - 1) * 100, 2)


def closes_with_years(result):
    timestamps = result.get("timestamp") or []
    closes = result["indicators"]["quote"][0]["close"]
    return [
        (datetime.fromtimestamp(ts, tz=timezone.utc), close)
        for ts, close in zip(timestamps, closes)
        if close is not None
    ]


def build_quote(item, result):
    series = closes_with_years(result)
    if len(series) < 2:
        raise ValueError("not enough price history")
    current_year = series[-1][0].year
    last_date, last_close = series[-1]
    prev_close = series[-2][1]
    prior_year_closes = [close for date, close in series if date.year < current_year]
    ytd_base = prior_year_closes[-1] if prior_year_closes else series[0][1]
    return {
        **item,
        "price": round(last_close, 4),
        "prev": round(prev_close, 4),
        "change_pct": percent_change(last_close, prev_close),
        "ytd_pct": percent_change(last_close, ytd_base),
        "as_of": last_date.date().isoformat(),
        "spark": [round(close, 4) for _, close in series[-30:]],
    }


def fetch_quote(item):
    symbol = urllib.parse.quote(item["symbol"])
    url = f"https://query1.finance.yahoo.com/v8/finance/chart/{symbol}?range=1y&interval=1d"
    try:
        payload = json.loads(http_get(url))
        return build_quote(item, payload["chart"]["result"][0])
    except (urllib.error.URLError, TimeoutError, ConnectionError, ValueError, KeyError, IndexError, TypeError) as exc:
        return {**item, "error": str(exc)}


def build_market():
    flat = [item for group in MARKET_GROUPS for item in group["items"]]
    with ThreadPoolExecutor(max_workers=6) as pool:
        quotes = list(pool.map(fetch_quote, flat))
    by_symbol = {quote["symbol"]: quote for quote in quotes}
    groups = [
        {"name": group["name"], "items": [by_symbol[item["symbol"]] for item in group["items"]]}
        for group in MARKET_GROUPS
    ]
    good = sum(1 for quote in quotes if "error" not in quote)
    return {"updated": now_iso(), "groups": groups}, good


def now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def strip_source_suffix(title, source):
    suffix = f" - {source}"
    if source and title.endswith(suffix):
        return title[: -len(suffix)]
    return title


def normalise_title(title):
    return re.sub(r"[^a-z0-9]+", " ", title.lower()).strip()


def tag_countries(title):
    lowered = f" {title.lower()} "
    return [
        country
        for country, words in COUNTRY_KEYWORDS.items()
        if any(word in lowered for word in words)
    ]


def parse_item(node, theme, cutoff):
    title = (node.findtext("title") or "").strip()
    link = (node.findtext("link") or "").strip()
    source = (node.findtext("source") or "").strip()
    published_text = node.findtext("pubDate")
    if not title or not link or not published_text:
        return None
    published = parsedate_to_datetime(published_text)
    if published.tzinfo is None:
        published = published.replace(tzinfo=timezone.utc)
    if published < cutoff:
        return None
    clean_title = strip_source_suffix(title, source)
    return {
        "title": clean_title,
        "link": link,
        "source": source or "News",
        "published": published.astimezone(timezone.utc).isoformat(timespec="seconds"),
        "theme": theme,
        "tags": tag_countries(clean_title),
    }


def fetch_feed(feed):
    cutoff = datetime.now(timezone.utc) - timedelta(hours=NEWS_WINDOW_HOURS)
    try:
        root = ET.fromstring(http_get(feed["url"]))
    except (urllib.error.URLError, TimeoutError, ConnectionError, ET.ParseError):
        return []
    items = [parse_item(node, feed["theme"], cutoff) for node in root.iter("item")]
    kept = [item for item in items if item]
    kept.sort(key=lambda item: item["published"], reverse=True)
    return kept[:MAX_ITEMS_PER_THEME]


def build_news():
    with ThreadPoolExecutor(max_workers=6) as pool:
        batches = list(pool.map(fetch_feed, NEWS_FEEDS))
    seen = set()
    items = []
    for batch in batches:
        for item in batch:
            key = normalise_title(item["title"])
            if key in seen:
                continue
            seen.add(key)
            items.append(item)
    items.sort(key=lambda item: item["published"], reverse=True)
    return {"updated": now_iso(), "items": items}


def write_json(name, payload):
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    target = DATA_DIR / name
    temporary = target.with_suffix(".tmp")
    temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=1), encoding="utf-8")
    temporary.replace(target)


def main():
    market, good_quotes = build_market()
    news = build_news()
    failures = []
    if good_quotes:
        write_json("market.json", market)
    else:
        failures.append("market: no quotes returned")
    if news["items"]:
        write_json("news.json", news)
    else:
        failures.append("news: no items returned")
    if failures:
        sys.exit("; ".join(failures))


if __name__ == "__main__":
    main()
