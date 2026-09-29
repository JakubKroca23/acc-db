#!/usr/bin/env python3
"""Thorough product scrape: ALSAP, Trans-Technik, Hydrotruck → scraped_products.json"""
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

UA = {"User-Agent": "Mozilla/5.0 (compatible; acc-db-scraper/1.0)"}
OUT = Path(__file__).with_name("scraped_products.json")


def norm(s: str) -> str:
    s = htmlmod.unescape(s or "")
    s = unicodedata.normalize("NFKC", s).replace("\xa0", " ").replace("\u202f", " ")
    return re.sub(r"\s+", " ", s).strip()


def get(url: str, retries: int = 3) -> str:
    last = None
    for i in range(retries):
        try:
            req = Request(url, headers=UA)
            with urlopen(req, timeout=30) as r:
                return r.read().decode("utf-8", "ignore")
        except Exception as e:
            last = e
            time.sleep(0.6 * (i + 1))
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
    m = re.search(r"Rozměr:\s*([^|<]+)", params, re.I)
    if m:
        return dims_from_text(m.group(1)) or norm(m.group(1))[:80]
    return dims_from_text(params)


# ── ALSAP ──────────────────────────────────────────────────────────

ALSAP_CATS = [
    ("blatniky", "https://www.alsap.cz/plastove-blatniky-pro-nakladni-a-uzitkova-vozidla-c942/"),
    ("blatniky", "https://www.alsap.cz/plechove-blatniky-pro-nakladni-a-uzitkova-vozidla-c943/"),
    ("blatniky", "https://www.alsap.cz/blatniky-c10/"),
    ("zasterky-do-blatniku", "https://www.alsap.cz/zasterky-c76/"),
    ("zasterky-do-blatniku", "https://www.alsap.cz/zasterky-gumove-c950/"),
    ("zasterky-do-blatniku", "https://www.alsap.cz/zasterky-antispray-c949/"),
    ("drzaky-blatniku", "https://www.alsap.cz/drzaky-blatniku-c29/"),
    ("drzaky-blatniku", "https://www.alsap.cz/drzak-blatniku-c940/"),
    ("drzaky-blatniku", "https://www.alsap.cz/konzole-blatniku-c941/"),
    ("box-na-naradi", "https://www.alsap.cz/bedny-na-naradi-c34/"),
    ("majak", "https://www.alsap.cz/led-majaky-c934/"),
    ("nadoba-na-vodu", "https://www.alsap.cz/kanystry-na-vodu-c234/"),
    ("drzak-rezervy", "https://www.alsap.cz/drzak-rezervy-standart-c948/"),
    ("drzak-rezervy", "https://www.alsap.cz/drzaky-rezervy-c77/"),
    ("hasici-pristroj", "https://www.alsap.cz/bedny-na-hasici-pristroj-c235/"),
    ("bocni-zabrany", "https://www.alsap.cz/bocni-zabrana-proti-podjeti-c5/"),
    ("pracovni-svetla", "https://www.alsap.cz/led-pracovni-osvetleni-c134/"),
    ("kamery", "https://www.alsap.cz/parkovaci-kamery-c1228/"),
    ("cerpadlo", "https://www.alsap.cz/hydraulicka-cerpadla-spx-c598/"),
    ("cerpadlo", "https://www.alsap.cz/hydraulicka-cerpadla-binotto-c1332/"),
    ("uzivatelska-zasuvka", "https://www.alsap.cz/zasuvky-zastrcky-a-konektory-c520/"),
    ("navarovaci-oko", "https://www.alsap.cz/oka-upevnovaci-c31/"),
    ("vazaci-prostredky", "https://www.alsap.cz/upinaci-popruhy-c1320/"),
    ("klece-na-podkladaci-desky", "https://www.alsap.cz/kose-na-palety-c604/"),
]


def alsap_pages(url: str, max_pages: int = 8) -> list[str]:
    """Return category URLs including pagination variants."""
    urls = [url]
    try:
        html = get(url)
    except Exception:
        return urls
    # page links like ?strana=2 or /strana-2/
    pages = set(re.findall(r'href="([^"]*(?:strana[=-](\d+)|page[=-](\d+))[^"]*)"', html, re.I))
    for href, a, b in pages:
        n = int(a or b or 0)
        if 2 <= n <= max_pages:
            full = urljoin(url, href)
            if full not in urls:
                urls.append(full)
    # also try common query patterns if pager present
    if "strana" in html.lower() or "pagination" in html.lower() or "pager" in html.lower():
        base = url.rstrip("/")
        for n in range(2, max_pages + 1):
            for candidate in (f"{base}/?strana={n}", f"{url}?strana={n}", f"{base}?page={n}"):
                if candidate not in urls:
                    urls.append(candidate)
    return urls[:max_pages]


def parse_alsap_list(url: str, type_slug: str, limit: int = 60) -> list[dict]:
    html = get(url)
    out = []
    for ch in re.split(r'class="ProductView', html)[1:]:
        href_m = re.search(r'href="(/[^"?#]+-p\d+/?)(?:\?[^"]*)?"', ch)
        name_m = re.search(r"<h2>\s*<a[^>]*>\s*<span>(.*?)</span>", ch, re.S) or re.search(
            r'<img[^>]+(?:title|alt)="([^"]+)"', ch
        )
        img_m = re.search(r'data-src="(https://cdn\.alsap\.cz/[^"]+)"', ch)
        novat = re.search(r'novat[\s\S]{0,220}?class="value">([^<]+)<', ch)
        vat = re.search(r'class="[^"]*\bvat\b[^"]*"[\s\S]{0,140}?class="value">([^<]+)<', ch)
        if not href_m or not name_m:
            continue
        price = parse_price(novat.group(1)) if novat else None
        price_vat = parse_price(vat.group(1)) if vat else None
        if price is None and price_vat is None:
            continue
        if price is None:
            price = round(price_vat / 1.21, 2)  # type: ignore
        if price_vat is None:
            price_vat = round(price * 1.21, 2)
        name = norm(re.sub(r"<[^>]+>", "", name_m.group(1)))
        out.append(
            {
                "name": name[:220],
                "price": round(price, 2),
                "priceVat": round(price_vat, 2),
                "imageUrl": img_m.group(1) if img_m else None,
                "productUrl": urljoin("https://www.alsap.cz", href_m.group(1)),
                "dimensions": dims_from_text(name),
                "supplier": "ALSAP",
                "typeSlug": type_slug,
                "unit": "L" if type_slug == "hydraulicky-olej" else "ks",
                "sku": None,
            }
        )
        if len(out) >= limit:
            break
    return out


# ── Trans-Technik ──────────────────────────────────────────────────

TT_ROOTS = [
    ("blatniky", "https://www.trans-technik.cz/dily-na-nastavby-02-blatniky-a-prislusenstvi-blatniky"),
    ("zasterky-do-blatniku", "https://www.trans-technik.cz/dily-na-nastavby-02-blatniky-a-prislusenstvi-zasterky"),
    ("drzaky-blatniku", "https://www.trans-technik.cz/dily-na-nastavby-02-blatniky-a-prislusenstvi-drzaky-blatniku"),
    ("box-na-naradi", "https://www.trans-technik.cz/dily-na-nastavby-02-blatniky-a-prislusenstvi-schrany-na-naradi"),
    ("hasici-pristroj", "https://www.trans-technik.cz/dily-na-nastavby-02-blatniky-a-prislusenstvi-schrany-na-hasici-pristroje"),
    ("nadoba-na-vodu", "https://www.trans-technik.cz/dily-na-nastavby-02-blatniky-a-prislusenstvi-nadrze-na-vodu"),
    ("olejova-nadrz", "https://www.trans-technik.cz/dily-na-nastavby-07-sklapecove-nastavby-nadrze"),
    ("cerpadlo", "https://www.trans-technik.cz/dily-na-nastavby-07-sklapecove-nastavby-zubova-cerpadla"),
    ("cerpadlo", "https://www.trans-technik.cz/dily-na-nastavby-07-sklapecove-nastavby-cerpadla-pistova"),
    ("cerpadlo", "https://www.trans-technik.cz/dily-na-nastavby-07-sklapecove-nastavby-elektrohydraulicka-cerpadla"),
    ("cerpadlo", "https://www.trans-technik.cz/dily-na-nastavby-07-sklapecove-nastavby-cerpadla-rucni"),
    ("kamery", "https://www.trans-technik.cz/dily-na-nastavby-13-osvetleni-propojeni-znaceni-kamerove-systemy"),
    ("pracovni-svetla", "https://www.trans-technik.cz/dily-na-nastavby-13-osvetleni-propojeni-znaceni-led-osvetleni"),
    ("uzivatelska-zasuvka", "https://www.trans-technik.cz/dily-na-nastavby-13-osvetleni-propojeni-znaceni-vzduchove-hadice-propojovaci-kabely-zasuvky-zastrcky"),
    ("drzak-rezervy", "https://www.trans-technik.cz/dily-na-nastavby-08-konstrukcni-dily-zvedaky-rezervy-kliny-a-zajisteni"),
]


def tt_discover_leaves(root_url: str, type_slug: str, max_depth: int = 3) -> list[tuple[str, str]]:
    """BFS category pages; return (typeSlug, url) for pages that look like product lists or deeper cats."""
    seen = set()
    queue = [(root_url, 0)]
    leaves: list[tuple[str, str]] = []
    prefix = urlparse(root_url).path.rstrip("/")

    while queue:
        url, depth = queue.pop(0)
        if url in seen or depth > max_depth:
            continue
        seen.add(url)
        try:
            html = get(url)
        except Exception:
            continue
        has_products = 'class="product-types-card"' in html
        if has_products:
            leaves.append((type_slug, url))
        # discover child category links under same tree
        if depth < max_depth:
            for href in set(re.findall(r'href="(/[^"#?]+)"', html)):
                if not href.startswith(prefix):
                    # also allow child paths that contain the root slug segment
                    root_slug = prefix.split("/")[-1]
                    if root_slug not in href:
                        continue
                full = urljoin("https://www.trans-technik.cz", href)
                if full in seen:
                    continue
                # skip files, cart, etc.
                if any(x in full for x in ["/file/", "/kosik", ".pdf", ".jpg", "mailto:"]):
                    continue
                queue.append((full, depth + 1))
        # if no products and no children found, still keep page for try
        if not has_products and depth == 0:
            leaves.append((type_slug, url))
    return leaves


def parse_tt_list(url: str, type_slug: str) -> list[dict]:
    html = get(url).replace("\xa0", " ")
    out = []
    for part in re.split(r'class="product-types-card"', html)[1:]:
        href_m = re.search(r'href="(/[^"#?]+)"', part)
        img_m = re.search(r'<img[^>]+src="([^"]+)"', part)
        name_m = re.search(r"<h3>(.*?)</h3>", part, re.S)
        sku_m = re.search(r'class="product-types-id">([^<]+)<', part)
        price_m = re.search(r'class="product-types-price">\s*([^<]+?)\s*<', part)
        params = " ".join(re.findall(r'class="params-row">\s*([^<]+?)\s*<', part))
        if not href_m or not name_m or not price_m:
            continue
        price_vat = parse_price(price_m.group(1))
        if not price_vat or price_vat < 5:
            continue
        name = norm(re.sub(r"<[^>]+>", "", name_m.group(1)))
        img = img_m.group(1) if img_m else None
        if img and not img.startswith("http"):
            img = urljoin("https://www.trans-technik.cz", img)
        dims = dims_from_params(params) or dims_from_text(name)
        out.append(
            {
                "name": name[:220],
                "price": round(price_vat / 1.21, 2),
                "priceVat": round(price_vat, 2),
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


# ── Hydrotruck ─────────────────────────────────────────────────────

HT_CATS = [
    ("olejova-nadrz", "https://www.hydrotruck.cz/nadrze-hydraulicke-a-palivove/hydraulicke-nadrze/jolly-p"),
    ("olejova-nadrz", "https://www.hydrotruck.cz/nadrze-hydraulicke-a-palivove/hydraulicke-nadrze/diamond"),
    ("olejova-nadrz", "https://www.hydrotruck.cz/nadrze-hydraulicke-a-palivove/hydraulicke-nadrze/easy"),
    ("olejova-nadrz", "https://www.hydrotruck.cz/nadrze-hydraulicke-a-palivove/hydraulicke-nadrze/jolly-l"),
    ("olejova-nadrz", "https://www.hydrotruck.cz/nadrze-hydraulicke-a-palivove/hydraulicke-nadrze/jolly-i"),
    ("olejova-nadrz", "https://www.hydrotruck.cz/nadrze-hydraulicke-a-palivove/hydraulicke-nadrze/vertical"),
    ("olejova-nadrz", "https://www.hydrotruck.cz/nadrze-hydraulicke-a-palivove/hydraulicke-nadrze/rettangolo"),
    ("olejova-nadrz", "https://www.hydrotruck.cz/nadrze-hydraulicke-a-palivove/hydraulicke-nadrze/slim"),
    ("cerpadlo", "https://www.hydrotruck.cz/cerpadla/hydraulicka-cerpadla/zubova-hydraulicka-cerpadla"),
    ("cerpadlo", "https://www.hydrotruck.cz/cerpadla/hydraulicka-cerpadla/pistova-hydraulicka-cerpadla"),
    ("box-na-naradi", "https://www.hydrotruck.cz/boxy-ulozne/easy"),
    ("pracovni-svetla", "https://www.hydrotruck.cz/pracovni-svetla/led-reflektory"),
]


def parse_ht_list(url: str, type_slug: str) -> list[dict]:
    html = get(url)
    out = []
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
        price = nums[1] if len(nums) > 1 and nums[1] < price_vat else round(price_vat / 1.21, 2)
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
    seen = set()
    out = []
    for p in items:
        key = (p["supplier"], p.get("productUrl") or p["name"])
        if key in seen:
            continue
        seen.add(key)
        out.append(p)
    return out


def main() -> None:
    all_items: list[dict] = []

    # ALSAP with pagination
    print("=== ALSAP ===")
    alsap_jobs: list[tuple[str, str]] = []
    for slug, url in ALSAP_CATS:
        for page in alsap_pages(url, max_pages=5):
            alsap_jobs.append((slug, page))

    with ThreadPoolExecutor(max_workers=6) as ex:
        futs = {ex.submit(parse_alsap_list, u, s): (s, u) for s, u in alsap_jobs}
        for fut in as_completed(futs):
            s, u = futs[fut]
            try:
                ps = fut.result()
                print(f"ALSAP {s}: {len(ps)}  {u.split('/')[-2] if u.endswith('/') else u.split('/')[-1][:40]}")
                all_items.extend(ps)
            except Exception as e:
                print(f"ALSAP ERR {s}: {e}")

    # Trans-Technik: discover leaves then parse
    print("=== Trans-Technik ===")
    tt_pages: list[tuple[str, str]] = []
    for slug, root in TT_ROOTS:
        try:
            leaves = tt_discover_leaves(root, slug)
            print(f"TT discover {slug}: {len(leaves)} pages from {root.split('/')[-1]}")
            tt_pages.extend(leaves)
        except Exception as e:
            print(f"TT discover ERR {slug}: {e}")
            tt_pages.append((slug, root))

    # unique pages
    seen_pages = set()
    unique_tt = []
    for s, u in tt_pages:
        if u in seen_pages:
            continue
        seen_pages.add(u)
        unique_tt.append((s, u))

    with ThreadPoolExecutor(max_workers=6) as ex:
        futs = {ex.submit(parse_tt_list, u, s): (s, u) for s, u in unique_tt}
        for fut in as_completed(futs):
            s, u = futs[fut]
            try:
                ps = fut.result()
                if ps:
                    print(f"TT {s}: {len(ps)}  {u.split('/')[-1][:50]}")
                all_items.extend(ps)
            except Exception as e:
                print(f"TT ERR {s}: {e}")

    # Hydrotruck
    print("=== Hydrotruck ===")
    with ThreadPoolExecutor(max_workers=6) as ex:
        futs = {ex.submit(parse_ht_list, u, s): (s, u) for s, u in HT_CATS}
        for fut in as_completed(futs):
            s, u = futs[fut]
            try:
                ps = fut.result()
                print(f"HT {s}: {len(ps)}  {u.split('/')[-1]}")
                all_items.extend(ps)
            except Exception as e:
                print(f"HT ERR {s}: {e}")

    # oil estimates + podkladaci
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

    # drop zadni-zabrana leftovers if any
    final = [p for p in dedupe(all_items) if p["typeSlug"] != "zadni-zabrana"]
    OUT.write_text(json.dumps(final, ensure_ascii=False, indent=2), encoding="utf-8")
    print("TOTAL", len(final), dict(Counter(p["supplier"] for p in final)))
    print(dict(Counter(p["typeSlug"] for p in final)))
    print("images", sum(1 for p in final if p.get("imageUrl")))
    print("wrote", OUT)


if __name__ == "__main__":
    main()
