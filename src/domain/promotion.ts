/** Template objectives have complete, equally weighted binary task scores. */
export const passRatePromotion = 'paired-pass-rate-v1' as const
export const meanRewardPromotion = 'paired-mean-reward-v1' as const
export const promotionFor = (metric: 'pass_rate' | 'reward') =>
  metric === 'reward' ? meanRewardPromotion : passRatePromotion

export interface ScorePair {
  before: number
  after: number
}

export interface ProjectGate {
  policy: typeof passRatePromotion | typeof meanRewardPromotion
  mode: 'independent-held-out' | 'shared-set-research'
  accepted: boolean
  reason: 'seed-not-improved' | 'held-out-regression' | 'paired-gates-passed' | 'research-seed-improved'
  seed: ScorePair
  heldOut: ScorePair | null
  /** Legacy display fields refer to the final partition, never an invented zero. */
  before: number | null
  after: number | null
}

export function passRateGate(
  seed: ScorePair,
  mode: ProjectGate['mode'],
  heldOut: ScorePair | null = null,
): ProjectGate {
  return pairedScoreGate(passRatePromotion, seed, mode, heldOut)
}

/** Equally weighted bounded rewards keep their own policy identity, including valid fractional values. */
export function pairedScoreGate(
  policy: ProjectGate['policy'],
  seed: ScorePair,
  mode: ProjectGate['mode'],
  heldOut: ScorePair | null = null,
): ProjectGate {
  for (const pair of [seed, ...(heldOut ? [heldOut] : [])])
    if (Object.values(pair).some((value) => !Number.isFinite(value) || value < 0 || value > 1))
      throw new TypeError('Gate requires complete bounded score evidence')
  const improved = seed.after > seed.before
  if (improved && mode === 'independent-held-out' && !heldOut)
    throw new TypeError('Independent gate requires held-out evidence')
  if (mode === 'shared-set-research' && heldOut) throw new TypeError('Research gate cannot claim held-out evidence')
  const accepted = improved && (!heldOut || heldOut.after >= heldOut.before)
  const final = mode === 'shared-set-research' ? seed : heldOut
  return {
    policy,
    mode,
    accepted,
    reason: !improved
      ? 'seed-not-improved'
      : !accepted
        ? 'held-out-regression'
        : mode === 'shared-set-research'
          ? 'research-seed-improved'
          : 'paired-gates-passed',
    seed,
    heldOut,
    before: final?.before ?? null,
    after: final?.after ?? null,
  }
}
