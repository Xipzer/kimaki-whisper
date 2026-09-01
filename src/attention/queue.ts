// Her attention store: everything waiting to be told to the owner, in one
// place with one set of rules. Four lanes replace four ad-hoc arrays:
//   live     - interrupt-tier items while he is in voice; the delivery
//              engine speaks these at conversational pauses
//   digest   - low-priority items batched on a slow timer
//   pending  - items that arrived while he was absent; promoted to held on join
//   held     - items waiting to ride into his next turn as context
// Caps are per lane; dedupe is by source marker across all delivery lanes.
export type Lane = 'live' | 'digest' | 'pending' | 'held'

const CAPS: Record<Lane, number> = { live: Infinity, digest: Infinity, pending: 8, held: 12 }
const HIGH = '[HIGH]'

export class AttentionQueue {
  private lanes: Record<Lane, string[]> = { live: [], digest: [], pending: [], held: [] }

  push(lane: Lane, ...items: string[]): void {
    const q = this.lanes[lane]
    q.push(...items)
    const cap = CAPS[lane]
    if (q.length > cap) q.splice(0, q.length - cap)
  }
  /** Remove and return up to n items from the front (all if n omitted). */
  take(lane: Lane, n?: number): string[] { return this.lanes[lane].splice(0, n ?? this.lanes[lane].length) }
  /** Move everything from one lane to another, honouring the target cap. */
  promote(from: Lane, to: Lane): number {
    const items = this.take(from)
    if (items.length) this.push(to, ...items)
    return items.length
  }
  /** Keep only the newest n items in a lane (used while DND drops stale live items). */
  trim(lane: Lane, keep: number): void {
    const q = this.lanes[lane]
    if (q.length > keep) q.splice(0, q.length - keep)
  }
  /** One item per source: drop every queued item carrying this marker. */
  dropMatching(marker: string, lanes: Lane[] = ['digest', 'pending', 'held']): number {
    let n = 0
    for (const l of lanes) {
      const q = this.lanes[l]
      for (let i = q.length - 1; i >= 0; i--) if (q[i].includes(marker)) { q.splice(i, 1); n++ }
    }
    return n
  }
  count(lane: Lane): number { return this.lanes[lane].length }
  has(lane: Lane): boolean { return this.lanes[lane].length > 0 }
  peek(lane: Lane): readonly string[] { return this.lanes[lane] }
  some(lane: Lane, pred: (s: string) => boolean): boolean { return this.lanes[lane].some(pred) }
  /** Everything across all lanes, delivery order. */
  all(): string[] { return [...this.lanes.digest, ...this.lanes.live, ...this.lanes.pending, ...this.lanes.held] }
  total(): number { return this.all().length }
  highCount(lane?: Lane): number { return (lane ? this.lanes[lane] : this.all()).filter((x) => x.includes(HIGH)).length }
}
