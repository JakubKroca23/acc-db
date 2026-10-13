/**
 * Deterministic kit companion tips (box → držáky, blatníky → držáky/zástěrky, …).
 * Uses relatedGroup / parentSlug from the category map — no LLM.
 */

export type KitTipMissing = { slug: string; name: string }

export type KitTipGap = {
  groupId: string
  groupLabel: string
  triggerSlug: string
  triggerName: string
  missing: KitTipMissing[]
}

type TipType = {
  slug: string
  name: string
  parentSlug: string | null
  relatedGroup?: string | null
}

type TipGroup = { id: string; label: string; slugs: string[] }

const DISMISS_KEY = 'acc-db-kit-tips-dismissed'

export function loadDismissedKitTips(): Set<string> {
  try {
    const raw = sessionStorage.getItem(DISMISS_KEY)
    const list = raw ? (JSON.parse(raw) as unknown) : []
    return new Set(Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : [])
  } catch {
    return new Set()
  }
}

export function saveDismissedKitTips(slugs: Set<string>) {
  try {
    sessionStorage.setItem(DISMISS_KEY, JSON.stringify([...slugs]))
  } catch {
    /* storage unavailable */
  }
}

/** Gaps where a kit root is in the cart but companion categories are not. */
export function findKitGaps(
  types: TipType[],
  groups: TipGroup[],
  cartTypeSlugs: Set<string>,
  dismissed: Set<string> = new Set(),
): KitTipGap[] {
  const bySlug = new Map(types.map((t) => [t.slug, t]))
  const gaps: KitTipGap[] = []

  for (const group of groups) {
    const roots = group.slugs
      .map((s) => bySlug.get(s))
      .filter((t): t is TipType => !!t && !t.parentSlug)
    const companions = group.slugs
      .map((s) => bySlug.get(s))
      .filter((t): t is TipType => !!t && !!t.parentSlug)

    for (const root of roots) {
      if (!cartTypeSlugs.has(root.slug)) continue
      const missing = companions
        .filter((c) => !cartTypeSlugs.has(c.slug) && !dismissed.has(c.slug))
        .map((c) => ({ slug: c.slug, name: c.name }))
      if (!missing.length) continue
      gaps.push({
        groupId: group.id,
        groupLabel: group.label,
        triggerSlug: root.slug,
        triggerName: root.name,
        missing,
      })
    }
  }

  return gaps
}

/** Tip focused on the product just added (if it is a kit root with missing companions). */
export function tipForAddedProduct(
  types: TipType[],
  groups: TipGroup[],
  cartTypeSlugs: Set<string>,
  addedTypeSlug: string,
  dismissed: Set<string> = new Set(),
): KitTipGap | null {
  return (
    findKitGaps(types, groups, cartTypeSlugs, dismissed).find((g) => g.triggerSlug === addedTypeSlug) || null
  )
}

export function formatKitTipMessage(gap: KitTipGap): string {
  const names = gap.missing.map((m) => m.name).join(', ')
  return `K „${gap.triggerName}“ obvykle patří: ${names}.`
}
