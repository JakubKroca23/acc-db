#!/usr/bin/env python3
"""Scrape ALSAP + Trans-Technik (+ optional Hydrotruck) into scraped_products.json.

Fixes vs first version:
- ALSAP pagination uses ?f=OFFSET (not strana=/page=)
- Prefer leaf categories from category-map.json (parent cats hide many products)
- Trans-Technik has BOTH product-types-card and product-types-table pages
- TT card prices are WITHOUT VAT (not with VAT)
- Discover TT leaf pages that contain products (cards or tables)
"""
from __future__ import annotations

import html as htmlmod
import json
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


def get(url: str, retries: int = 3) -> str:
    last: Exception | None = None
    for i in range(retries):
        try:
            req = Request(url, headers=UA)
            with urlopen(req, timeout=35) as r:
                data = r.read().decode("utf-8", "ignore")
            time.sleep(SLEEP)
            return data
        except Exception as e:
            last = e
            time.sleep(0.7 * (i + 1))
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
                "imageUrl": img_m.group(1) if img_m else None,
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
        img_m = re.search(r'<img[^>]+src="([^"]+)"', part)
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
        img = img_m.group(1) if img_m else page_img
        if img and not img.startswith("http"):
            img = urljoin("https://www.trans-technik.cz", img)
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
    img_m = re.search(r'product-types-header-image[\s\S]{0,500}?src="([^"]+)"', html)
    page_img = img_m.group(1) if img_m else None
    if page_img and not page_img.startswith("http"):
        page_img = urljoin("https://www.trans-technik.cz", page_img)
    items = parse_tt_cards(html, type_slug, page_img)
    items.extend(parse_tt_table(html, type_slug, page_img))
    return items


# ── Hydrotruck ─────────────────────────────────────────────────────

def parse_ht_list(url: str, type_slug: str) -> list[dict]:
    html = get(url)
    out: list[dict] = []
    for part in re.split(r'class="product-card"', html)[1:]:
        href_m = re.search(r'href="(/[^"#?]+)"', part)
        img_m = re.search(r'<img[^>]+src="([^"]+)"', part)
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
        img = img_m.group(1) if img_m else None
        if img and not img.startswith("http"):
            img = urljoin("https://www.hydrotruck.cz", img)
        out.append(
            {
                "name": full[:220],
                "price": round(price, 2),
                "priceVat": round(price_vat, 2),
                "imageUrl": img,
                "productUrl": urljoin("https://www.hydrotruck.cz", href_m.group(1)),
                "dimensions": dims_from_text(full),
                "supplier": "Hydrotruck",
                "typeSlug": type_slug,
                "unit": "ks",
                "sku": None,
            }
        )
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
                emit_progress(f"TT ERR {s}: {e}")

    # Hydrotruck (optional, keep if reachable)
    emit_progress("=== Hydrotruck ===")
    with ThreadPoolExecutor(max_workers=4) as ex:
        futs = {
            ex.submit(parse_ht_list, e["url"], e["typeSlug"]): (e["typeSlug"], e["url"])
            for e in cmap.get("hydrotruck", [])
        }
        for fut in as_completed(futs):
            s, u = futs[fut]
            try:
                ps = fut.result()
                emit_progress(f"HT {s}: {len(ps)}  {u.split('/')[-1]}")
                all_items.extend(ps)
            except Exception as e:
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

    final = [p for p in dedupe(all_items) if p["typeSlug"] != "zadni-zabrana"]
    OUT.write_text(json.dumps(final, ensure_ascii=False, indent=2), encoding="utf-8")
    emit_progress(f"TOTAL {len(final)} {dict(Counter(p['supplier'] for p in final))}")
    emit_progress(str(dict(Counter(p["typeSlug"] for p in final))))
    emit_progress(f"images {sum(1 for p in final if p.get('imageUrl'))}")
    emit_progress(f"wrote {OUT}")


if __name__ == "__main__":
    main()
