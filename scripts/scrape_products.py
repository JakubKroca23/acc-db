#!/usr/bin/env python3
"""Scrape ALSAP + Trans-Technik (+ optional Hydrotruck) + Pavlínek into scraped_products.json.

Fixes vs first version:
- ALSAP pagination uses ?f=OFFSET (not strana=/page=)
- Prefer leaf categories from category-map.json (parent cats hide many products)
- Trans-Technik has BOTH product-types-card and product-types-table pages
- TT card prices are WITHOUT VAT (not with VAT)
- Discover TT leaf pages that contain products (cards or tables)
- Hydrotruck: ?str=PAGE pagination + insecure-SSL fallback; pad/holder reclassify
- ALSAP product pages that are a size/option group (JSON-LD hasVariant) become one row per option
- Pavlínek: /products.json dump + collection ID map; long 429 cooldown (prices ex VAT)
- Olejspol: Shopware listing HTML (?p= pagination); sequential + 429 backoff; EXEL datasheet map
"""
from __future__ import annotations

import html as htmlmod
import json
import os
import re
import time
import unicodedata
from collections import Counter
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from urllib.parse import urljoin, urlparse
from urllib.request import Request, urlopen

UA = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    )
}
ROOT = Path(__file__).resolve().parent
OUT = ROOT / "scraped_products.json"
MAP_PATH = ROOT / "category-map.json"
VAT = 1.21
SLEEP = 0.35  # polite delay between requests in a worker


def norm(s: str) -> str:
    s = htmlmod.unescape(s or "")
    s = unicodedata.normalize("NFKC", s).replace("\xa0", " ").replace("\u202f", " ")
    return re.sub(r"\s+", " ", s).strip()


def get(url: str, retries: int = 3, insecure: bool = False) -> str:
    """Fetch URL. For Hydrotruck SSL failures, callers may retry with insecure=True."""
    import ssl
    from urllib.error import HTTPError

    last: Exception | None = None
    for i in range(retries):
        try:
            req = Request(url, headers=UA)
            ctx = ssl._create_unverified_context() if insecure else None
            with urlopen(req, timeout=35, context=ctx) as r:
                data = r.read().decode("utf-8", "ignore")
            time.sleep(SLEEP)
            return data
        except HTTPError as e:
            last = e
            if e.code == 429:
                retry_after = e.headers.get("Retry-After") if e.headers else None
                try:
                    wait = float(retry_after) if retry_after else min(20.0, 4.0 * (2**i))
                except ValueError:
                    wait = min(20.0, 4.0 * (2**i))
                wait = min(wait, 20.0)  # never sit 60s×N on Shopify Retry-After
                emit_progress(f"HTTP 429 — čekám {wait:.0f}s ({url.split('?')[0].rstrip('/').split('/')[-1]})")
                time.sleep(wait)
                continue
            time.sleep(0.7 * (i + 1))
        except Exception as e:
            last = e
            time.sleep(0.7 * (i + 1))
    raise last  # type: ignore


def get_ht(url: str) -> str:
    try:
        return get(url)
    except Exception as e1:
        emit_progress(f"HT SSL/network fallback (insecure) for {url.split('/')[-1]}: {e1}")
        return get(url, insecure=True)


# Pavlínek / Shopify: storefront JSON is aggressively rate-limited.
# Short 6–18s retries make it worse — wait long, keep gap high, many attempts.
_pav_gap_s = 5.0
_pav_429_streak = 0
_PAV_HEADERS = {
    **UA,
    "Accept": "application/json,text/plain,*/*",
    "Accept-Language": "cs-CZ,cs;q=0.9,en;q=0.8",
    "Referer": "https://www.pavlinek.cz/",
}


def _pav_probe() -> tuple[bool, str]:
    """Single light request — True if Shopify accepts this IP right now."""
    from urllib.error import HTTPError

    url = "https://www.pavlinek.cz/products.json?limit=1&page=1"
    try:
        req = Request(url, headers=_PAV_HEADERS)
        with urlopen(req, timeout=25) as r:
            r.read(80)
        return True, "ok"
    except HTTPError as e:
        ra = e.headers.get("Retry-After") if e.headers else None
        return False, f"HTTP {e.code}" + (f" Retry-After={ra}" if ra else "")
    except Exception as e:
        return False, f"{type(e).__name__}: {e}"


def _pav_wait_for_access(max_wait_s: float = 1200.0) -> bool:
    """If IP is soft-banned (instant 429), sit until Shopify opens again."""
    global _pav_gap_s
    ok, detail = _pav_probe()
    if ok:
        emit_progress("Pavlínek: Shopify OK (IP není zablokovaná)")
        return True
    emit_progress(
        f"Pavlínek: Shopify teď odmítá ({detail}) — dočasný limit IP, "
        f"čekám až {max_wait_s / 60:.0f} min (neklikej Znovu)"
    )
    started = time.time()
    attempt = 0
    while time.time() - started < max_wait_s:
        attempt += 1
        wait = min(120.0, 30.0 + 15.0 * min(attempt, 6))
        emit_progress(f"Pavlínek cooldown {attempt}: pauza {wait:.0f}s…")
        time.sleep(wait)
        ok, detail = _pav_probe()
        if ok:
            _pav_gap_s = 6.0
            emit_progress("Pavlínek: přístup obnoven, pokračuju pomaleji (gap 6s)")
            return True
        emit_progress(f"Pavlínek: stále blok ({detail})")
    emit_progress("Pavlínek: timeout — IP pořád v limitu, zkus za 15–30 min")
    return False


def get_pav(url: str, retries: int = 12) -> str:
    """Shopify storefront JSON — polite gap + long 429 cooldown (not 3× quick fail)."""
    global _pav_gap_s, _pav_429_streak
    from urllib.error import HTTPError

    last: Exception | None = None
    for i in range(retries):
        time.sleep(_pav_gap_s)
        try:
            req = Request(url, headers=_PAV_HEADERS)
            with urlopen(req, timeout=45) as r:
                data = r.read().decode("utf-8", "ignore")
            _pav_429_streak = 0
            # Ease slowly after success — never below 4s.
            _pav_gap_s = max(4.0, _pav_gap_s * 0.98)
            return data
        except HTTPError as e:
            last = e
            if e.code == 429:
                _pav_429_streak += 1
                _pav_gap_s = min(12.0, max(6.0, _pav_gap_s + 1.5))
                retry_after = e.headers.get("Retry-After") if e.headers else None
                try:
                    ra = float(retry_after) if retry_after else 0.0
                except ValueError:
                    ra = 0.0
                # Shopify often sends Retry-After; otherwise escalate hard (45→90→120…).
                wait = max(ra, min(180.0, 45.0 * (1.6**min(i, 5))))
                emit_progress(
                    f"Pavlínek 429 #{_pav_429_streak} — čekám {wait:.0f}s "
                    f"(Retry-After={retry_after or '—'}, gap→{_pav_gap_s:.1f}s)"
                )
                time.sleep(wait)
                continue
            time.sleep(2.0 * (i + 1))
        except Exception as e:
            last = e
            time.sleep(2.0 * (i + 1))
    raise last  # type: ignore


def parse_price(s: str) -> float | None:
    s = norm(s).replace(" ", "")
    m = re.search(r"([0-9]+(?:[.,][0-9]+)?)", s)
    if not m:
        return None
    return float(m.group(1).replace(",", "."))


def dims_from_text(text: str) -> str | None:
    text = text or ""
    dm = re.findall(
        r"(\d+(?:[.,]\d+)?)\s*[x×]\s*(\d+(?:[.,]\d+)?)(?:\s*[x×]\s*(\d+(?:[.,]\d+)?))?\s*mm",
        text,
        re.I,
    )
    if dm:
        a, b, c = dm[0]
        return " × ".join(x for x in (a, b, c) if x) + " mm"
    m = re.search(r"od\s+(\d+)\s*(?:do|/|-)\s*(\d+)\s*mm", text, re.I)
    if m:
        return f"{m.group(1)}–{m.group(2)} mm"
    m = re.search(r"L\s*=\s*(\d+)\s*mm", text, re.I)
    if m:
        return f"L {m.group(1)} mm"
    m = re.search(r"pr\.?\s*(\d+(?:[.,]\d+)?)\s*mm", text, re.I)
    if m:
        return f"ø {m.group(1)} mm"
    m = re.search(r"(\d+)\s*[lL]\b", text)
    if m:
        return f"{m.group(1)} L"
    return None


def dims_from_params(params: str) -> str | None:
    params = norm(params)
    parts = []
    for label, key in [("Šířka", "Š"), ("Délka", "D"), ("Výška", "V"), ("Rozměr", "")]:
        m = re.search(rf"{label}:\s*([^|<]+)", params, re.I)
        if m:
            val = norm(m.group(1))
            parts.append(f"{key} {val}".strip() if key else val)
    if parts:
        return " · ".join(parts)[:120]
    return dims_from_text(params)


# ── image helpers ──────────────────────────────────────────────────

_PLACEHOLDER_RE = re.compile(r"(^data:|blank\.|spacer\.|placeholder|loading\.gif|1x1\.)", re.I)


def _first_srcset_url(srcset: str) -> str | None:
    for cand in (srcset or "").split(","):
        url = cand.strip().split(" ")[0].strip()
        if url and not _PLACEHOLDER_RE.search(url):
            return url
    return None


def pick_img(fragment: str, base: str) -> str | None:
    """Best thumbnail URL from an HTML fragment.

    Order: <picture><source srcset> (Hydrotruck's real file is often only the
    .webp there — the <img src> .jpg fallback 404s), lazy-load attributes
    (data-src, data-lazy-src, data-original, data-srcset), srcset, then src.
    Relative URLs are resolved against `base`.
    """
    cands: list[str] = []
    for m in re.finditer(r"<source\b[^>]*?\b(?:data-)?srcset=\"([^\"]+)\"", fragment, re.I):
        u = _first_srcset_url(m.group(1))
        if u:
            cands.append(u)
    img = re.search(r"<img\b[^>]*>", fragment, re.I)
    if img:
        tag = img.group(0)
        for attr in ("data-src", "data-lazy-src", "data-original", "data-lazy"):
            m = re.search(rf'\b{attr}="([^"]+)"', tag, re.I)
            if m and not _PLACEHOLDER_RE.search(m.group(1)):
                cands.append(m.group(1))
        for attr in ("data-srcset", "srcset"):
            m = re.search(rf'\b{attr}="([^"]+)"', tag, re.I)
            if m:
                u = _first_srcset_url(m.group(1))
                if u:
                    cands.append(u)
        m = re.search(r'\bsrc="([^"]+)"', tag, re.I)
        if m and not _PLACEHOLDER_RE.search(m.group(1)):
            cands.append(m.group(1))
    for u in cands:
        u = htmlmod.unescape(u.strip())
        if u.startswith("//"):
            u = "https:" + u
        return urljoin(base, u)
    return None


def _probe_image(url: str) -> bool:
    """True when URL answers 200 with image bytes (content type or magic bytes)."""
    import ssl
    from urllib.parse import quote

    safe = quote(url, safe=":/?&=%#+,;@!$'()*~")
    for insecure in (False, True):
        try:
            req = Request(safe, headers={**UA, "Range": "bytes=0-1023"})
            ctx = ssl._create_unverified_context() if insecure else None
            with urlopen(req, timeout=25, context=ctx) as r:
                ctype = (r.headers.get("Content-Type") or "").lower()
                head = r.read(16)
                # Trans-Technik's IIS sends images with no Content-Type at all → sniff magic bytes
                magic = head.startswith((b"\xff\xd8", b"\x89PNG", b"GIF8")) or head[8:12] == b"WEBP"
                return r.status in (200, 206) and (ctype.startswith("image/") or magic)
        except Exception as e:  # HTTPError 404 etc.
            code = getattr(e, "code", None)
            if code is not None:
                return False
            continue
    return False


def _og_image(page_url: str) -> str | None:
    try:
        html = get_ht(page_url) if "hydrotruck.cz" in page_url else get(page_url, retries=2)
    except Exception:
        return None
    m = re.search(r'<meta[^>]+property="og:image"[^>]+content="([^"]+)"', html) or re.search(
        r'<meta[^>]+content="([^"]+)"[^>]+property="og:image"', html
    )
    if m:
        return urljoin(page_url, htmlmod.unescape(m.group(1)))
    return pick_img(html, page_url)


def verify_images(items: list[dict]) -> None:
    """Check every imageUrl; repair dead ones (jpg→webp, product-page og:image)."""
    by_url: dict[str, bool] = {}
    urls = sorted({p["imageUrl"] for p in items if p.get("imageUrl")})
    with ThreadPoolExecutor(max_workers=8) as ex:
        for url, ok in zip(urls, ex.map(_probe_image, urls)):
            by_url[url] = ok
    dead = [u for u, ok in by_url.items() if not ok]
    emit_progress(f"IMG probe: {len(urls) - len(dead)}/{len(urls)} OK, {len(dead)} dead")

    def repair(p: dict) -> str | None:
        url = p.get("imageUrl")
        if url:
            alt = re.sub(r"\.(jpe?g|png)$", ".webp", url, flags=re.I)
            if alt != url and _probe_image(alt):
                return alt
        page = p.get("productUrl")
        if page and urlparse(page).path not in ("", "/"):
            og = _og_image(page)
            if og and _probe_image(og):
                return og
        return None

    todo = [p for p in items if (not p.get("imageUrl") or not by_url.get(p["imageUrl"], True))
            and p.get("productUrl") and urlparse(p["productUrl"]).path not in ("", "/")]
    fixed = 0
    with ThreadPoolExecutor(max_workers=6) as ex:
        for p, new in zip(todo, ex.map(repair, todo)):
            if new:
                p["imageUrl"] = new
                fixed += 1
            elif p.get("imageUrl") and not by_url.get(p["imageUrl"], True):
                p["imageUrl"] = None  # never ship a known-404 thumbnail
    emit_progress(f"IMG repair: fixed {fixed}/{len(todo)}")


def load_map() -> dict:
    return json.loads(MAP_PATH.read_text(encoding="utf-8"))


# ── ALSAP ──────────────────────────────────────────────────────────

def alsap_pages(url: str, max_pages: int = 20) -> list[str]:
    """ALSAP uses ?f=OFFSET pagination (28 products per page typically)."""
    urls = [url]
    try:
        html = get(url)
    except Exception:
        return urls
    offsets = sorted({int(x) for x in re.findall(r"[?&]f=(\d+)", html) if x.isdigit()})
    for off in offsets:
        if off <= 0:
            continue
        sep = "&" if "?" in url else "?"
        candidate = f"{url.rstrip('/')}{sep}f={off}" if "?" in url else f"{url.rstrip('/')}/?f={off}"
        # normalize: category URLs usually end with /
        if "?" not in url:
            candidate = f"{url.rstrip('/')}/?f={off}"
        if candidate not in urls:
            urls.append(candidate)
        if len(urls) >= max_pages:
            break
    # If pager mentions more pages but we only saw some offsets, also probe common steps
    if "ProductPaging" in html and len(offsets) >= 1:
        step = offsets[0] if offsets else 28
        # detect last page number from aria labels / spans
        page_nums = [int(x) for x in re.findall(r'aria-label="Stránka číslo (\d+)"', html)]
        page_nums += [int(x) for x in re.findall(r'class="page[^"]*"[^>]*>\s*<span>(\d+)</span>', html)]
        max_page = max(page_nums) if page_nums else (max(offsets) // max(step, 1) + 1)
        for i in range(1, min(max_page, max_pages)):
            candidate = f"{url.rstrip('/')}/?f={i * step}"
            if candidate not in urls:
                urls.append(candidate)
    return urls[:max_pages]


def parse_alsap_list(url: str, type_slug: str) -> list[dict]:
    html = get(url)
    out: list[dict] = []
    for ch in re.split(r'class="ProductView', html)[1:]:
        href_m = re.search(r'href="(/[^"?#]+-p\d+/?)(?:\?[^"]*)?"', ch)
        name_m = re.search(r"<h2>\s*<a[^>]*>\s*<span>(.*?)</span>", ch, re.S) or re.search(
            r'<img[^>]+(?:title|alt)="([^"]+)"', ch
        )
        img_m = re.search(r'data-src="(https://cdn\.alsap\.cz/[^"]+)"', ch) or re.search(
            r'src="(https://cdn\.alsap\.cz/[^"]+)"', ch
        )
        alsap_img = img_m.group(1) if img_m else pick_img(ch, "https://www.alsap.cz/")
        # JSON-LD sku sometimes embedded
        sku_m = re.search(r'"sku"\s*:\s*"([^"]+)"', ch)
        novat = re.search(r'novat[\s\S]{0,220}?class="value">([^<]+)<', ch)
        vat = re.search(r'class="[^"]*\bvat\b[^"]*"[\s\S]{0,140}?class="value">([^<]+)<', ch)
        if not href_m or not name_m:
            continue
        price = parse_price(novat.group(1)) if novat else None
        price_vat = parse_price(vat.group(1)) if vat else None
        if price is None and price_vat is None:
            continue
        if price is None and price_vat is not None:
            price = round(price_vat / VAT, 2)
        if price_vat is None and price is not None:
            price_vat = round(price * VAT, 2)
        name = norm(re.sub(r"<[^>]+>", "", name_m.group(1)))
        out.append(
            {
                "name": name[:220],
                "price": round(price, 2),  # type: ignore
                "priceVat": round(price_vat, 2),  # type: ignore
                "imageUrl": alsap_img,
                "productUrl": urljoin("https://www.alsap.cz", href_m.group(1)),
                "dimensions": dims_from_text(name),
                "supplier": "ALSAP",
                "typeSlug": type_slug,
                "unit": "L" if type_slug == "hydraulicky-olej" else "ks",
                "sku": norm(sku_m.group(1)) if sku_m else None,
            }
        )
    return out


# ── Trans-Technik ──────────────────────────────────────────────────

def tt_discover_leaves(root_url: str, type_slug: str, max_depth: int = 4) -> list[tuple[str, str]]:
    """BFS: find pages that contain product cards OR product tables."""
    seen: set[str] = set()
    queue: list[tuple[str, int]] = [(root_url, 0)]
    leaves: list[tuple[str, str]] = []
    root_path = urlparse(root_url).path.rstrip("/")

    while queue:
        url, depth = queue.pop(0)
        if url in seen or depth > max_depth:
            continue
        seen.add(url)
        try:
            html = get(url)
        except Exception:
            continue
        has_cards = 'class="product-types-card"' in html
        has_table = 'class="product-types-table"' in html
        if has_cards or has_table:
            leaves.append((type_slug, url))
        if depth < max_depth:
            for href in set(re.findall(r'href="(/[^"#?]+)"', html)):
                if not href.startswith("/dily-na-nastavby"):
                    continue
                # stay under root tree (prefix) OR same root slug segment
                if not (href.startswith(root_path) or root_path.split("/")[-1] in href):
                    continue
                full = urljoin("https://www.trans-technik.cz", href)
                if full in seen:
                    continue
                if any(x in full for x in ["/file/", "/kosik", ".pdf", ".jpg", "mailto:"]):
                    continue
                queue.append((full, depth + 1))
        if not has_cards and not has_table and depth == 0:
            # keep root for retry / empty
            leaves.append((type_slug, url))
    return leaves


def parse_tt_cards(html: str, type_slug: str, page_img: str | None) -> list[dict]:
    """Card listing: product-types-price is WITHOUT VAT."""
    out: list[dict] = []
    for part in re.split(r'class="product-types-card"', html)[1:]:
        href_m = re.search(r'href="(/[^"#?]+)"', part)
        name_m = re.search(r"<h3>(.*?)</h3>", part, re.S)
        sku_m = re.search(r'class="product-types-id">([^<]+)<', part)
        price_m = re.search(r'class="product-types-price">\s*([^<]+?)\s*<', part)
        params = " ".join(re.findall(r'class="params-row">\s*([^<]+?)\s*<', part))
        if not href_m or not name_m or not price_m:
            continue
        price = parse_price(price_m.group(1))
        if not price or price < 5:
            continue
        price_vat = round(price * VAT, 2)
        name = norm(re.sub(r"<[^>]+>", "", name_m.group(1)))
        img = pick_img(part, "https://www.trans-technik.cz/") or page_img
        dims = dims_from_params(params) or dims_from_text(name)
        out.append(
            {
                "name": name[:220],
                "price": round(price, 2),
                "priceVat": price_vat,
                "imageUrl": img,
                "productUrl": urljoin("https://www.trans-technik.cz", href_m.group(1)),
                "dimensions": dims,
                "supplier": "Trans-Technik",
                "typeSlug": type_slug,
                "unit": "ks",
                "sku": norm(sku_m.group(1)) if sku_m else None,
            }
        )
    return out


def parse_tt_table(html: str, type_slug: str, page_img: str | None) -> list[dict]:
    """Table listing with explicit bez DPH / s DPH columns."""
    out: list[dict] = []
    # Capture header labels for dimension columns
    thead = re.search(r"<thead>([\s\S]*?)</thead>", html)
    dim_labels: list[str] = []
    if thead:
        for td in re.findall(r"<td[^>]*>([\s\S]*?)</td>", thead.group(1)):
            lab = norm(re.sub(r"<[^>]+>", "", td))
            if lab and lab not in ("TT-číslo", "Název", "Dostupnost", "Cena bez DPH", "Cena s DPH", "Množství", "Jednotka"):
                if "Cena" not in lab and lab != "":
                    dim_labels.append(lab)

    body = re.search(r"<tbody>([\s\S]*?)</tbody>", html)
    if not body:
        return out
    for tr in re.findall(r"<tr>([\s\S]*?)</tr>", body.group(1)):
        sku_m = re.search(r'class="table-product"[^>]*>([^<]+)<', tr) or re.search(
            r'href="(/[^"#?]+)"[^>]*>([^<]+)<', tr
        )
        href_m = re.search(r'href="(/[^"#?]+)"', tr)
        name_m = re.search(r'class="itemName"[^>]*>\s*([\s\S]*?)\s*</td>', tr) or re.search(
            r'data-th="Název"[^>]*>\s*([\s\S]*?)\s*</td>', tr
        )
        price_ex = re.search(r'data-th="Cena bez DPH"[^>]*>\s*([^<]+)', tr)
        price_inc = re.search(r'data-th="Cena s DPH"[^>]*>\s*([^<]+)', tr)
        if not href_m or not name_m:
            continue
        price = parse_price(price_ex.group(1)) if price_ex else None
        price_vat = parse_price(price_inc.group(1)) if price_inc else None
        if price is None and price_vat is None:
            continue
        if price is None and price_vat is not None:
            price = round(price_vat / VAT, 2)
        if price_vat is None and price is not None:
            price_vat = round(price * VAT, 2)
        if price is None or price < 5:
            continue
        name = norm(re.sub(r"<[^>]+>", "", name_m.group(1)))
        # dimension cells with data-th like B (mm)
        dim_parts = []
        for lab, val in re.findall(r'data-th="([^"]+)"[^>]*>\s*([^<]*)', tr):
            if any(x in lab for x in ("mm", "kg", "B ", "L ", "S ", "H ", "Ø", "Rozměr")) or re.search(
                r"\b[BLSHV]\b", lab
            ):
                v = norm(val)
                if v and v not in ("-", "—"):
                    dim_parts.append(f"{lab.replace('(mm)', '').strip()} {v}".strip())
        dims = " · ".join(dim_parts[:4]) if dim_parts else dims_from_text(name)
        sku = None
        if sku_m:
            sku = norm(sku_m.group(1) if sku_m.lastindex == 1 else sku_m.group(sku_m.lastindex or 1))
            # if first group was href, use second
            if sku.startswith("/"):
                sku = norm(sku_m.group(2)) if sku_m.lastindex and sku_m.lastindex >= 2 else None
        out.append(
            {
                "name": name[:220],
                "price": round(price, 2),
                "priceVat": round(price_vat, 2),  # type: ignore
                "imageUrl": page_img,
                "productUrl": urljoin("https://www.trans-technik.cz", href_m.group(1)),
                "dimensions": dims[:120] if dims else None,
                "supplier": "Trans-Technik",
                "typeSlug": type_slug,
                "unit": "ks",
                "sku": sku,
            }
        )
    return out


def parse_tt_list(url: str, type_slug: str) -> list[dict]:
    html = get(url).replace("\xa0", " ")
    head_m = re.search(r'product-types-header-image[\s\S]{0,800}', html)
    page_img = pick_img(head_m.group(0), "https://www.trans-technik.cz/") if head_m else None
    items = parse_tt_cards(html, type_slug, page_img)
    items.extend(parse_tt_table(html, type_slug, page_img))
    return items


# ── Hydrotruck ─────────────────────────────────────────────────────

def ht_reclassify_slug(name: str, type_slug: str) -> str:
    """Pads vs boxes/cages for pads — mixed HT category pages can leak either way."""
    n = name.lower()
    if "držák podložek" in n or "drzak podlozek" in n or re.search(r"\bbox\s*\d+", n):
        return "klece-na-podkladaci-desky"
    if "podložka pod" in n or "podlozka pod" in n or "pod patky" in n:
        return "podkladaci-desky"
    return type_slug


def parse_ht_page(html: str, type_slug: str) -> list[dict]:
    out: list[dict] = []
    for part in re.split(r'class="product-card"', html)[1:]:
        href_m = re.search(r'href="(/[^"#?]+)"', part)
        name_m = re.search(r'class="product-name"[^>]*>([^<]+)<', part)
        type_m = re.search(r'class="type">([^<]*)<', part)
        prices = re.findall(
            r'class="price"[^>]*>\s*([0-9][0-9\s]*(?:,[0-9]+)?)\s*(?:&nbsp;|\xa0|\s)*Kč',
            part,
        )
        if not prices:
            prices = re.findall(r"([0-9][0-9\s]{2,12}(?:,[0-9]+)?)\s*(?:&nbsp;|\xa0)?\s*Kč", part)
        if not href_m or not name_m or not prices:
            continue
        nums = []
        for p in prices:
            v = parse_price(p)
            if v and 50 <= v <= 500000:
                nums.append(v)
        if not nums:
            continue
        price_vat = nums[0]
        price = nums[1] if len(nums) > 1 and nums[1] < price_vat else round(price_vat / VAT, 2)
        name = norm(name_m.group(1))
        typ = norm(type_m.group(1)) if type_m and type_m.group(1).strip() else ""
        full = f"{typ} {name}".strip() if typ and typ not in name else name
        img = pick_img(part, "https://www.hydrotruck.cz/")
        slug = ht_reclassify_slug(full, type_slug)
        out.append(
            {
                "name": full[:220],
                "price": round(price, 2),
                "priceVat": round(price_vat, 2),
                "imageUrl": img,
                "productUrl": urljoin("https://www.hydrotruck.cz", href_m.group(1)),
                "dimensions": dims_from_text(full),
                "supplier": "Hydrotruck",
                "typeSlug": slug,
                "unit": "ks",
                "sku": None,
            }
        )
    return out


def parse_ht_list(url: str, type_slug: str, max_pages: int = 12) -> list[dict]:
    """Hydrotruck uses ?str=PAGE pagination (1-based). SSL may fail — get_ht falls back."""
    out: list[dict] = []
    seen_urls: set[str] = set()
    for page in range(1, max_pages + 1):
        page_url = url if page == 1 else (url + ("&" if "?" in url else "?") + f"str={page}")
        try:
            html = get_ht(page_url)
        except Exception as e:
            emit_progress(f"HT ERR page {page} {type_slug}: {e}")
            break
        batch = parse_ht_page(html, type_slug)
        if page == 1 and not batch and ("Server Error 500" in html or "něco prasklo" in html):
            # Hydrotruck answers some category pages with an HTTP-200 error page
            raise RuntimeError(f"Hydrotruck error page for {url}")
        fresh = []
        for item in batch:
            pu = item.get("productUrl") or item["name"]
            if pu in seen_urls:
                continue
            seen_urls.add(pu)
            fresh.append(item)
        if not fresh and page > 1:
            break
        out.extend(fresh)
        if page == 1 and not batch:
            break
        # stop when page returned fewer than a full grid (HT shows ~12)
        if page > 1 and len(batch) < 12:
            break
    return out


def dedupe(items: list[dict]) -> list[dict]:
    seen: set[tuple] = set()
    out = []
    for p in items:
        key = (p["supplier"], p.get("productUrl") or p["name"])
        if key in seen:
            continue
        seen.add(key)
        out.append(p)
    return out


def emit_progress(msg: str) -> None:
    print(msg, flush=True)


def _alsap_ld_variants(html: str) -> list[dict]:
    """Size/option rows from schema.org ProductGroup.hasVariant. Price there includes VAT."""
    found: list[dict] = []
    for m in re.finditer(
        r"<script[^>]*type=['\"]application/ld\+json['\"][^>]*>(.*?)</script>",
        html,
        re.S | re.I,
    ):
        try:
            data = json.loads(m.group(1))
        except Exception:
            continue
        nodes = data if isinstance(data, list) else [data]
        for node in nodes:
            if not isinstance(node, dict):
                continue
            raw = node.get("hasVariant")
            if isinstance(raw, dict):
                raw = [raw]
            if isinstance(raw, list):
                found.extend(v for v in raw if isinstance(v, dict))
    return found


def _alsap_variant_row(parent: dict, variant: dict) -> dict | None:
    offers = variant.get("offers") or {}
    if isinstance(offers, list):
        offers = offers[0] if offers else {}
    if not isinstance(offers, dict):
        return None
    try:
        amount = float(str(offers.get("price")).replace(",", ".").replace(" ", ""))
    except (TypeError, ValueError):
        return None
    spec = offers.get("priceSpecification") or {}
    if isinstance(spec, list):
        spec = spec[0] if spec else {}
    vat_included = True
    if isinstance(spec, dict) and spec.get("valueAddedTaxIncluded") is False:
        vat_included = False
    if vat_included:
        price_vat = round(amount, 2)
        price = round(amount / VAT, 2)
    else:
        price = round(amount, 2)
        price_vat = round(amount * VAT, 2)
    name = norm(str(variant.get("name") or ""))
    if not name:
        return None
    image = variant.get("image")
    if isinstance(image, list):
        image = image[0] if image else None
    if isinstance(image, dict):
        image = image.get("url") or image.get("contentUrl")
    raw_url = str(variant.get("url") or "").strip()
    if raw_url and not raw_url.startswith("http"):
        raw_url = urljoin("https://www.alsap.cz", raw_url)
    sku = norm(str(variant.get("sku") or "")) or None
    unit = parent.get("unit") or "ks"
    unit_text = ""
    if isinstance(spec, dict):
        qty = spec.get("referenceQuantity") or {}
        if isinstance(qty, dict):
            unit_text = str(qty.get("unitText") or "")
    if unit_text.lower() in ("l", "litr", "litry"):
        unit = "L"
    return {
        "name": name[:220],
        "price": price,
        "priceVat": price_vat,
        "imageUrl": str(image).strip() if image else parent.get("imageUrl"),
        "productUrl": raw_url or parent.get("productUrl"),
        "dimensions": dims_from_text(name),
        "supplier": "ALSAP",
        "typeSlug": parent.get("typeSlug"),
        "unit": unit,
        "sku": sku,
    }


def _expand_one_alsap(parent: dict) -> list[dict]:
    url = parent.get("productUrl")
    if not url:
        return [parent]
    try:
        html = get(url)
    except Exception as e:
        emit_progress(f"ALSAP variant ERR {url[-48:]}: {e}")
        return [parent]
    variants = _alsap_ld_variants(html)
    if len(variants) < 2:
        return [parent]
    rows = [row for v in variants if (row := _alsap_variant_row(parent, v))]
    return rows or [parent]


# ── Pavlínek (Shopify JSON) ────────────────────────────────────────

PAVLINEK_BASE = "https://www.pavlinek.cz"
# First-mapped typeSlug wins when the same product appears in multiple collections.
_pav_seen_ids: set[int] = set()


def _pav_unit(type_slug: str) -> str:
    if type_slug == "metraz-lana-retezy":
        return "m"
    if type_slug == "hydraulicky-olej":
        return "L"
    return "ks"


def _pav_min_price(variants: list[dict]) -> float | None:
    prices: list[float] = []
    for v in variants or []:
        raw = v.get("price")
        if raw is None:
            continue
        try:
            prices.append(float(raw))
        except (TypeError, ValueError):
            continue
    return min(prices) if prices else None


def _pav_image(product: dict) -> str | None:
    images = product.get("images") or []
    if images and isinstance(images[0], dict):
        src = (images[0].get("src") or "").strip()
        if src.startswith("//"):
            src = "https:" + src
        return src or None
    return None


def _pav_product_row(product: dict, type_slug: str) -> dict | None:
    price = _pav_min_price(product.get("variants") or [])
    if price is None or price <= 0:
        return None
    handle_p = (product.get("handle") or "").strip()
    name = norm(product.get("title") or "")
    if not name or not handle_p:
        return None
    sku = None
    for v in product.get("variants") or []:
        if v.get("sku"):
            sku = str(v["sku"]).strip() or None
            break
    return {
        "name": name[:220],
        "price": round(price, 2),
        "priceVat": round(price * VAT, 2),
        "imageUrl": _pav_image(product),
        "productUrl": f"{PAVLINEK_BASE}/products/{handle_p}",
        "dimensions": dims_from_text(name),
        "supplier": "Pavlínek",
        "typeSlug": type_slug,
        "unit": _pav_unit(type_slug),
        "sku": sku,
    }


def _pav_load_all_products() -> dict[int, dict]:
    """Full catalog via /products.json (~6 pages) — fewer hits than 64 collections."""
    by_id: dict[int, dict] = {}
    page = 1
    while page <= 40:
        url = f"{PAVLINEK_BASE}/products.json?limit=250&page={page}"
        data = json.loads(get_pav(url))
        products = data.get("products") or []
        if not products:
            break
        for product in products:
            try:
                pid = int(product["id"])
            except (KeyError, TypeError, ValueError):
                continue
            by_id[pid] = product
        emit_progress(f"Pavlínek katalog: stránka {page}, celkem {len(by_id)} produktů")
        if len(products) < 250:
            break
        page += 1
    return by_id


def _pav_collection_ids(handle: str) -> list[int]:
    """Product IDs in a collection (paginated). Details come from the catalog dump."""
    ids: list[int] = []
    page = 1
    while page <= 40:
        url = f"{PAVLINEK_BASE}/collections/{handle}/products.json?limit=250&page={page}"
        data = json.loads(get_pav(url))
        products = data.get("products") or []
        if not products:
            break
        for product in products:
            try:
                ids.append(int(product["id"]))
            except (KeyError, TypeError, ValueError):
                continue
        if len(products) < 250:
            break
        page += 1
    return ids


def scrape_pavlinek(cmap: dict) -> tuple[list[dict], set[tuple[str, str]]]:
    """Dump /products.json once, then map collections → typeSlug (patient 429 backoff)."""
    global _pav_seen_ids, _pav_gap_s, _pav_429_streak
    _pav_seen_ids = set()
    _pav_gap_s = 5.0
    _pav_429_streak = 0
    entries = [
        e for e in (cmap.get("pavlinek") or []) if e.get("handle") and e.get("typeSlug")
    ]
    if not entries:
        return [], set()

    if not _pav_wait_for_access():
        return [], {("Pavlínek", e["typeSlug"]) for e in entries}

    emit_progress(
        f"Pavlínek: nejdřív celý katalog (/products.json), pak {len(entries)} kolekcí "
        f"(gap ~{_pav_gap_s:.0f}s, při 429 pauza až 2 min)"
    )
    try:
        catalog = _pav_load_all_products()
    except Exception as err:
        emit_progress(f"Pavlínek FAIL katalog: {err}")
        failed_slugs = {("Pavlínek", e["typeSlug"]) for e in entries}
        return [], failed_slugs

    if not catalog:
        emit_progress("Pavlínek: prázdný katalog")
        return [], {("Pavlínek", e["typeSlug"]) for e in entries}

    # First-mapped collection wins for overlapping products.
    id_to_slug: dict[int, str] = {}
    failed: set[tuple[str, str]] = set()
    for i, e in enumerate(entries, 1):
        slug, handle = e["typeSlug"], e["handle"]
        try:
            ids = _pav_collection_ids(handle)
            fresh = 0
            for pid in ids:
                if pid in _pav_seen_ids:
                    continue
                if pid not in catalog:
                    continue
                _pav_seen_ids.add(pid)
                id_to_slug[pid] = slug
                fresh += 1
            emit_progress(
                f"Pavlínek {i}/{len(entries)} {slug}: +{fresh} (kolekce {len(ids)})  {handle}"
            )
        except Exception as err:
            failed.add(("Pavlínek", slug))
            emit_progress(f"Pavlínek SKIP {slug}/{handle}: {err} (ponechám staré položky typu)")
            _pav_gap_s = min(12.0, _pav_gap_s + 2.0)
            time.sleep(30.0)

    all_rows: list[dict] = []
    for pid, slug in id_to_slug.items():
        row = _pav_product_row(catalog[pid], slug)
        if row:
            all_rows.append(row)
    emit_progress(f"Pavlínek hotovo: {len(all_rows)} položek, skip kolekcí/typů: {len(failed)}")
    return all_rows, failed


def expand_alsap_variants(items: list[dict]) -> list[dict]:
    """Replace ALSAP group cards (e.g. bedna „od 400 do 1000 mm“) with every option."""
    if os.environ.get("SKIP_ALSAP_VARIANTS") == "1":
        return items
    parents: list[dict] = []
    rest: list[dict] = []
    seen_urls: set[str] = set()
    for p in items:
        url = p.get("productUrl") or ""
        if p.get("supplier") == "ALSAP" and url.startswith("http"):
            if url in seen_urls:
                continue
            seen_urls.add(url)
            parents.append(p)
        else:
            rest.append(p)
    if not parents:
        return items
    emit_progress(f"ALSAP variants: {len(parents)} product pages")
    out: list[dict] = []
    done = 0
    split = 0
    with ThreadPoolExecutor(max_workers=6) as ex:
        futs = {ex.submit(_expand_one_alsap, p): p for p in parents}
        for fut in as_completed(futs):
            parent = futs[fut]
            done += 1
            try:
                rows = fut.result()
            except Exception as e:
                emit_progress(f"ALSAP variant ERR {parent.get('name', '')[:40]}: {e}")
                rows = [parent]
            if len(rows) > 1:
                split += 1
            out.extend(rows)
            if done % 25 == 0 or done == len(parents):
                emit_progress(f"ALSAP variants {done}/{len(parents)} · groups split {split} · rows {len(out)}")
    return rest + out


# ── Olejspol (Shopware) ────────────────────────────────────────────
OLEJSPOL_BASE = "https://olejspol.cz"
_olej_gap_s = 1.2
_olej_429_streak = 0
_OLEJ_HEADERS = {
    **UA,
    "Accept": "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "cs-CZ,cs;q=0.9,en;q=0.8",
    "Referer": f"{OLEJSPOL_BASE}/",
}


def get_olej(url: str, retries: int = 8) -> str:
    """Olejspol HTML — polite gap + long 429 cooldown (Pavlínek lesson)."""
    global _olej_gap_s, _olej_429_streak
    from urllib.error import HTTPError

    last: Exception | None = None
    for i in range(retries):
        time.sleep(_olej_gap_s)
        try:
            req = Request(url, headers=_OLEJ_HEADERS)
            with urlopen(req, timeout=45) as r:
                data = r.read().decode("utf-8", "ignore")
            _olej_429_streak = 0
            _olej_gap_s = max(1.0, _olej_gap_s * 0.98)
            return data
        except HTTPError as e:
            last = e
            if e.code == 429:
                _olej_429_streak += 1
                _olej_gap_s = min(8.0, max(2.0, _olej_gap_s + 1.0))
                retry_after = e.headers.get("Retry-After") if e.headers else None
                try:
                    ra = float(retry_after) if retry_after else 0.0
                except ValueError:
                    ra = 0.0
                wait = max(ra, min(120.0, 20.0 * (1.5 ** min(i, 5))))
                emit_progress(
                    f"Olejspol 429 #{_olej_429_streak} — čekám {wait:.0f}s "
                    f"(Retry-After={retry_after or '—'}, gap→{_olej_gap_s:.1f}s)"
                )
                time.sleep(wait)
                continue
            time.sleep(1.5 * (i + 1))
        except Exception as e:
            last = e
            time.sleep(1.5 * (i + 1))
    raise last  # type: ignore


def _olej_parse_czk(text: str) -> float | None:
    m = re.search(r"(\d[\d\s]*)([.,]\d{2})\s*Kč", text.replace("\xa0", " "))
    if not m:
        return None
    whole = m.group(1).replace(" ", "")
    frac = m.group(2).replace(",", ".")
    try:
        return float(whole + frac)
    except ValueError:
        return None


def _olej_load_datasheets() -> list[tuple[str, str]]:
    path = ROOT / "exel-datasheets.json"
    if not path.exists():
        return []
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return []
    items = [(norm(k).casefold(), v) for k, v in raw.items() if isinstance(v, str) and v.startswith("http")]
    items.sort(key=lambda kv: len(kv[0]), reverse=True)
    return items


def _olej_datasheet(name: str, brand: str | None, sheets: list[tuple[str, str]]) -> str | None:
    blob = f"{brand or ''} {name}".casefold()
    if "exel" not in blob:
        return None
    for key, url in sheets:
        if key in blob:
            return url
    return "https://www.exel.cz/produkty-exel/industry/hydraulicke-oleje/"


def _olej_parse_card(card: str, type_slug: str, sheets: list[tuple[str, str]]) -> dict | None:
    info_m = re.search(r'data-product-information="(\{[^"]+\})"', card)
    name = ""
    brand = None
    sku = None
    if info_m:
        try:
            info = json.loads(htmlmod.unescape(info_m.group(1)))
            name = norm(str(info.get("name") or ""))
            brand = norm(str(info.get("brand") or "")) or None
            sku = str(info.get("sku") or "").strip() or None
        except Exception:
            pass
    link_m = re.search(
        r'class="product-name[^"]*"[^>]*>\s*<a\s+href="(https://olejspol\.cz/[^"]+)"[^>]*title="([^"]*)"',
        card,
        re.I | re.S,
    ) or re.search(
        r'<a\s+href="(https://olejspol\.cz/[^"]+/\d+)"[^>]*class="product-name',
        card,
        re.I,
    ) or re.search(r'href="(https://olejspol\.cz/[a-z0-9\-]+/\d+)"', card, re.I)
    product_url = None
    if link_m:
        product_url = link_m.group(1).split("?")[0]
        if not name and link_m.lastindex and link_m.lastindex >= 2:
            name = norm(link_m.group(2))
    if not name:
        hn = re.search(r'class="product-name[^"]*"[^>]*>([^<]+)<', card, re.I)
        if hn:
            name = norm(hn.group(1))
    if not name or not product_url:
        return None

    price_ex = None
    # Nested spans inside price — match Kč near bez-DPH / s-DPH labels
    ex_m = re.search(
        r'product-price-without-vat[^>]*>[\s\S]{0,400}?(\d[\d\s]*[.,]\d{2})\s*Kč',
        card,
        re.I,
    )
    if ex_m:
        price_ex = _olej_parse_czk(ex_m.group(1) + " Kč")
    if price_ex is None:
        vat_m = re.search(
            r'product-price-with-vat[^>]*>[\s\S]{0,400}?(\d[\d\s]*[.,]\d{2})\s*Kč',
            card,
            re.I,
        )
        if vat_m:
            pv = _olej_parse_czk(vat_m.group(1) + " Kč")
            if pv is not None:
                price_ex = round(pv / VAT, 2)
    if price_ex is None or price_ex <= 0:
        return None

    img = pick_img(card, OLEJSPOL_BASE)
    # Listing „Od … Kč“ = cena nejlevnějšího balení (obvykle nejmenší litráž), ne Kč/L.
    pack_liters = _olej_pack_liters(card)
    if not pack_liters or pack_liters <= 0:
        return None
    price_per_l = price_ex / pack_liters
    dims = f"přepočet z {pack_liters:g} L balení ({price_ex:g} Kč)"
    note_parts = [brand] if brand else []
    note_parts.append(f"balení od {pack_liters:g} L")
    return {
        "name": name[:220],
        "price": round(price_per_l, 2),
        "priceVat": round(price_per_l * VAT, 2),
        "imageUrl": img,
        "productUrl": product_url,
        "dimensions": dims,
        "supplier": "Olejspol",
        "typeSlug": type_slug,
        "unit": "L",
        "sku": sku,
        "datasheetUrl": _olej_datasheet(name, brand, sheets),
        "note": " · ".join(note_parts) if note_parts else None,
        "packLiters": pack_liters,
        "packPrice": round(price_ex, 2),
    }


def _olej_pack_liters(card: str) -> float | None:
    """Litráž balení, ke kterému patří listing „Od“ cena (= min. nabízený objem)."""
    vols: list[float] = []
    # Volume switcher buttons: 5L, 20L, 60 L ( 3 x 20 L), 208L…
    for raw in re.findall(
        r'data-switch-link[^>]*>\s*([^<]+?)\s*<',
        card,
        re.I,
    ):
        label = norm(raw)
        m = re.match(r"^(\d+(?:[.,]\d+)?)\s*L\b", label, re.I)
        if m:
            try:
                vols.append(float(m.group(1).replace(",", ".")))
            except ValueError:
                pass
    if not vols:
        for m in re.finditer(r">(\d+(?:[.,]\d+)?)\s*L(?:\s*<|\s*\()", card, re.I):
            try:
                vols.append(float(m.group(1).replace(",", ".")))
            except ValueError:
                pass
    return min(vols) if vols else None


def parse_olejspol_list(url: str, type_slug: str, sheets: list[tuple[str, str]], max_pages: int = 12) -> list[dict]:
    out: list[dict] = []
    seen: set[str] = set()
    for page in range(1, max_pages + 1):
        page_url = url if page == 1 else (f"{url}?p={page}" if "?" not in url else f"{url}&p={page}")
        try:
            html = get_olej(page_url)
        except Exception as e:
            emit_progress(f"Olejspol ERR {type_slug} p={page}: {e}")
            break
        cards = re.split(r'<div class="card product-box\b', html)[1:]
        if not cards:
            if page == 1:
                emit_progress(f"Olejspol empty listing {type_slug}")
            break
        n_before = len(out)
        for raw in cards:
            card = '<div class="card product-box' + raw
            row = _olej_parse_card(card, type_slug, sheets)
            if not row:
                continue
            key = row["productUrl"]
            if key in seen:
                continue
            seen.add(key)
            out.append(row)
        emit_progress(f"Olejspol {type_slug} p={page}: +{len(out) - n_before} (Σ {len(out)})")
        if len(out) == n_before:
            break
        # stop if pagination has no higher page
        pages = [int(x) for x in re.findall(r"[?&]p=(\d+)", html)]
        if pages and page >= max(pages):
            break
    return out


def scrape_olejspol(cmap: dict) -> tuple[list[dict], set[tuple[str, str]]]:
    global _olej_gap_s, _olej_429_streak
    _olej_gap_s = 1.2
    _olej_429_streak = 0
    sheets = _olej_load_datasheets()
    entries = [e for e in (cmap.get("olejspol") or []) if e.get("url") and e.get("typeSlug")]
    emit_progress(f"Olejspol: {len(entries)} kategorií (gap ~{_olej_gap_s:.1f}s, 429 cooldown)")
    items: list[dict] = []
    failed: set[tuple[str, str]] = set()
    for i, e in enumerate(entries, 1):
        slug, url = e["typeSlug"], e["url"].rstrip("/")
        emit_progress(f"Olejspol [{i}/{len(entries)}] {slug} ← {url.split('/')[-1]}")
        try:
            rows = parse_olejspol_list(url, slug, sheets, max_pages=int(e.get("maxPages", 12)))
            items.extend(rows)
            if not rows:
                failed.add(("Olejspol", slug))
        except Exception as err:
            failed.add(("Olejspol", slug))
            emit_progress(f"Olejspol ERR {slug}: {err}")
            time.sleep(15.0)
    # dedupe by productUrl — first typeSlug wins
    by_url: dict[str, dict] = {}
    for p in items:
        u = p.get("productUrl") or ""
        if u and u not in by_url:
            by_url[u] = p
    return list(by_url.values()), failed


def scrape_enabled_suppliers() -> set[str]:
    """SCRAPE_SUPPLIERS=ALSAP,Pavlínek (comma) or SKIP_PAVLINEK=1 legacy. Empty = all."""
    all_sup = {"ALSAP", "Trans-Technik", "Hydrotruck", "Pavlínek", "Olejspol"}
    raw = (os.environ.get("SCRAPE_SUPPLIERS") or "").strip()
    if raw:
        aliases = {
            "alsap": "ALSAP",
            "tt": "Trans-Technik",
            "trans": "Trans-Technik",
            "trans-technik": "Trans-Technik",
            "transtechnik": "Trans-Technik",
            "ht": "Hydrotruck",
            "hydro": "Hydrotruck",
            "hydrotruck": "Hydrotruck",
            "pav": "Pavlínek",
            "pavlinek": "Pavlínek",
            "pavlínek": "Pavlínek",
            "olej": "Olejspol",
            "olejspol": "Olejspol",
        }
        out: set[str] = set()
        for part in raw.split(","):
            token = part.strip()
            if not token:
                continue
            key = token.casefold()
            if key in aliases:
                out.add(aliases[key])
            elif token in all_sup:
                out.add(token)
        return out or set(all_sup)
    if os.environ.get("SKIP_PAVLINEK") == "1":
        return all_sup - {"Pavlínek"}
    return set(all_sup)


def main() -> None:
    if os.environ.get("EXPAND_ALSAP_ONLY") == "1" and OUT.exists():
        items = json.loads(OUT.read_text(encoding="utf-8"))
        emit_progress(f"EXPAND_ALSAP_ONLY from {len(items)} products")
        final = [p for p in dedupe(expand_alsap_variants(items)) if p.get("typeSlug") != "zadni-zabrana"]
        OUT.write_text(json.dumps(final, ensure_ascii=False, indent=2), encoding="utf-8")
        emit_progress(f"TOTAL {len(final)} {dict(Counter(p['supplier'] for p in final))}")
        emit_progress(f"wrote {OUT}")
        return

    enabled = scrape_enabled_suppliers()
    emit_progress(f"Scrape dodavatelé: {', '.join(sorted(enabled))}")

    cmap = load_map()
    all_items: list[dict] = []
    failed: set[tuple[str, str]] = set()  # (supplier, typeSlug) with a failed source page

    # ALSAP
    if "ALSAP" in enabled:
        emit_progress("=== ALSAP ===")
        alsap_jobs: list[tuple[str, str]] = []
        for entry in cmap.get("alsap", []):
            slug, url = entry["typeSlug"], entry["url"]
            for page in alsap_pages(url, max_pages=15):
                alsap_jobs.append((slug, page))

        with ThreadPoolExecutor(max_workers=4) as ex:
            futs = {ex.submit(parse_alsap_list, u, s): (s, u) for s, u in alsap_jobs}
            for fut in as_completed(futs):
                s, u = futs[fut]
                try:
                    ps = fut.result()
                    emit_progress(f"ALSAP {s}: {len(ps)}  {u.split('/')[-2] if '/?f=' in u or u.endswith('/') else u[-40:]}")
                    all_items.extend(ps)
                except Exception as e:
                    failed.add(("ALSAP", s))
                    emit_progress(f"ALSAP ERR {s}: {e}")

        all_items = expand_alsap_variants(all_items)
    else:
        emit_progress("=== ALSAP přeskočen ===")

    # Trans-Technik
    if "Trans-Technik" in enabled:
        emit_progress("=== Trans-Technik ===")
        tt_pages: list[tuple[str, str]] = []
        for entry in cmap.get("transTechnik", []):
            slug, root = entry["typeSlug"], entry["url"]
            try:
                leaves = tt_discover_leaves(root, slug)
                emit_progress(f"TT discover {slug}: {len(leaves)} pages from {root.split('/')[-1]}")
                tt_pages.extend(leaves)
            except Exception as e:
                emit_progress(f"TT discover ERR {slug}: {e}")
                tt_pages.append((slug, root))

        seen_pages: set[str] = set()
        unique_tt: list[tuple[str, str]] = []
        for s, u in tt_pages:
            if u in seen_pages:
                continue
            seen_pages.add(u)
            unique_tt.append((s, u))

        with ThreadPoolExecutor(max_workers=4) as ex:
            futs = {ex.submit(parse_tt_list, u, s): (s, u) for s, u in unique_tt}
            for fut in as_completed(futs):
                s, u = futs[fut]
                try:
                    ps = fut.result()
                    if ps:
                        emit_progress(f"TT {s}: {len(ps)}  {u.split('/')[-1][:55]}")
                    all_items.extend(ps)
                except Exception as e:
                    failed.add(("Trans-Technik", s))
                    emit_progress(f"TT ERR {s}: {e}")
    else:
        emit_progress("=== Trans-Technik přeskočen ===")

    # Hydrotruck (optional, keep if reachable)
    if "Hydrotruck" in enabled:
        emit_progress("=== Hydrotruck ===")
        with ThreadPoolExecutor(max_workers=4) as ex:
            # maxPages (optional, per entry) caps huge listings — e.g. Hydrotruck pump
            # categories have ~20 pages each; we deliberately keep only the first page(s).
            futs = {
                ex.submit(parse_ht_list, e["url"], e["typeSlug"], int(e.get("maxPages", 12))): (e["typeSlug"], e["url"])
                for e in cmap.get("hydrotruck", [])
            }
            for fut in as_completed(futs):
                s, u = futs[fut]
                try:
                    ps = fut.result()
                    emit_progress(f"HT {s}: {len(ps)}  {u.split('/')[-1]}")
                    all_items.extend(ps)
                except Exception as e:
                    failed.add(("Hydrotruck", s))
                    emit_progress(f"HT ERR {s}: {e}")
    else:
        emit_progress("=== Hydrotruck přeskočen ===")

    # Pavlínek (Shopify JSON) — sequential + 429 backoff (store rate-limits bursts)
    if "Pavlínek" in enabled:
        emit_progress("=== Pavlínek ===")
        try:
            pav, pav_failed = scrape_pavlinek(cmap)
            all_items.extend(pav)
            failed |= pav_failed
            emit_progress(f"Pavlínek total unique: {len(pav)}" + (f" · failed types {len(pav_failed)}" if pav_failed else ""))
        except Exception as e:
            failed.add(("Pavlínek", "*"))
            emit_progress(f"Pavlínek ERR: {e}")
    else:
        emit_progress("=== Pavlínek přeskočen ===")

    # Olejspol (Shopware HTML) — sequential + 429 backoff
    if "Olejspol" in enabled:
        emit_progress("=== Olejspol ===")
        try:
            olej, olej_failed = scrape_olejspol(cmap)
            all_items.extend(olej)
            failed |= olej_failed
            emit_progress(
                f"Olejspol total unique: {len(olej)}"
                + (f" · failed types {len(olej_failed)}" if olej_failed else "")
            )
        except Exception as e:
            failed.add(("Olejspol", "*"))
            emit_progress(f"Olejspol ERR: {e}")
    else:
        emit_progress("=== Olejspol přeskočen ===")

    # Keep last scrape for suppliers we did not run this time (partial update).
    skipped = {"ALSAP", "Trans-Technik", "Hydrotruck", "Pavlínek", "Olejspol"} - enabled
    if skipped and OUT.exists():
        try:
            prev = json.loads(OUT.read_text(encoding="utf-8"))
        except Exception:
            prev = []
        kept = [p for p in prev if p.get("supplier") in skipped]
        all_items.extend(kept)
        emit_progress(f"ponecháno z minula: {len(kept)} položek ({', '.join(sorted(skipped))})")

    # Manual / estimate fillers (only when that supplier is being scraped)
    fillers: list[dict] = []
    if "Hydrotruck" in enabled:
        fillers.append(
            {
                "name": "Hydraulický olej HLP 46 (orientační)",
                "price": 78,
                "priceVat": 94,
                "imageUrl": None,
                "productUrl": "https://www.hydrotruck.cz/",
                "dimensions": None,
                "supplier": "Hydrotruck",
                "typeSlug": "hydraulicky-olej",
                "unit": "L",
                "sku": None,
            }
        )
    if "ALSAP" in enabled:
        fillers.append(
            {
                "name": "Hydraulický olej HM 46 (orientační)",
                "price": 72,
                "priceVat": 87,
                "imageUrl": None,
                "productUrl": "https://www.alsap.cz/hydraulika-c14/",
                "dimensions": None,
                "supplier": "ALSAP",
                "typeSlug": "hydraulicky-olej",
                "unit": "L",
                "sku": None,
            }
        )
    all_items.extend(fillers)
    # Fallback market estimates only when Hydrotruck pad scrape yielded nothing
    # (SSL/network issues from some hosts — run scrape from a network that can reach HT).
    if not any(p.get("typeSlug") == "podkladaci-desky" for p in all_items):
        emit_progress(
            "WARN: no podkladaci-desky from scrape — using market-estimate fallback "
            "(prefer Hydrotruck /podlozky-pod-patky-podper)"
        )
        all_items.extend(
            [
                {
                    "name": "Podkládací deska dřevěná 300×300 mm",
                    "price": 372,
                    "priceVat": 450,
                    "imageUrl": None,
                    "productUrl": None,
                    "dimensions": "300 × 300 mm",
                    "supplier": "tržní odhad",
                    "typeSlug": "podkladaci-desky",
                    "unit": "ks",
                    "sku": None,
                },
                {
                    "name": "Podkládací deska dřevěná 400×400 mm",
                    "price": 537,
                    "priceVat": 650,
                    "imageUrl": None,
                    "productUrl": None,
                    "dimensions": "400 × 400 mm",
                    "supplier": "tržní odhad",
                    "typeSlug": "podkladaci-desky",
                    "unit": "ks",
                    "sku": None,
                },
                {
                    "name": "Podkládací deska plastová 300×300 mm",
                    "price": 736,
                    "priceVat": 890,
                    "imageUrl": None,
                    "productUrl": None,
                    "dimensions": "300 × 300 mm",
                    "supplier": "tržní odhad",
                    "typeSlug": "podkladaci-desky",
                    "unit": "ks",
                    "sku": None,
                },
            ]
        )

    # Source page failed → keep last known-good products of that supplier+type
    # (otherwise the seed would delete them as stale).
    if failed and OUT.exists():
        try:
            prev = json.loads(OUT.read_text(encoding="utf-8"))
        except Exception:
            prev = []
        have = {(p["supplier"], p.get("productUrl") or p["name"]) for p in all_items}
        kept = [
            p for p in prev
            if (p["supplier"], p["typeSlug"]) in failed
            and (p["supplier"], p.get("productUrl") or p["name"]) not in have
            and not str(p.get("name", "")).endswith("(orientační)")
        ]
        all_items.extend(kept)
        emit_progress(f"carried over {len(kept)} previous products for failed sources {sorted(failed)}")

    final = [p for p in dedupe(all_items) if p["typeSlug"] != "zadni-zabrana"]
    if os.environ.get("SKIP_IMAGE_VERIFY") != "1":
        verify_images(final)
    OUT.write_text(json.dumps(final, ensure_ascii=False, indent=2), encoding="utf-8")
    emit_progress(f"TOTAL {len(final)} {dict(Counter(p['supplier'] for p in final))}")
    emit_progress(str(dict(Counter(p["typeSlug"] for p in final))))
    emit_progress(f"images {sum(1 for p in final if p.get('imageUrl'))}")
    emit_progress(f"wrote {OUT}")


if __name__ == "__main__":
    main()
