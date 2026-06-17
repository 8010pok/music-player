/**
 * 期間比較ユーティリティ
 *
 * - 「今週 vs 先週」「今月 vs 先月」「今年 vs 去年」を Weekly Chart API から計算
 * - Last.fm の Weekly Chart は固定期間 (週単位、UTC) で返るため、
 *   月/年比較は「該当期間に含まれる週」を集計して算出する
 */

import {
  getWeeklyChartList,
  getWeeklyArtistChart,
  getWeeklyAlbumChart,
  getWeeklyTrackChart,
} from "./stats.js";
import { cached, getCacheMany, setCache } from "./stats-cache.js";

// JST のオフセット (UTC+9, 固定)。日本標準時はサマータイムが無いため
// 常に +9 時間で計算でき、月/年境界の判定を端末タイムゾーンに依存させない。
const JST_OFFSET_MS = 9 * 3600 * 1000;

// ★ 週次チャートのネットワーク取得の「同時実行数」を制限する共有セマフォ。
//   振り返り(全年×全週)と比較が同時に走るとき、無制限並列だと Last.fm の
//   レート制限(5 req/s 目安)を超えやすい。逆に従来の週直列(同時1)は遅い。
//   キャッシュヒット週は集計だけで通信しないためセマフォを通さず即処理し、
//   実通信(キャッシュミス週)だけを同時 NET_CONCURRENCY 本に絞る。
//   モジュール共有のため、buildRewind / buildComparison / findNewDiscoveries が
//   並行しても合計の同時通信数がこの上限に収まる。
const NET_CONCURRENCY = 4;

function makeSemaphore(max) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= max || queue.length === 0) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    Promise.resolve()
      .then(fn)
      .then(resolve, reject)
      .finally(() => { active--; next(); });
  };
  // fn(非同期関数) をセマフォ管理下で実行する
  return (fn) => new Promise((resolve, reject) => {
    queue.push({ fn, resolve, reject });
    next();
  });
}
const netLimit = makeSemaphore(NET_CONCURRENCY);

// 同一週キーの並行ネットワーク取得を 1 本に合流させる in-flight Map(CACHE-1)。
// aggregateRange は cached() の dedup を経由しないため、fetchCompare /
// findNewDiscoveries / buildRewind が同じ境界週を同時要求すると二重 fetch しうる。
const _weekInflight = new Map();

/**
 * 週次取得の in-flight Map をクリアする(refresh の鮮度競合防止)。
 *   refresh() の clearCache 前に呼ぶことで、clearCache 前に発射済みの旧 fetch が
 *   新 run の同一週要求に共有されるのを防ぐ(stats-cache の _inflight と対)。
 */
export function clearWeekInflight() {
  _weekInflight.clear();
}

/**
 * unix(秒) で「現在からNヶ月前の同日（JST 壁時計基準）」を返す
 *
 * baseTs を +9h ずらすと Date の UTC フィールドがそのまま JST の壁時計に一致する。
 * その状態で UTC 系メソッドで月を引き、最後に -9h 戻して unix 秒へ変換することで、
 * 端末のローカルタイムゾーンに関係なく常に JST 基準の境界を得る。
 */
function monthsAgoUnix(months, baseTs = Date.now()) {
  const d = new Date(baseTs + JST_OFFSET_MS);
  const day = d.getUTCDate();
  // 先に 1 日へ寄せてから月を引くことで setUTCMonth の桁あふれを防ぐ。
  // setUTCMonth は日(date)を保持するため、目標月に元の日が無いと翌月へあふれる
  // (例: 3/31 の 1 ヶ月前が 3/3 になり「今月」窓が「先月」より短くなる)。
  // 目標月の日数を超える場合は月末へクランプする(3/31 → 2/28)。
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - months);
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay));
  return Math.floor((d.getTime() - JST_OFFSET_MS) / 1000);
}
function yearsAgoUnix(years, baseTs = Date.now()) {
  const d = new Date(baseTs + JST_OFFSET_MS);
  const month = d.getUTCMonth();
  const day = d.getUTCDate();
  // うるう日(2/29)の N 年前など、目標年の同月に元の日が無ければ月末へクランプ
  // (2/29 → 2/28)。月の桁あふれ防止のため先に 1 日へ寄せてから年を引く。
  d.setUTCDate(1);
  d.setUTCFullYear(d.getUTCFullYear() - years);
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), month + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay));
  return Math.floor((d.getTime() - JST_OFFSET_MS) / 1000);
}

/**
 * Weekly chart list から、指定 unix 範囲 [fromUnix, toUnix] と重なる週を抽出
 *   - 完全に含まれる週 + 部分的に重なる週も含める
 */
function filterWeeks(weekList, fromUnix, toUnix) {
  // 注: 部分的に重なる境界週も「全量」含める。月/年比較では境界週(current の先頭・
  // previous の末尾)が両期間に丸ごと計上され、その分 total が過大になる近似。
  // 週次チャートの粒度では日割りできないため許容する。week 範囲は別途 rolling 実数
  // (fetchWeekScrobbleTotals)で totals を上書きするが、month/year は概算値となる。
  return weekList.filter((w) => w.to >= fromUnix && w.from <= toUnix);
}

/**
 * チャート (artist|album|track) を再生回数 (playcount) の Map にする
 *   キーは name+artist の組合せ
 */
// チャート要素の内部突き合わせキー。artist と name の境界を通常データに出ない
// 制御文字(Unit Separator)で区切り、'A B'+'C' と 'A'+'B C' のスペース連結衝突を防ぐ。
const KEY_SEP = String.fromCharCode(31);
const itemKey = (artist, name) => `${artist}${KEY_SEP}${name}`;

function chartToMap(rows, kind) {
  const m = new Map();
  for (const r of rows) {
    const name = r.name || "";
    const artist = (kind === "artist")
      ? name
      : (r.artist?.["#text"] || r.artist?.name || r.artist || "");
    const key = itemKey(artist, name);
    const count = parseInt(r.playcount || "0", 10);
    if (!count) continue;
    const prev = m.get(key);
    if (prev) {
      prev.count += count;
    } else {
      m.set(key, { artist, name, count, image: r.image, kind });
    }
  }
  return m;
}

/**
 * 複数週を 1 つの Map に合算する (期間内の累計を出すため)。
 *
 * ★ 高速化: 従来は週を 1 件ずつ直列 await していたため、全期間集計
 *   (振り返り) で数百回の往復が積み上がっていた。改善版は:
 *     1. 全週のキャッシュを getCacheMany で「一括読み」(直列 await を解消)
 *     2. キャッシュミス週だけを共有セマフォ(同時 NET_CONCURRENCY)経由で取得
 *     3. 集計(chartToMap → merged マージ)は同期処理なので、並行ワーカー間でも
 *        JS の単一スレッド性によりアトミックに実行され競合しない
 *   戻り値の merged Map の形は従来と同一 (呼び出し側に影響なし)。
 */
async function aggregateRange(user, kind, weeks, { forceRefresh = false } = {}) {
  if (!weeks || weeks.length === 0) return new Map();
  const fetchOne = (kind === "artist") ? getWeeklyArtistChart
                  : (kind === "album") ? getWeeklyAlbumChart
                  : getWeeklyTrackChart;
  const merged = new Map();
  const nowSec = Math.floor(Date.now() / 1000);
  const keys = weeks.map((w) => `weekly:${kind}:${user}:${w.from}:${w.to}`);

  // 1. 一括キャッシュ読み。forceRefresh でも【確定済み過去週(persistent=不変データ)】は
  //    キャッシュを優先し、進行中(現在)週だけを再取得対象にする。
  //    ★ 旧実装は forceRefresh で全週をミス扱いにしていたため、warm day2(JST 跨ぎの
  //      forceRefresh:true 再取得)で長期ユーザの数百〜千の不変過去週を毎日再ネットワーク
  //      取得し、5req/s 律速で数分かかっていた。過去週は w.to<now-1日 で不変が確定して
  //      おり(下の persistent 書込と同基準)、再取得は無駄。cold day2(forceRefresh:false)と
  //      実通信量を揃える(weekly-list + 現在週のみ)。
  const cachedRows = await getCacheMany(keys);
  const preRead = forceRefresh
    ? weeks.map((w, i) => (w.to < nowSec - 86400 ? cachedRows[i] : null))
    : cachedRows;

  // chartToMap 結果を merged へマージ (同期。並行ワーカーから呼ばれてもアトミック)
  const mergeRows = (rows) => {
    const m = chartToMap(rows || [], kind);
    for (const [k, v] of m.entries()) {
      const prev = merged.get(k);
      if (prev) prev.count += v.count;
      else merged.set(k, { ...v });
    }
  };

  // 2. 各週を並列処理。ヒット週は即マージ、ミス週はセマフォ経由でネットワーク取得。
  await Promise.all(weeks.map(async (w, i) => {
    let rows = preRead[i];
    if (rows == null) {
      // ★ 終了から1日以上経過した週のチャートは不変データなので persistent
      //   (日次失効なし) でキャッシュする。進行中の週は従来どおり日次失効。
      const persistent = w.to < nowSec - 86400;
      // 同一週キーの並行取得を 1 本に合流(CACHE-1)。forceRefresh 時は鮮度優先で
      // 共有しない(古い in-flight を掴ませない)。
      const k = keys[i];
      let p = forceRefresh ? null : _weekInflight.get(k);
      if (!p) {
        p = netLimit(() => fetchOne(user, w.from, w.to)).then((data) => {
          // setCache は待たない(fire-and-forget)。待つと数百週ぶんの集計が
          // IDB 書込レイテンシ分だけ遅くなる。整合性は次回起動時の読みで担保される。
          setCache(k, data, { persistent }).catch(() => {});
          return data;
        });
        if (!forceRefresh) {
          _weekInflight.set(k, p);
          // ★ 同一性ガード: clearWeekInflight() の _weekInflight.clear() 後に旧 run の
          //   p が遅れて settle すると、無条件 delete(k) は新 run が登録した p_new を
          //   誤削除し、後続の aggregateRange が同一週の重複ネットワーク要求を撃つ。
          //   「今この k に入っているのが自分(p)のときだけ」削除する
          //   (stats-cache.js cached() の _inflight と同じパターン)。
          p.finally(() => {
            if (_weekInflight.get(k) === p) _weekInflight.delete(k);
          }).catch(() => {});
        }
      }
      rows = await p;
    }
    mergeRows(rows);
  }));

  return merged;
}

/**
 * 比較期間を計算
 *   range = "week" | "month" | "year"
 *
 * 戻り値: { current: {from,to,label}, previous: {from,to,label} }
 */
export function computeRange(range, now = Date.now()) {
  if (range === "week") {
    const nowUnix = Math.floor(now / 1000);
    // 厳密に 7 日単位
    const oneWeek = 7 * 24 * 60 * 60;
    return {
      current:  { from: nowUnix - oneWeek, to: nowUnix, label: "今週" },
      previous: { from: nowUnix - 2 * oneWeek, to: nowUnix - oneWeek, label: "先週" },
    };
  }
  if (range === "month") {
    const nowUnix = Math.floor(now / 1000);
    return {
      // year の "今年(直近12ヶ月)" と表記を揃え、ローリング窓(暦月でない)であることを明示する。
      current:  { from: monthsAgoUnix(1, now), to: nowUnix, label: "今月(直近1ヶ月)" },
      previous: { from: monthsAgoUnix(2, now), to: monthsAgoUnix(1, now), label: "先月(その前1ヶ月)" },
    };
  }
  if (range === "year") {
    const nowUnix = Math.floor(now / 1000);
    return {
      current:  { from: yearsAgoUnix(1, now), to: nowUnix, label: "今年(直近12ヶ月)" },
      previous: { from: yearsAgoUnix(2, now), to: yearsAgoUnix(1, now), label: "去年" },
    };
  }
  throw new Error(`unknown range: ${range}`);
}

/**
 * 比較データを作成
 *   - range: "week" | "month" | "year"
 *   - kind: "artist" | "album" | "track"
 *
 *   戻り値:
 *   {
 *     current:  { label, total, items: [{name, artist, count, rank, ...}] },
 *     previous: { label, total, items: [...] },
 *     diff: {
 *       up: [{ name, artist, currentRank, prevRank, currentCount, prevCount, delta }],
 *       down: [...],
 *       new: [...],
 *       fallen: [...],
 *     }
 *   }
 */
export async function buildComparison(user, range, kind, { limit = 10, forceRefresh = false } = {}) {
  const { current, previous } = computeRange(range);
  // 週次チャートリスト (キャッシュ可能)
  const weekList = await cached(
    `weekly-list:${user}`,
    () => getWeeklyChartList(user),
    { forceRefresh }
  );

  const curWeeks  = filterWeeks(weekList, current.from, current.to);
  const prevWeeks = filterWeeks(weekList, previous.from, previous.to);

  const [curMap, prevMap] = await Promise.all([
    aggregateRange(user, kind, curWeeks, { forceRefresh }),
    aggregateRange(user, kind, prevWeeks, { forceRefresh }),
  ]);

  // ランキングを作成 (count 降順)
  const rank = (map) => Array.from(map.values())
    .sort((a, b) => b.count - a.count)
    .map((v, i) => ({ ...v, rank: i + 1 }));

  const curList = rank(curMap);
  const prevList = rank(prevMap);

  // 上位 limit 件を主表示用に
  const curTop  = curList.slice(0, limit);
  const prevTop = prevList.slice(0, limit);

  const prevByKey = new Map(prevList.map((x) => [itemKey(x.artist, x.name), x]));
  const curByKey  = new Map(curList.map((x) => [itemKey(x.artist, x.name), x]));

  const up = [], down = [], newcomers = [], fallen = [];
  for (const c of curTop) {
    const key = itemKey(c.artist, c.name);
    const p = prevByKey.get(key);
    if (!p) {
      newcomers.push({ ...c, currentRank: c.rank, prevRank: null, delta: c.count });
    } else if (p.rank > c.rank) {
      up.push({ ...c, currentRank: c.rank, prevRank: p.rank, currentCount: c.count, prevCount: p.count, delta: c.count - p.count });
    } else if (p.rank < c.rank) {
      down.push({ ...c, currentRank: c.rank, prevRank: p.rank, currentCount: c.count, prevCount: p.count, delta: c.count - p.count });
    }
  }
  // 先週上位 limit に居たが今週 limit から落ちた
  for (const p of prevTop) {
    const key = itemKey(p.artist, p.name);
    if (!curTop.find((x) => itemKey(x.artist, x.name) === key)) {
      const c = curByKey.get(key);
      fallen.push({
        ...p,
        currentRank: c ? c.rank : null,
        prevRank: p.rank,
        currentCount: c ? c.count : 0,
        prevCount: p.count,
        delta: (c ? c.count : 0) - p.count,
      });
    }
  }

  // 合計 scrobble 数
  const sumCount = (list) => list.reduce((s, x) => s + x.count, 0);

  return {
    range,
    kind,
    current:  { ...current,  total: sumCount(curList),  items: curTop },
    previous: { ...previous, total: sumCount(prevList), items: prevTop },
    diff: { up, down, new: newcomers, fallen },
  };
}

/**
 * 振り返り: 年ごとのトップアーティスト/アルバム/トラックを返す
 *   - Weekly Chart List から年ごとに分割集計
 *   - 各年のトップ N を返す
 *
 * 戻り値: { years: [{ year, total, topArtists, topAlbums, topTracks }, ...] }
 */
export async function buildRewind(user, { topN = 3, forceRefresh = false, onYear = null } = {}) {
  const weekList = await cached(
    `weekly-list:${user}`,
    () => getWeeklyChartList(user),
    { forceRefresh }
  );
  // 年ごとに週をまとめる。
  // 年境界の判定は JST (UTC+9) で行う。ローカルタイムゾーンに依存すると
  // 年末年始の週が誤った年に入るため、stats-worker.js と同じ方法で UTC+9 に変換する。
  const byYear = new Map();
  for (const w of weekList) {
    const year = new Date(w.to * 1000 + 9 * 3600 * 1000).getUTCFullYear();
    if (!byYear.has(year)) byYear.set(year, []);
    byYear.get(year).push(w);
  }
  const years = Array.from(byYear.keys()).sort((a, b) => a - b);
  const sortTopN = (m) => Array.from(m.values()).sort((a, b) => b.count - a.count).slice(0, topN);
  // ★ 全年を並列に集計する (従来は年ごとに直列 await していた)。
  //   各週のネットワーク取得は共有セマフォ(netLimit)で同時数が絞られるため、
  //   年 × 種をまとめて投げても実通信はバーストしない。
  //   Promise.all は入力順を保持するので result は年昇順のまま。
  const result = await Promise.all(years.map(async (y) => {
    const weeks = byYear.get(y);
    const [aMap, bMap, tMap] = await Promise.all([
      aggregateRange(user, "artist", weeks, { forceRefresh }),
      aggregateRange(user, "album",  weeks, { forceRefresh }),
      aggregateRange(user, "track",  weeks, { forceRefresh }),
    ]);
    // track/artist の playcount 合計は本来どちらも年の scrobble 数で一致するはずだが、
    // 片方のチャートにのみ計上される稀なデータ(track 名欠落等)で乖離する場合に過小表示を
    // 避けるため大きい方を採る(旧実装の `track || artist` は track が非0で artist より
    // 小さいとき過小になり、棒グラフ/年カード/マイルストン累積に伝播していた)。
    const total = Math.max(
      Array.from(tMap.values()).reduce((s, v) => s + v.count, 0),
      Array.from(aMap.values()).reduce((s, v) => s + v.count, 0)
    );
    const yr = {
      year: y,
      total,
      topArtists: sortTopN(aMap),
      topAlbums:  sortTopN(bMap),
      topTracks:  sortTopN(tMap),
    };
    // ★ 年が1つ集計できるたびに通知する（呼び出し側が逐次表示・早期 ready 化に使う）。
    //   全年並列なので解決順は不定。呼び出し側で年をキー化して順序・重複を整える。
    if (onYear) { try { onYear(yr); } catch {} }
    return yr;
  }));
  return { years: result };
}

/**
 * 「新しい発見」: 直近期間に初登場したアーティスト/アルバム/トラックを返す
 *   - currentWeeks 集計 - previousWeeks (より前すべて) 集計の差分
 *   - lookbackWeeks: 直近何週を「現在」とみなすか (既定: 1週)
 */
export async function findNewDiscoveries(user, kind, { lookbackWeeks = 1, limit = 10, forceRefresh = false } = {}) {
  const weekList = await cached(
    `weekly-list:${user}`,
    () => getWeeklyChartList(user),
    { forceRefresh }
  );
  if (weekList.length === 0) return [];
  // 新しい順に並んでいない場合に備えてソート
  const sorted = weekList.slice().sort((a, b) => a.to - b.to);
  const lastN = sorted.slice(-lookbackWeeks);
  const before = sorted.slice(0, -lookbackWeeks);

  const [newMap, oldMap] = await Promise.all([
    aggregateRange(user, kind, lastN, { forceRefresh }),
    aggregateRange(user, kind, before, { forceRefresh }),
  ]);

  // old に出てこないものだけ
  const newcomers = [];
  for (const [key, v] of newMap.entries()) {
    if (!oldMap.has(key)) newcomers.push(v);
  }
  newcomers.sort((a, b) => b.count - a.count);
  return newcomers.slice(0, limit);
}
