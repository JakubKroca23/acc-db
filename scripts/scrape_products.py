#!/usr/bin/env python3
"""Scrape ALSAP + Trans-Technik (+ optional Hydrotruck) into scraped_products.json.

Fixes vs first version:
- ALSAP pagination uses ?f=OFFSET (not strana=/page=)
- Prefer leaf categories from category-map.json (parent cats hide many products)
- Trans-Technik has BOTH product-types-card and product-types-table pages
- TT card prices are WITHOUT VAT (not with VAT)
- Discover TT leaf pages that contain products (cards or tables)
- Hydrotruck: ?str=PAGE pagination + insecure-SSL fallback; pad/holder reclassify
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
    last: Exception | None = None
    for i in range(retries):
        try:
            req = Request(url, headers=UA)
            ctx = ssl._create_unverified_context() if insecure else None
            with urlopen(req, timeout=35, context=ctx) as r:
                data = r.read().decode("utf-8", "ignore")
            time.sleep(SLEEP)
            return data
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


def main() -> None:
    cmap = load_map()
    all_items: list[dict] = []
    failed: set[tuple[str, str]] = set()  # (supplier, typeSlug) with a failed source page

    # ALSAP
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

    # Trans-Technik
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

    # Hydrotruck (optional, keep if reachable)
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

    # Manual / estimate fillers
    all_items.extend(
        [
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
            },
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
            },
        ]
    )
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
