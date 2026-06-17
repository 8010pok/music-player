/**
 * 統計画面の startIfNeeded / runFetch 等のシナリオ・シミュレーション
 *
 * stats-service.js は IndexedDB / Worker / fetch 等のブラウザ API に依存して
 * いるため、Node.js では直接 import せず、状態遷移ロジックを再現してテストする。
 *
 * 実行: node tests/test-scenario.mjs
 */

let passCount = 0;
let failCount = 0;
const failures = [];

function assert(cond, msg) {
  if (cond) { passCount++; console.log(`  ✓ ${msg}`); }
  else { failCount++; failures.push(msg); console.error(`  ✗ ${msg}`); }
}
function assertEqual(actual, expected, msg) {
  const eq = JSON.stringify(actual) === JSON.stringify(expected);
  if (eq) { passCount++; console.log(`  ✓ ${msg}`); }
  else {
    failCount++;
    const m = `${msg}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`;
    failures.push(m);
    console.error(`  ✗ ${m}`);
  }
}
function describe(name, fn) {
  console.log(`\n=== ${name} ===`);
  return fn();
}

/* ============ stats-service.js の状態遷移を再現する小型シミュレータ ============ */

function emptySections() {
  return { dashboard: null, top: null, compare: null, rewind: null, time: null, loved: null };
}
function emptySectionReady() {
  return { dashboard: false, top: false, compare: false, rewind: false, time: false, loved: false };
}
function allSectionReady() {
  return { dashboard: true, top: true, compare: true, rewind: true, time: true, loved: true };
}
function makeInitialState() {
  return {
    status: "idle", user: null, fetchDate: null,
    sections: emptySections(),
    sectionReady: emptySectionReady(),
    lastCompletedAt: 0,
  };
}
function computeSectionReady(sections) {
  return {
    dashboard: !!sections?.dashboard, top: !!sections?.top,
    compare: !!sections?.compare,   rewind: !!sections?.rewind,
    time: !!sections?.time,          loved: !!sections?.loved,
  };
}
function isAllSectionsPopulated(sections) {
  if (!sections) return false;
  return !!(sections.dashboard && sections.top && sections.compare &&
            sections.rewind && sections.time && sections.loved);
}

/**
 * モック化したシミュレータ：
 *   - IndexedDB は in-memory Map で代替
 *   - 各 fetch* タスクは sectionName を渡すと「fetch 完了して sections に値を入れる」
 *   - 任意のタスクで abort/失敗を注入できる
 */
function makeService() {
  // 状態
  let state = makeInitialState();
  let abortFlag = false;
  const mockIDB = new Map();  // "current" → { user, fetchDate, sections, timestamp }

  // 永続化呼び出しログ (テストで観察できるように)
  const saveLog = [];
  const notifyLog = [];
  function notify() {
    notifyLog.push({
      status: state.status,
      sections: structuredClone(state.sections),
      sectionReady: structuredClone(state.sectionReady),
      fetchDate: state.fetchDate,
    });
  }

  async function saveCurrent({ user, fetchDate, sections, complete }) {
    saveLog.push({
      timestamp: Date.now(),
      sections: structuredClone(sections),
      // 各セクションの「埋まっているか」スナップショット
      readySnapshot: computeSectionReady(sections),
      complete: complete !== false,
    });
    mockIDB.set("current", {
      user, fetchDate,
      sections: structuredClone(sections),
      // 明示的に false のときだけ未完了として記録(省略・true は完了扱い=後方互換)
      complete: complete !== false,
      timestamp: Date.now(),
    });
  }

  async function loadCurrent() {
    return mockIDB.get("current") || null;
  }

  function update(patch) {
    state = { ...state, ...patch };
    notify();
  }
  function updateSection(name, value) {
    state = { ...state, sections: { ...state.sections, [name]: value } };
    notify();
  }

  function getJSTDateString(d = new Date()) {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Tokyo",
      year: "numeric", month: "2-digit", day: "2-digit",
    }).formatToParts(d);
    const y = parts.find((p) => p.type === "year").value;
    const m = parts.find((p) => p.type === "month").value;
    const dd = parts.find((p) => p.type === "day").value;
    return `${y}-${m}-${dd}`;
  }

  /**
   * runFetch を再現したシミュレーション。
   *
   * @param {Object} opts
   * @param {Object} opts.fetchPlan - 各セクションごとの fetch 結果。
   *                                  { dashboard, top, compare, rewind, time, loved }
   *                                  各値: { delayMs, fail, data, abortAt }
   * @param {string[]} opts.completionOrder - 完了順 (例: ["dashboard", "top", ...])
   * @param {Function} opts.onMidway - 全タスク完了前に呼ばれる hook
   */
  async function runFetch(user, { forceRefresh = false, fetchPlan, completionOrder, onMidway } = {}) {
    abortFlag = false;
    const today = getJSTDateString();
    const bufferedMode = !!state.sections.dashboard && state.sectionReady?.dashboard === true;
    const prevSections = bufferedMode ? structuredClone(state.sections) : null;
    const prevSectionReady = bufferedMode ? structuredClone(state.sectionReady) : null;
    // 実コードの runComplete 判定を忠実に再現する:
    //   anyRejected: タスクが reject(genre/world の getAllArtistsOnce 失敗等)
    //   secComplete: time/compare/rewind が resolve しつつ {complete:false} を返した(=反復中断/
    //     範囲失敗/bufferedMode 失敗で前日維持)。これらは reject に出ないため個別シグナルで捕捉。
    //   ※ セクションが「resolve かつ非null かつ complete シグナルを出さない」と完備扱いになる
    //     (rewind の wiring 漏れ等の回帰はこのモデルで complete:true=凍結として検出される)。
    let anyRejected = false;
    const secComplete = { time: true, compare: true, rewind: true };

    if (bufferedMode) {
      update({
        status: "fetching", user, fetchDate: today,
      });
    } else {
      update({
        ...makeInitialState(),
        status: "fetching", user, fetchDate: today,
        sections: emptySections(),
        sectionReady: emptySectionReady(),
      });
    }

    const markReady = (name) => {
      if (state.sectionReady?.[name]) return;
      update({ sectionReady: { ...state.sectionReady, [name]: true } });
    };

    const finalizeSection = (name) => {
      markReady(name);
      // bufferedMode 中は混在データ防止のためスキップ
      if (bufferedMode) return;
      if (!abortFlag && state.sections[name] != null) {
        // 途中保存は complete:false(最終保存が完了時に上書きする)
        saveCurrent({ user, fetchDate: today, sections: state.sections, complete: false });
      }
    };

    let dashboardBaseDone = false;
    let dashboardExtrasDone = false;
    const markDashboardIfReady = () => {
      if (bufferedMode) {
        if (dashboardBaseDone && dashboardExtrasDone) markReady("dashboard");
      } else {
        if (dashboardBaseDone) markReady("dashboard");
      }
    };

    // 完了順に従って各タスクを実行
    for (const sec of completionOrder) {
      if (abortFlag) break;
      const plan = fetchPlan[sec] || { data: {} };
      // fail = reject 相当(anyRejected)。incomplete = time/compare/rewind が resolve しつつ
      // complete:false を返す相当(対応セクションのみシグナル化。それ以外は signal を持たない)。
      if (plan.fail) anyRejected = true;
      if (plan.incomplete && sec in secComplete) secComplete[sec] = false;
      if (plan.abortAt === sec) {
        // 直前で abort 注入
        abortFlag = true;
        break;
      }
      if (!plan.fail) {
        if (sec === "dashboard") {
          // fetchDashboardBase 相当
          updateSection("dashboard", { ...(state.sections.dashboard || {}), ...plan.data });
        } else if (sec === "time") {
          // fetchTimeAndExtras 相当: time セクション + dashboard の dna/quickCards を更新
          if (!bufferedMode || plan.commitInBuffered === false) {
            // 通常モード or buffered で commit しないモードでは、最後に commit
          }
          // バッファモード時は最終 commit のみ反映するが、簡略化のため commit する
          updateSection("time", { snapshot: plan.data?.snapshot || {} });
          const cur = state.sections.dashboard || {};
          updateSection("dashboard", { ...cur, dna: plan.data?.dna || [], quickCards: plan.data?.quickCards || {} });
        } else {
          updateSection(sec, plan.data);
        }
      }
      // 完了時の状態更新（finally 相当）
      if (sec === "dashboard") {
        dashboardBaseDone = true;
        markDashboardIfReady();
        // bufferedMode 中はスキップ
        if (!bufferedMode && !abortFlag && state.sections.dashboard != null) {
          await saveCurrent({ user, fetchDate: today, sections: state.sections, complete: false });
        }
      } else if (sec === "time") {
        dashboardExtrasDone = true;
        markDashboardIfReady();
        finalizeSection("time");
      } else {
        finalizeSection(sec);
      }
      // 半ば hook (例: PWA 終了シミュレーション)
      if (onMidway) {
        const stop = await onMidway(sec, state);
        if (stop === "abort") {
          abortFlag = true;
          break;
        }
      }
    }

    // 結果集計
    if (abortFlag) {
      if (bufferedMode) {
        update({ status: "done", sections: prevSections, sectionReady: prevSectionReady });
      } else {
        update({ status: "idle", sectionReady: emptySectionReady() });
      }
      return { aborted: true };
    }

    update({ status: "done", lastCompletedAt: Date.now() });
    // 実コードの runComplete = !anyRejected && timeComplete && compareComplete && rewindComplete
    //   && isAllSectionsPopulated と同型(各完了条件を独立に AND)。
    const runComplete = !anyRejected && secComplete.time && secComplete.compare && secComplete.rewind &&
      isAllSectionsPopulated(state.sections);
    await saveCurrent({ user, fetchDate: today, sections: state.sections, complete: runComplete });
    return { aborted: false, complete: runComplete };
  }

  async function startIfNeeded(user, fetchPlan, completionOrder, onMidway) {
    const saved = await loadCurrent();
    const today = getJSTDateString();

    if (saved && saved.user === user && saved.fetchDate === today) {
      // complete===false は前回 run が未完了(fail/部分)で保存された印。当日でも再取得する。
      if (isAllSectionsPopulated(saved.sections) && saved.complete !== false) {
        state = {
          ...makeInitialState(), status: "done", user, fetchDate: today,
          sections: saved.sections, sectionReady: allSectionReady(),
          lastCompletedAt: saved.timestamp || 0,
        };
        notify();
        return { skipped: true };
      }
      state = {
        ...makeInitialState(), status: "done", user, fetchDate: today,
        sections: saved.sections || emptySections(),
        sectionReady: computeSectionReady(saved.sections),
        lastCompletedAt: saved.timestamp || 0,
      };
      notify();
    } else if (saved && saved.user === user) {
      state = {
        ...makeInitialState(), status: "done", user, fetchDate: saved.fetchDate,
        sections: saved.sections || emptySections(),
        sectionReady: computeSectionReady(saved.sections),
        lastCompletedAt: saved.timestamp || 0,
      };
      notify();
    }

    return await runFetch(user, { fetchPlan, completionOrder, onMidway });
  }

  return {
    getState: () => state,
    setState: (s) => { state = s; },
    startIfNeeded,
    runFetch,
    saveCurrent,
    loadCurrent,
    mockIDB,
    saveLog,
    notifyLog,
    getJSTDateString,
  };
}

/* ============ 標準的な fetchPlan ============ */

function fullFetchPlan() {
  return {
    dashboard: { data: { userInfo: { name: "User1" }, recent: [{ name: "t1" }], weekSummary: {}, listeningCounts: {} } },
    top:       { data: { byPeriod: { "7day": {} } } },
    compare:   { data: { byRange: { week: {} } } },
    rewind:    { data: { years: [] } },
    time:      { data: { snapshot: { total: 100 }, dna: ["🌙 夜型"], quickCards: { totalHours: 50 } } },
    loved:     { data: { list: [] } },
  };
}

const completionOrder1 = ["dashboard", "top", "compare", "rewind", "time", "loved"];

/* ============ シナリオ 1: 初回ロード ============ */

await describe("シナリオ1: 初回ロード (saved data なし)", async () => {
  const svc = makeService();
  const result = await svc.startIfNeeded("user1", fullFetchPlan(), completionOrder1);
  const final = svc.getState();

  assert(!result.skipped, "skipped=false (再取得が走った)");
  assertEqual(final.status, "done", "完了状態");
  assertEqual(final.user, "user1", "ユーザ設定済");
  assert(isAllSectionsPopulated(final.sections), "全セクション埋め完了");

  // dashboard は最初に ready になっているはず
  // notifyLog から sectionReady.dashboard が true になった最初のタイミングをチェック
  const dashboardReadyIdx = svc.notifyLog.findIndex((s) => s.sectionReady.dashboard === true);
  const topReadyIdx = svc.notifyLog.findIndex((s) => s.sectionReady.top === true);
  assert(dashboardReadyIdx >= 0, "dashboard ready になった");
  assert(dashboardReadyIdx < topReadyIdx, "dashboard ready は top より先");

  // 各セクション完了時に保存されているか (6回 + 最終 = 7回以上)
  assert(svc.saveLog.length >= 6, `保存回数 >= 6 (実際: ${svc.saveLog.length})`);
});

/* ============ シナリオ 2: 同日 + 全揃い → スキップ ============ */

await describe("シナリオ2: 同日全揃い → 再取得スキップ", async () => {
  const svc = makeService();
  const today = svc.getJSTDateString();
  svc.mockIDB.set("current", {
    user: "user1",
    fetchDate: today,
    sections: {
      dashboard: { userInfo: { name: "Saved" } },
      top: { byPeriod: {} }, compare: { byRange: {} },
      rewind: { years: [] }, time: { snapshot: {} }, loved: { list: [] },
    },
    timestamp: Date.now(),
  });

  const result = await svc.startIfNeeded("user1", fullFetchPlan(), completionOrder1);
  const final = svc.getState();

  assert(result.skipped === true, "skipped=true (再取得しない)");
  assertEqual(final.status, "done", "完了状態");
  assertEqual(final.sections.dashboard.userInfo.name, "Saved", "保存データがそのまま使われる");
  assertEqual(final.sectionReady, allSectionReady(), "全 ready");
  assertEqual(svc.saveLog.length, 0, "保存呼び出しなし (再取得していない)");
});

/* ============ シナリオ 3: 同日 + 部分欠損 → 復元 + 再取得 ============ */

await describe("シナリオ3: 同日部分欠損 (前回終了) → バッファ復元 + 再取得", async () => {
  const svc = makeService();
  const today = svc.getJSTDateString();
  svc.mockIDB.set("current", {
    user: "user1",
    fetchDate: today,
    sections: {
      dashboard: { userInfo: { name: "Partial" } },
      top: { byPeriod: {} },
      compare: null,  // 欠損
      rewind: null,   // 欠損
      time: null,     // 欠損
      loved: null,    // 欠損
    },
    timestamp: Date.now(),
  });

  const result = await svc.startIfNeeded("user1", fullFetchPlan(), completionOrder1);
  const final = svc.getState();

  assert(!result.skipped, "skipped=false (再取得実行)");
  assertEqual(final.status, "done", "完了状態");
  assert(isAllSectionsPopulated(final.sections), "再取得で全揃い");

  // 復元直後の notify を確認: sectionReady.dashboard と top のみ true
  const restoredNotify = svc.notifyLog[0];
  assertEqual(restoredNotify.sectionReady.dashboard, true, "復元時 dashboard ready=true");
  assertEqual(restoredNotify.sectionReady.top, true, "復元時 top ready=true");
  assertEqual(restoredNotify.sectionReady.time, false, "復元時 time ready=false");
});

/* ============ シナリオ 4: 別日 → バッファ復元 + 再取得 (bufferedMode) ============ */

await describe("シナリオ4: 別日 → 旧データバッファ表示 + 新データ再取得", async () => {
  const svc = makeService();
  svc.mockIDB.set("current", {
    user: "user1",
    fetchDate: "2025-01-01",  // 古い日付
    sections: {
      dashboard: { userInfo: { name: "Old" } },
      top: { byPeriod: {} }, compare: { byRange: {} },
      rewind: { years: [] }, time: { snapshot: {} }, loved: { list: [] },
    },
    timestamp: Date.now() - 86400000,
  });

  const result = await svc.startIfNeeded("user1", fullFetchPlan(), completionOrder1);
  const final = svc.getState();

  assert(!result.skipped, "skipped=false");
  assertEqual(final.status, "done", "完了状態");

  // 復元直後は旧データ + 全 ready (bufferedMode 開始のため)
  const restoredNotify = svc.notifyLog[0];
  assertEqual(restoredNotify.sections.dashboard.userInfo.name, "Old", "復元時に旧データ表示");
  assertEqual(restoredNotify.sectionReady, allSectionReady(), "復元時に全 ready (bufferedMode 開始)");

  // 最終的に新データへ
  assertEqual(final.sections.dashboard.userInfo.name, "User1", "新データに更新済");

  // bufferedMode 中はダッシュボードの "両方完了" を待つので、
  // dashboardBaseDone のみで dashboard ready=true には変化しないはず（既に true）。
  // → bufferedMode では markDashboardIfReady は両方完了でしか markReady を呼ばないが、
  //    既に true なので markReady はスキップされる。これは正しい挙動。
});

/* ============ シナリオ 5: PWA 終了途中の保存 ============ */

await describe("シナリオ5: PWA 終了途中 (compare 完了後 abort)", async () => {
  const svc = makeService();
  const result = await svc.startIfNeeded(
    "user1", fullFetchPlan(), completionOrder1,
    async (sec, state) => {
      // compare 完了後に PWA 終了を模す
      if (sec === "compare") return "abort";
    }
  );
  // abort 後の状態: 初回ロードだったので status=idle に戻る
  const final = svc.getState();
  assert(result.aborted, "abort された");
  assertEqual(final.status, "idle", "初回 + abort → idle に戻る");

  // 保存ログから、dashboard / top / compare までは保存されているはず
  const lastSave = svc.saveLog[svc.saveLog.length - 1];
  assert(lastSave, "最後の保存ログあり");
  assertEqual(lastSave.readySnapshot.dashboard, true, "abort 時点で dashboard 保存済");
  assertEqual(lastSave.readySnapshot.top, true, "abort 時点で top 保存済");
  assertEqual(lastSave.readySnapshot.compare, true, "abort 時点で compare 保存済");
  assertEqual(lastSave.readySnapshot.rewind, false, "abort 時点で rewind 未保存");
  assertEqual(lastSave.readySnapshot.time, false, "abort 時点で time 未保存");
  assertEqual(lastSave.readySnapshot.loved, false, "abort 時点で loved 未保存");

  // 次回起動を再現: 新しい service で loadCurrent
  const svc2 = makeService();
  svc2.mockIDB.set("current", svc.mockIDB.get("current"));
  // 部分データを保持した状態で再起動
  const result2 = await svc2.startIfNeeded("user1", fullFetchPlan(), completionOrder1);
  assert(!result2.skipped, "次回起動: 部分欠損で再取得実行");
  assertEqual(svc2.getState().status, "done", "次回起動完了");
  assert(isAllSectionsPopulated(svc2.getState().sections), "次回起動で全揃い");
});

/* ============ シナリオ 6: 取得完了順がバラバラ ============ */

await describe("シナリオ6: 取得完了順がバラバラ (各タブ独立 ready)", async () => {
  const svc = makeService();
  // dashboard より先に top が完了する場合（API レスポンス順次第）
  const result = await svc.startIfNeeded(
    "user1", fullFetchPlan(),
    ["top", "compare", "dashboard", "rewind", "loved", "time"]
  );
  const final = svc.getState();
  assertEqual(final.status, "done", "完了");
  assert(isAllSectionsPopulated(final.sections), "全揃い");

  // top が dashboard より先に ready になっているか確認
  const topReadyIdx = svc.notifyLog.findIndex((s) => s.sectionReady.top === true);
  const dashboardReadyIdx = svc.notifyLog.findIndex((s) => s.sectionReady.dashboard === true);
  assert(topReadyIdx < dashboardReadyIdx, "top の完了は dashboard より先 (各タブ独立)");
});

/* ============ シナリオ 7: 手動更新 (refresh) ============ */

await describe("シナリオ7: 手動更新 (refresh 相当)", async () => {
  const svc = makeService();
  // 既に done 状態にする
  svc.setState({
    status: "done", user: "user1", fetchDate: svc.getJSTDateString(),
    sections: {
      dashboard: { userInfo: { name: "Existing" } },
      top: { byPeriod: { "7day": {} } },
      compare: { byRange: {} },
      rewind: { years: [] },
      time: { snapshot: {} },
      loved: { list: [] },
    },
    sectionReady: allSectionReady(),
    lastCompletedAt: Date.now() - 60000,
  });
  // mockIDB もクリア（refresh では clearCurrent + clearCache される）
  svc.mockIDB.clear();
  // refresh = runFetch with forceRefresh
  const result = await svc.runFetch("user1", {
    forceRefresh: true,
    fetchPlan: fullFetchPlan(),
    completionOrder: completionOrder1,
  });
  const final = svc.getState();
  assert(!result.aborted, "refresh 完了");
  assertEqual(final.status, "done", "完了状態");
  // bufferedMode が true で実行されているか
  // (state.sections.dashboard 非null + sectionReady.dashboard=true なので)
  // → 最初の notify では status=fetching に変わるだけで、sections は維持される
  const fetchingNotify = svc.notifyLog.find((s) => s.status === "fetching");
  assertEqual(fetchingNotify.sections.dashboard.userInfo.name, "Existing",
    "refresh 中も既存データ表示 (bufferedMode)");
  // 最終的に新データへ
  assertEqual(final.sections.dashboard.userInfo.name, "User1", "最終的に新データ");
});

/* ============ シナリオ 8: bufferedMode かつダッシュボードのみ完了で PWA 終了 ============ */

await describe("シナリオ8: bufferedMode 中 PWA 終了 → 次回起動", async () => {
  // 前日データあり → bufferedMode で再取得開始 → dashboard 完了直後で PWA 終了
  const svc = makeService();
  svc.mockIDB.set("current", {
    user: "user1",
    fetchDate: "2025-01-01",
    sections: {
      dashboard: { userInfo: { name: "OldData" } },
      top: { byPeriod: {} }, compare: { byRange: {} },
      rewind: { years: [] }, time: { snapshot: {} }, loved: { list: [] },
    },
    timestamp: Date.now() - 86400000,
  });
  await svc.startIfNeeded(
    "user1", fullFetchPlan(), completionOrder1,
    async (sec) => {
      if (sec === "dashboard") return "abort";  // dashboard 完了直後で PWA 終了
    }
  );
  // abort 後、bufferedMode だったので prev に復元される
  assertEqual(svc.getState().status, "done", "bufferedMode abort → done に復元");
  assertEqual(svc.getState().sections.dashboard.userInfo.name, "OldData",
    "abort 時に旧データへ復元");

  // 次回起動を再現: 部分的に新データが保存されている (dashboard だけ更新済)
  // mockIDB の current は dashboard 完了後に save された新データ + 他は前日のまま
  const svc2 = makeService();
  svc2.mockIDB.set("current", svc.mockIDB.get("current"));

  // mockIDB の現在の中身を確認（bufferedMode 中の保存はスキップされるはず）
  const savedAtAbort = svc2.mockIDB.get("current");
  assertEqual(savedAtAbort.sections.dashboard.userInfo.name, "OldData",
    "bufferedMode 中の abort 後も IDB は旧データのまま (混在保存なし)");
  assertEqual(savedAtAbort.fetchDate, "2025-01-01",
    "fetchDate は旧データのまま (今日に書き換わらない)");

  // 次回起動: 別日扱い → 復元 + 再取得 (仕様3, 仕様4 を満たす)
  const result2 = await svc2.startIfNeeded("user1", fullFetchPlan(), completionOrder1);
  assert(!result2.skipped, "bufferedMode abort 後の次回起動: 再取得が走る (仕様3)");
  // 復元直後の表示は旧データ (仕様4)
  const restoredNotify2 = svc2.notifyLog[0];
  assertEqual(restoredNotify2.sections.dashboard.userInfo.name, "OldData",
    "次回起動時に旧データを瞬時表示 (仕様4)");
  assertEqual(svc2.getState().status, "done", "再取得完了");
  assertEqual(svc2.getState().sections.dashboard.userInfo.name, "User1",
    "最終的に新データへ更新");
});

/* ============ シナリオ 9: 非 bufferedMode 中の dashboard 完了直後 abort ============ */

await describe("シナリオ9: 初回ロード dashboard 完了直後 abort → 次回起動", async () => {
  const svc = makeService();
  await svc.startIfNeeded(
    "user1", fullFetchPlan(), completionOrder1,
    async (sec) => {
      if (sec === "dashboard") return "abort";
    }
  );
  // 非 bufferedMode → status=idle に戻る
  assertEqual(svc.getState().status, "idle", "初回 abort → idle");
  // IDB には dashboard が保存されているはず (早期保存)
  const saved = svc.mockIDB.get("current");
  assertEqual(saved.sections.dashboard.userInfo.name, "User1", "dashboard だけ保存済");
  assertEqual(saved.sections.top, null, "他のセクションは null");

  // 次回起動を再現
  const svc2 = makeService();
  svc2.mockIDB.set("current", svc.mockIDB.get("current"));
  const result2 = await svc2.startIfNeeded("user1", fullFetchPlan(), completionOrder1);
  assert(!result2.skipped, "次回起動で再取得実行 (仕様3)");
  // 復元直後: dashboard だけ ready=true
  const restoredNotify = svc2.notifyLog[0];
  assertEqual(restoredNotify.sectionReady.dashboard, true, "復元時 dashboard ready");
  assertEqual(restoredNotify.sectionReady.top, false, "復元時 top not ready");
  assert(isAllSectionsPopulated(svc2.getState().sections), "再取得完了で全揃い");
});

/* ============ シナリオ 10: 当日 run が time 未完了 → complete:false → 同日再起動で再取得 ============ */

await describe("シナリオ10: time 未完了の当日 run → complete:false 保存 → 同日再起動で再取得", async () => {
  const svc = makeService();
  // time だけ「commit するが反復未完了」(iterateCompleted=false 相当)に
  const plan = fullFetchPlan();
  plan.time = { ...plan.time, incomplete: true };
  await svc.startIfNeeded("user1", plan, completionOrder1);
  const saved = svc.mockIDB.get("current");
  assertEqual(saved.complete, false, "未完了 run は complete:false で保存される");
  assert(isAllSectionsPopulated(saved.sections), "(全セクションは非null=旧来は完備扱いされていた)");

  // 同日に再起動 (別サービスインスタンスで同じ IDB レコードを読む)
  const svc2 = makeService();
  svc2.mockIDB.set("current", svc.mockIDB.get("current"));
  const r2 = await svc2.startIfNeeded("user1", fullFetchPlan(), completionOrder1);
  assert(!r2.skipped, "complete:false の当日データは凍結せず再取得される");
  assertEqual(svc2.mockIDB.get("current").complete, true, "再取得が完走すれば complete:true に更新");
});

/* ============ シナリオ 11: 当日 run が完走 → complete:true → 同日再起動はスキップ(回帰防止) ============ */

await describe("シナリオ11: 完走した当日 run → complete:true → 同日再起動はスキップ", async () => {
  const svc = makeService();
  await svc.startIfNeeded("user1", fullFetchPlan(), completionOrder1);
  assertEqual(svc.mockIDB.get("current").complete, true, "完走 run は complete:true");

  const svc2 = makeService();
  svc2.mockIDB.set("current", svc.mockIDB.get("current"));
  const r2 = await svc2.startIfNeeded("user1", fullFetchPlan(), completionOrder1);
  assert(r2.skipped === true, "complete:true の当日データは再取得スキップ(高速表示を維持)");
  assertEqual(svc2.saveLog.length, 0, "スキップ時は保存呼び出しなし");
});

/* ============ シナリオ 12: bufferedMode 更新で1セクション失敗 → complete:false → 同日再起動で再取得 ============ */

await describe("シナリオ12: bufferedMode 更新で1セクション失敗(genre/world reject 相当) → 再取得", async () => {
  const svc = makeService();
  // 1回目: 完走して dashboard+ready を作る(bufferedMode 判定の前提)
  await svc.startIfNeeded("user1", fullFetchPlan(), completionOrder1);
  assertEqual(svc.mockIDB.get("current").complete, true, "1回目は complete:true");

  // 2回目(bufferedMode): loved が fail(reject 相当 → 旧データ維持・commit せず)
  const plan2 = fullFetchPlan();
  plan2.loved = { fail: true };
  await svc.runFetch("user1", { fetchPlan: plan2, completionOrder: completionOrder1 });
  const saved = svc.mockIDB.get("current");
  assertEqual(saved.complete, false, "失敗セクションを含む run は complete:false で保存");
  assert(isAllSectionsPopulated(saved.sections), "(loved は旧データ維持で非null=旧来は完備扱いされていた)");

  // 同日再起動 → 再取得される(古い loved が today 完備として固定されない)
  const svc2 = makeService();
  svc2.mockIDB.set("current", svc.mockIDB.get("current"));
  const r2 = await svc2.startIfNeeded("user1", fullFetchPlan(), completionOrder1);
  assert(!r2.skipped, "失敗セクションを含む当日データは再取得される(凍結しない)");
});

/* ============ シナリオ 13: bufferedMode で振り返り(rewind)失敗 → complete:false → 再取得 ============ */
// ★ このテストは「rewind が reject せず前日値を維持しつつ未完了になった場合は complete:false=
//   同日再取得」という【契約ロジック】を、stats-service.js と同型に再実装したシミュレータ上で検証する。
//   注意: 本ファイルは stats-service.js を import せず状態遷移を再現しているため、実コード側の
//   wiring(restTasks の .then((r)=>rewindComplete=false) 配線や runComplete の AND 項)を直接は
//   検証しない。実 wiring 漏れは node --check + コードレビューで担保する。ここでは「契約が成立すべき」
//   ことを実行可能な形で文書化し、シミュレータ側ロジックの退行を防ぐ。

await describe("シナリオ13: rewind が bufferedMode で失敗 → complete:false → 同日再起動で再取得", async () => {
  const svc = makeService();
  await svc.startIfNeeded("user1", fullFetchPlan(), completionOrder1);
  assertEqual(svc.mockIDB.get("current").complete, true, "1回目は complete:true");

  // 2回目(bufferedMode): rewind が resolve しつつ complete:false(取得失敗→前日維持 相当)
  const plan2 = fullFetchPlan();
  plan2.rewind = { ...plan2.rewind, incomplete: true };
  await svc.runFetch("user1", { fetchPlan: plan2, completionOrder: completionOrder1 });
  assertEqual(svc.mockIDB.get("current").complete, false, "rewind 未完了の run は complete:false");

  const svc2 = makeService();
  svc2.mockIDB.set("current", svc.mockIDB.get("current"));
  const r2 = await svc2.startIfNeeded("user1", fullFetchPlan(), completionOrder1);
  assert(!r2.skipped, "rewind 失敗を含む当日データは再取得される(前日値で凍結しない)");
});

/* ============ シナリオ 14: bufferedMode で比較(compare)の範囲失敗 → complete:false → 再取得 ============ */

await describe("シナリオ14: compare の範囲が失敗 → complete:false → 同日再起動で再取得", async () => {
  const svc = makeService();
  await svc.startIfNeeded("user1", fullFetchPlan(), completionOrder1);

  const plan2 = fullFetchPlan();
  plan2.compare = { ...plan2.compare, incomplete: true };
  await svc.runFetch("user1", { fetchPlan: plan2, completionOrder: completionOrder1 });
  assertEqual(svc.mockIDB.get("current").complete, false, "compare 未完了の run は complete:false");

  const svc2 = makeService();
  svc2.mockIDB.set("current", svc.mockIDB.get("current"));
  const r2 = await svc2.startIfNeeded("user1", fullFetchPlan(), completionOrder1);
  assert(!r2.skipped, "compare 範囲失敗を含む当日データは再取得される");
});

/* ============ 結果 ============ */

console.log("\n" + "=".repeat(60));
console.log(`合計: ${passCount + failCount} / 成功: ${passCount} / 失敗: ${failCount}`);
if (failCount > 0) {
  console.log("\n失敗一覧:");
  failures.forEach((f) => console.log(`  - ${f}`));
  process.exit(1);
} else {
  console.log("全シナリオ成功 ✓");
}
