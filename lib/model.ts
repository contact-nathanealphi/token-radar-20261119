// The radar's valuation model: a sealed snapshot in, a ranked board out.
//
// The question the board answers is "what would this protocol's token be worth if its record
// stayed as it is?" The answer is a peer multiple, not a guess: protocols whose token already
// trades tell us what the market pays per dollar of TVL, category by category, and a pre-token
// protocol is priced at the multiple its own category's live peers carry. Everything the model
// uses comes from the snapshot's own ten fields, so the same code scores a future snapshot
// with protocols that do not exist yet. No name is ever special-cased.
//
//   multiple  = median(mcap_usd / tvl_usd) over live-token protocols in the same category
//               (at least 3 peers; otherwise the median over every live protocol), clamped
//               to [0.05, 2.0] so one outlier cannot set the price
//   growth    = 1 + clamp(change_7d, -50, 150) / 100 * 0.4
//   seasoning = 0.7 + 0.3 * min(age_days, 730) / 730        (unknown age: 365 days)
//   reach     = 1 + 0.03 * min(chains - 1, 4)               (more chains, more surface)
//   implied   = round(tvl_usd * multiple * growth * seasoning * reach), at least $1
//
// The board ranks every protocol that records no token and is not a wrapped, staked or
// bridged product of a token that trades, the watchlist's own rule applied to the whole
// snapshot. Protocols whose token already trades are kept apart, in the Live view, at the
// market's own values: they are the comparables, never the ranking.

/** One protocol entry of the sealed snapshot: exactly its ten fields. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** The model's constants, stated in the dashboard so the valuation can be checked. */
export interface ModelConstants {
  min_peers: number;
  multiple_floor: number;
  multiple_cap: number;
  growth_floor: number;
  growth_cap: number;
  growth_weight: number;
  season_floor: number;
  season_span: number;
  season_days: number;
  unknown_age_days: number;
  reach_step: number;
  reach_max_extra_chains: number;
}

export const MODEL: ModelConstants = {
  min_peers: 3,
  multiple_floor: 0.05,
  multiple_cap: 2.0,
  growth_floor: -50,
  growth_cap: 150,
  growth_weight: 0.4,
  season_floor: 0.7,
  season_span: 0.3,
  season_days: 730,
  unknown_age_days: 365,
  reach_step: 0.03,
  reach_max_extra_chains: 4,
};

/** The model's version label, shown in the dashboard and the board. */
export const MODEL_VERSION = 'peer-multiple-1';

/** How many live-token protocols the Live view carries, by market cap. */
export const LIVE_ROWS = 24;

/** One row of board.json. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  age_days: number | null;
  watchlist: boolean;
  token_status: 'pre-token';
  implied_value_usd: number;
  valuation: {
    multiple: number;
    multiple_basis: 'category peers' | 'all live peers';
    peers: number;
    growth_factor: number;
    season_factor: number;
    reach_factor: number;
  };
  farm_steps: string[];
}

/** A live-token protocol, shown at the market's own value, never ranked. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  symbol: string | null;
  change_7d: number | null;
  mcap_tvl_ratio: number | null;
}

/** One row of the peer-multiple table the dashboard shows. */
export interface MultipleRow {
  category: string;
  multiple: number;
  peers: number;
}

/** Everything the dashboard renders. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model_version: string;
  model: ModelConstants;
  global_multiple: number;
  global_peers: number;
  multiples: MultipleRow[];
  scanned: number;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  total_implied_usd: number;
  rows: BoardRow[];
  live: LiveRow[];
}

/** Why a snapshot cannot be scored. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;
const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

/** Whole days from `listedAt` to `asOf`, clamped at zero; null when either date is missing or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** The median of a non-empty list, the average of the two middle values when even. */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Whether the record shows a token that already trades. */
export function hasLiveToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd !== null || p.gecko_id !== null || p.symbol !== null;
}

/** A name ending in a release marker is a versioned pool of another protocol, not a launch of its own. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** Categories whose products are wrapped, staked or bridged forms of another token. */
const WRAPPED_CATEGORIES = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);

/** Exchange names a wrapped product's name begins with. */
const EXCHANGE_PREFIXES = ['Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini'];

/** Whether a protocol is a wrapped, staked or bridged product: the watchlist's own rule. */
export function isWrappedProduct(p: SnapshotProtocol): boolean {
  if (p.category !== null && WRAPPED_CATEGORIES.has(p.category)) return true;
  if (VERSIONED.test(p.name)) return true;
  if (/\bwrapped\b|\bstaked\b|\bstaking\b/i.test(p.name)) return true;
  return EXCHANGE_PREFIXES.some((x) => p.name.startsWith(x));
}

/** Whether a protocol belongs on the ranked board: no token recorded, not a wrapped product. */
export function isRankable(p: SnapshotProtocol): boolean {
  return !hasLiveToken(p) && !isWrappedProduct(p);
}

/** The peer multiples: one median mcap/TVL per category with enough live peers, plus the global one. */
export function peerMultiples(protocols: SnapshotProtocol[], model: ModelConstants): { byCategory: Map<string, { multiple: number; peers: number }>; global: { multiple: number; peers: number } } {
  const ratios = new Map<string, number[]>();
  const all: number[] = [];
  for (const p of protocols) {
    if (!hasLiveToken(p) || p.mcap_usd === null || p.tvl_usd <= 0 || p.category === null) continue;
    const ratio = p.mcap_usd / p.tvl_usd;
    if (!Number.isFinite(ratio) || ratio <= 0) continue;
    const list = ratios.get(p.category) ?? [];
    list.push(ratio);
    ratios.set(p.category, list);
    all.push(ratio);
  }
  const clamp = (m: number): number => Math.min(model.multiple_cap, Math.max(model.multiple_floor, m));
  const byCategory = new Map<string, { multiple: number; peers: number }>();
  for (const [category, list] of ratios) {
    if (list.length >= model.min_peers) byCategory.set(category, { multiple: round4(clamp(median(list))), peers: list.length });
  }
  return { byCategory, global: { multiple: round4(clamp(median(all))), peers: all.length } };
}

/** The valuation of one protocol: the peer multiple and the three snapshot-derived factors. */
export function scoreProtocol(
  p: SnapshotProtocol,
  asOf: string,
  multiples: { byCategory: Map<string, { multiple: number; peers: number }>; global: { multiple: number; peers: number } },
  model: ModelConstants,
): { implied: number; multiple: number; basis: 'category peers' | 'all live peers'; peers: number; growth: number; season: number; reach: number; age: number | null } {
  const peer = p.category !== null ? multiples.byCategory.get(p.category) : undefined;
  const multiple = peer?.multiple ?? multiples.global.multiple;
  const basis = peer !== undefined ? 'category peers' : 'all live peers';
  const peers = peer?.peers ?? multiples.global.peers;
  const growthPct = Math.min(model.growth_cap, Math.max(model.growth_floor, typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : 0));
  const growth = 1 + (growthPct / 100) * model.growth_weight;
  const age = ageDays(asOf, p.listed_at);
  const ageForModel = age ?? model.unknown_age_days;
  const season = model.season_floor + (Math.min(Math.max(ageForModel, 0), model.season_days) / model.season_days) * model.season_span;
  const reach = 1 + model.reach_step * Math.min(Math.max(p.chains.length - 1, 0), model.reach_max_extra_chains);
  const implied = Math.max(1, Math.round(p.tvl_usd * multiple * growth * season * reach));
  return { implied, multiple, basis, peers, growth: round4(growth), season: round4(season), reach: round4(reach), age };
}

// ---------------------------------------------------------------- farm plans

/** The first chain named, or a neutral phrase when the record names none. */
function chainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** The farming stake, sized to the protocol's own TVL: bigger pools swallow bigger positions. */
function stakeFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 1_000_000_000) return 200;
  if (p.tvl_usd >= 100_000_000) return 100;
  return 50;
}

/** The minimum hold, from the protocol's age: younger records need a longer activity trail. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 45;
  if (age < 180) return 90;
  if (age < 365) return 60;
  return 45;
}

/** The category's main farming action, in words a reader can follow. */
function mainAction(p: SnapshotProtocol, stake: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const n = p.name;
  if (c.includes('curator') || c.includes('allocator')) return `Deposit $${stake} of USDC into ${n}'s largest vault on ${chain} and hold the vault shares.`;
  if (c.includes('dex') || c.includes('liquidity manager')) return `Add $${stake} of liquidity to ${n}'s deepest pool on ${chain}, in the pair its pool page lists first, and keep the position open.`;
  if (c.includes('rwa')) return `Mint $${stake} of ${n}'s tokenized asset on ${chain} with USDC and hold it in the farming wallet.`;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return `Supply $${stake} of USDC to ${n} on ${chain}, and optionally borrow a small amount against it and repay it within the same week.`;
  if (c.includes('yield') || c.includes('farm')) return `Deposit $${stake} of USDC into ${n}'s top strategy on ${chain} and leave the receipt tokens untouched.`;
  if (c.includes('derivative') || c.includes('perpetual') || c.includes('option') || c.includes('basis') || c.includes('interest rate')) return `Post $${stake} of USDC as margin on ${n} on ${chain}, open one small hedged position, and close it before funding costs eat the edge.`;
  if (c.includes('bridge') || c.includes('cross chain')) return `Bridge $${stake} of USDC through ${n} to ${chain} and use the bridged funds in a second action the same week.`;
  if (c.includes('stak') || c.includes('restak') || c.includes('anchor') || c.includes('decentralized btc')) return `Stake $${stake} through ${n} on ${chain} and keep the staking receipt in the farming wallet.`;
  if (c.includes('prediction')) return `Fund the account with $${stake} and take one position in ${n}'s most liquid market on ${chain}.`;
  if (c.includes('stablecoin') || c.includes('dual-token')) return `Mint or buy $${stake} of ${n}'s stable asset on ${chain} and hold it, or pair it in the protocol's own pool.`;
  if (c.includes('insurance')) return `Buy $${stake} of cover from ${n} on ${chain} for a protocol you already use, and keep the policy active.`;
  if (c === 'chain') return `Bridge $${stake} to the chain, use ${n}'s own app for one swap and one liquidity deposit, and keep a balance for gas.`;
  if (c.includes('payment') || c.includes('card')) return `Route $${stake} of spending through ${n} on ${chain} and keep the account active across two billing cycles.`;
  if (c.includes('governance')) return `Hold $${stake} of the governance-eligible asset and vote on ${n}'s next proposal on ${chain}.`;
  if (c.includes('index')) return `Buy $${stake} of ${n}'s index token on ${chain} and hold it through one rebalance.`;
  if (c.includes('otc') || c.includes('marketplace')) return `Complete one $${stake} trade through ${n} on ${chain} and keep the settlement receipt.`;
  if (c.includes('leveraged')) return `Open a $${stake} leveraged position on ${n} on ${chain} at the lowest leverage the app offers, with an exit price decided in advance.`;
  if (c.includes('cedefi')) return `Deposit $${stake} into ${n}'s managed product on ${chain} and keep the position for the full term it shows.`;
  return `Deposit $${stake} of USDC into ${n}'s main product on ${chain} and keep the position open.`;
}

/** One farm step as a single string: the action, what it costs, how long it takes. */
function stepText(text: string, cost: string, time: string): string {
  let s = `${text} Cost: ${cost}. Time: ${time}.`;
  if (s.length > 600) s = `${s.slice(0, 597)}...`;
  return s;
}

/**
 * A protocol's farm plan: six steps derived from its own record (category, chains, TVL, age),
 * each naming what it costs and how long it takes. Never a hand-written list of names.
 */
export function farmPlan(p: SnapshotProtocol, age: number | null): string[] {
  const chain = chainOf(p);
  const stake = stakeFor(p);
  const hold = holdDaysFor(age);
  const gas = stake >= 200 ? 10 : stake >= 100 ? 6 : 4;
  return [
    stepText(
      `Open a fresh wallet used only for farming, fund it with the stake plus gas money, and store its recovery phrase offline, never in a screenshot or a chat.`,
      `about $${gas} of gas to fund it`,
      '10 minutes',
    ),
    stepText(mainAction(p, stake, chain), `$${stake} of capital plus roughly $${gas} of gas`, '20 minutes to set up'),
    stepText(
      `Repeat one real action every week, a deposit, a swap, a vote or a rebalance, so the wallet shows steady use rather than one burst.`,
      'about $2 of gas a week',
      '10 minutes a week',
    ),
    stepText(`Keep the position open for at least ${hold} days, covering more than one monthly snapshot window.`, `the $${stake} stays deployed`, `${hold} days`),
    stepText(
      `Before claiming anything, open the protocol's own rewards or points page from its official site; never pay a fee to claim and never sign an approval you cannot read.`,
      'free to check',
      '10 minutes',
    ),
    stepText(`Log the wallet address, the dates, the amounts and every transaction hash, and set a reminder to review the position before unwinding it.`, 'nothing but the log', '5 minutes'),
  ];
}

// ---------------------------------------------------------------- board

/** The ranked board: every rankable protocol, best implied value first, ties broken by slug. */
export function buildBoard(snapshot: Snapshot, model: ModelConstants = MODEL): BoardRow[] {
  const multiples = peerMultiples(snapshot.protocols, model);
  const watchlist = new Set(snapshot.watchlist);
  const scored = snapshot.protocols
    .filter(isRankable)
    .map((p) => ({ p, score: scoreProtocol(p, snapshot.as_of, multiples, model) }))
    .sort((a, b) => b.score.implied - a.score.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  return scored.map((s, i) => ({
    rank: i + 1,
    slug: s.p.slug,
    name: s.p.name,
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    listed_at: s.p.listed_at,
    age_days: s.score.age,
    watchlist: watchlist.has(s.p.slug),
    token_status: 'pre-token',
    implied_value_usd: s.score.implied,
    valuation: {
      multiple: s.score.multiple,
      multiple_basis: s.score.basis,
      peers: s.score.peers,
      growth_factor: s.score.growth,
      season_factor: s.score.season,
      reach_factor: s.score.reach,
    },
    farm_steps: farmPlan(s.p, s.score.age),
  }));
}

/** The live-token set, by market cap: the market's own values, kept off the ranked board. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => hasLiveToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : 1))
    .slice(0, LIVE_ROWS)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      symbol: p.symbol,
      change_7d: p.change_7d,
      mcap_tvl_ratio: p.mcap_usd !== null && p.tvl_usd > 0 ? round4(p.mcap_usd / p.tvl_usd) : null,
    }));
}

/** The board plus everything the dashboard renders, from one snapshot. */
export function buildRadar(snapshot: Snapshot, model: ModelConstants = MODEL): { board: BoardRow[]; radar: RadarData } {
  const board = buildBoard(snapshot, model);
  const multiples = peerMultiples(snapshot.protocols, model);
  const live = liveRows(snapshot);
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model_version: MODEL_VERSION,
    model,
    global_multiple: multiples.global.multiple,
    global_peers: multiples.global.peers,
    multiples: [...multiples.byCategory.entries()]
      .map(([category, m]) => ({ category, multiple: m.multiple, peers: m.peers }))
      .sort((a, b) => b.peers - a.peers || (a.category < b.category ? -1 : 1)),
    scanned: snapshot.protocols.length,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: board.filter((r) => !r.watchlist).length,
    live_size: live.length,
    total_implied_usd: board.reduce((n, r) => n + r.implied_value_usd, 0),
    rows: board,
    live,
  };
  return { board, radar };
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return { as_of: o.as_of, source: o.source, floor_usd: o.floor_usd, protocols, watchlist: o.watchlist as string[] };
}

/** Why a board is not one the gate takes, or null: coverage, ranks, order, flat values, farm steps. */
export function checkBoard(board: BoardRow[], snapshot: Snapshot): string | null {
  if (board.length < 100 || board.length > 4000) return `the board holds ${board.length} rows, outside 100 to 4000`;
  const slugs = new Set(board.map((r) => r.slug));
  if (slugs.size !== board.length) return 'the board repeats a slug';
  const known = new Set(snapshot.protocols.map((p) => p.slug));
  const invented = board.filter((r) => !known.has(r.slug));
  if (invented.length > 0) return `the board invents ${invented[0]!.slug}`;
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slugs: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} reads ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board.every((r) => r.implied_value_usd === board[0]!.implied_value_usd)) return 'every row shares one implied value: not a ranking';
  for (const r of board) {
    if (r.name.trim() === '') return `${r.slug} has an empty name`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0 || r.implied_value_usd > 100_000_000_000_000) return `${r.slug} has implied value ${r.implied_value_usd}`;
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) return `${r.slug} has ${r.farm_steps.length} farm steps`;
    for (const s of r.farm_steps) {
      const n = s.trim().length;
      if (n < 20 || n > 600) return `${r.slug} has a farm step of ${n} characters`;
    }
  }
  return null;
}

/** The dashboard's dataset as one script: no fetch, no network, the page reads window.RADAR. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
