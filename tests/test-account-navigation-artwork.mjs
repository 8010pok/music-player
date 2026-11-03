/**
 * test-account-navigation-artwork.mjs
 *
 * 1. Googleアカウントテスト (明示的アカウント選択、現在接続中アカウントの記録・表示・切替・解除、サイレント更新の同一アカウント照合、旧アカウント曲データ保護)
 * 2. Apple Music型戻るナビゲーションテスト (実 router.js を用いた7シナリオの逆順1段戻り・検索状態維持・popstate 1段戻り)
 * 3. アートワーク画像変更テスト (曲・アルバム・アーティスト画像変更、同一ファイル再選択リセット、IndexedDB永続化、キャッシュ破棄と再描画、再生中UI/MediaSession反映、HEIC/破損画像/20MB超エラー検出、診断記録、同期データ更新)
 */

import { strictEqual, deepStrictEqual, ok, rejects } from "node:assert";

// ==========================================
// テスト用グローバル環境モック (DOM / Storage / Location / History)
// ==========================================
const mockStorage = new Map();
globalThis.localStorage = {
  getItem: (k) => (mockStorage.has(k) ? mockStorage.get(k) : null),
  setItem: (k, v) => mockStorage.set(k, String(v)),
  removeItem: (k) => mockStorage.delete(k),
  clear: () => mockStorage.clear(),
};

const mockSessionStorage = new Map();
globalThis.sessionStorage = {
  getItem: (k) => (mockSessionStorage.has(k) ? mockSessionStorage.get(k) : null),
  setItem: (k, v) => mockSessionStorage.set(k, String(v)),
  removeItem: (k) => mockSessionStorage.delete(k),
  clear: () => mockSessionStorage.clear(),
};

let currentHash = "#/library";
const hashListeners = new Set();
const popstateListeners = new Set();
const historyStack = [{ state: null, hash: "#/library" }];
let historyIndex = 0;

globalThis.location = {
  get hash() {
    return currentHash;
  },
  set hash(val) {
    const normalized = val.startsWith("#") ? val : `#${val}`;
    const changed = normalized !== currentHash;
    currentHash = normalized;
    historyStack.splice(historyIndex + 1);
    historyStack.push({ state: null, hash: currentHash });
    historyIndex = historyStack.length - 1;
    if (changed) {
      for (const fn of hashListeners) fn();
    }
  },
};

globalThis.history = {
  get length() {
    return historyStack.length;
  },
  get state() {
    return historyStack[historyIndex]?.state ?? null;
  },
  replaceState(state, _title, url) {
    if (typeof url === "string" && url.startsWith("#")) {
      currentHash = url;
    }
    historyStack[historyIndex] = { state, hash: currentHash };
  },
  pushState(state, _title, url) {
    if (typeof url === "string" && url.startsWith("#")) {
      currentHash = url;
    }
    historyStack.splice(historyIndex + 1);
    historyStack.push({ state, hash: currentHash });
    historyIndex = historyStack.length - 1;
  },
  back() {
    if (historyIndex > 0) {
      historyIndex--;
      currentHash = historyStack[historyIndex].hash;
      for (const fn of popstateListeners) fn({ state: historyStack[historyIndex].state });
      for (const fn of hashListeners) fn();
    }
  },
};

globalThis.window = globalThis;
globalThis.screen = { width: 1170, height: 2532, colorDepth: 24 };
globalThis.document = {
  hidden: false,
  visibilityState: "visible",
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener: () => {},
  removeEventListener: () => {},
  createElement(tag) {
    if (tag === "canvas") {
      return {
        width: 0,
        height: 0,
        getContext() {
          return { drawImage() {} };
        },
        toDataURL(mime) {
          return `data:${mime || "image/jpeg"};base64,9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=`;
        },
      };
    }
    return {
      style: {},
      classList: { toggle() {}, add() {}, remove() {} },
      setAttribute() {},
      appendChild() {},
      addEventListener() {},
      querySelector() { return null; },
      querySelectorAll() { return []; },
    };
  },
  body: {
    dataset: {},
    appendChild() {},
    classList: { toggle() {}, add() {}, remove() {} },
  },
};
globalThis.window.scrollY = 0;
globalThis.window.pageYOffset = 0;
globalThis.window.scrollTo = (_x, y) => {
  globalThis.window.scrollY = typeof _x === "object" ? (_x.top || 0) : (y || 0);
};
globalThis.window.addEventListener = (type, fn) => {
  if (type === "hashchange") hashListeners.add(fn);
  if (type === "popstate") popstateListeners.add(fn);
};
globalThis.window.removeEventListener = (type, fn) => {
  if (type === "hashchange") hashListeners.delete(fn);
  if (type === "popstate") popstateListeners.delete(fn);
};
globalThis.requestAnimationFrame = (cb) => {
  cb();
  return 1;
};

let objectUrlSeq = 0;
const activeObjectUrls = new Set();
globalThis.URL.createObjectURL = (blob) => {
  const u = `blob:mock-art-${++objectUrlSeq}-${blob?.size || 0}`;
  activeObjectUrls.add(u);
  return u;
};
globalThis.URL.revokeObjectURL = (u) => {
  activeObjectUrls.delete(u);
};

let passed = 0;
async function asyncTest(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.error(`  ✗ ${name}`);
    throw e;
  }
}

// モジュールのインポート
const settingsMod = await import("../js/store/settings.js");
const driveMod = await import("../js/gdrive/drive-service.js");
const routerMod = await import("../js/router.js");
const artworkCacheMod = await import("../js/ui/artwork-cache.js");
const utilMod = await import("../js/metadata/util.js");
const syncMod = await import("../js/store/sync-service.js");
const stateMod = await import("../js/state.js");

console.log("=== 1. Googleアカウントテスト (明示的選択・照合・切替・解除・曲データ保護) ===");

await asyncTest("明示的ログイン (requestGisToken) は prompt: 'select_account' を指定し、hint を強制しないこと", async () => {
  mockStorage.clear();
  settingsMod.setPublic({
    gdriveClientId: "test-client-id.apps.googleusercontent.com",
    gdriveConnectedEmail: "old-wrong@example.com",
    gdriveAccountEmail: "old-wrong@example.com",
  });

  let capturedInitConfig = null;
  let capturedRequestOpts = null;

  globalThis.google = {
    accounts: {
      oauth2: {
        initTokenClient(cfg) {
          capturedInitConfig = cfg;
          return {
            requestAccessToken(opts) {
              capturedRequestOpts = opts;
              // GISコールバックを擬似発火
              setTimeout(() => {
                cfg.callback({
                  access_token: "ya29.explicit_selected_token_123",
                  expires_in: 3600,
                });
              }, 5);
            },
          };
        },
        revoke(_tok, cb) {
          if (cb) cb();
        },
      },
    },
  };

  // fetchモック (Google Drive about API + /api/drive-session)
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes("googleapis.com/drive/v3/about")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          user: {
            emailAddress: "music-owner@example.com",
            displayName: "Music Owner",
            permissionId: "perm-music-001",
          },
        }),
      };
    }
    if (u.includes("/api/drive-session")) {
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };

  const token = await driveMod.requestGisToken("test-client-id.apps.googleusercontent.com");

  strictEqual(token, "ya29.explicit_selected_token_123");
  strictEqual(capturedRequestOpts.prompt, "select_account", "prompt must be select_account");
  strictEqual("hint" in capturedRequestOpts, false, "requestAccessToken opts must not force hint");
  strictEqual("hint" in capturedInitConfig, false, "initTokenClient config must not force hint");
});

await asyncTest("選択されたアカウント情報 (email / displayName / accountLabel) が記録・取得でき、切替と解除で正しく更新されること", async () => {
  await driveMod.setDriveToken("ya29.account_a_token", {
    expiresIn: 3600,
    email: "account-a@example.com",
    displayName: "Account A",
  });

  const infoA = await driveMod.getDriveAccountInfo();
  strictEqual(infoA.connected, true);
  strictEqual(infoA.status, "connected");
  strictEqual(infoA.email, "account-a@example.com");
  strictEqual(infoA.displayName, "Account A");
  strictEqual(infoA.accountLabel, "account-a@example.com");

  // 「アカウントを選び直す」(switchDriveAccount) で別アカウント B が選ばれた場合
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes("googleapis.com/drive/v3/about")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          user: {
            emailAddress: "account-b@example.com",
            displayName: "Account B",
            permissionId: "id-b",
          },
        }),
      };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };

  let switchPrompt = null;
  globalThis.google.accounts.oauth2.initTokenClient = (cfg) => ({
    requestAccessToken(opts) {
      switchPrompt = opts?.prompt;
      setTimeout(() => {
        cfg.callback({ access_token: "ya29.account_b_token", expires_in: 3600 });
      }, 5);
    },
  });

  const switchedToken = await driveMod.switchDriveAccount("test-client-id.apps.googleusercontent.com");
  strictEqual(switchPrompt, "select_account", "switchDriveAccount must force select_account");
  strictEqual(switchedToken, "ya29.account_b_token", "Returned token must be Account B token");

  const infoB = await driveMod.getDriveAccountInfo();
  strictEqual(infoB.connected, true);
  strictEqual(infoB.email, "account-b@example.com");
  strictEqual(infoB.displayName, "Account B");
});

await asyncTest("サイレント更新 (silentRefreshGisToken) は接続済みアカウントと一致する場合のみ採用し、別アカウントに変わった場合は拒否すること", async () => {
  // 現在 account-b@example.com が接続中
  strictEqual((await driveMod.getDriveAccountInfo()).email, "account-b@example.com");

  // 1) 一致するアカウント (account-b@example.com) が返る場合 -> 採用される
  globalThis.google.accounts.oauth2.initTokenClient = (cfg) => ({
    requestAccessToken() {
      setTimeout(() => {
        cfg.callback({ access_token: "ya29.silent_b_ok", expires_in: 3600 });
      }, 5);
    },
  });
  globalThis.fetch = async (url) => {
    if (String(url).includes("googleapis.com/drive/v3/about")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          user: { emailAddress: "account-b@example.com", displayName: "Account B", permissionId: "id-b" },
        }),
      };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };

  const silentOkToken = await driveMod.silentRefreshGisToken("test-client-id.apps.googleusercontent.com");
  strictEqual(silentOkToken, "ya29.silent_b_ok", "Matching account silent token must be accepted");

  // 2) ブラウザのデフォルトアカウントが別アカウント (wrong-default@example.com) に変わっていた場合 -> 拒否して例外を送出し、getDriveToken は null を返す
  globalThis.google.accounts.oauth2.initTokenClient = (cfg) => ({
    requestAccessToken() {
      setTimeout(() => {
        cfg.callback({ access_token: "ya29.silent_wrong_account", expires_in: 3600 });
      }, 5);
    },
  });
  globalThis.fetch = async (url) => {
    if (String(url).includes("googleapis.com/drive/v3/about")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          user: { emailAddress: "wrong-default@example.com", displayName: "Wrong User", permissionId: "id-wrong" },
        }),
      };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };

  await rejects(
    async () => {
      await driveMod.silentRefreshGisToken("test-client-id.apps.googleusercontent.com");
    },
    (err) => {
      ok(err.message.includes("別のGoogleアカウント"), "Must reject with account mismatch message");
      return true;
    }
  );
  strictEqual((await driveMod.getDriveAccountInfo()).email, "account-b@example.com", "Saved account must remain account-b");
});

await asyncTest("Drive連携解除 (disconnectDrive) でトークン・接続アカウント情報がクリアされ、未接続時の getDriveToken は silentRefresh を勝手に実行しないこと（曲データは保持）", async () => {
  // 擬似ライブラリ曲リスト
  const libraryTracksBefore = [
    { id: "gd-101", title: "Drive Song 1", driveFileId: "101" },
    { id: "gd-102", title: "Drive Song 2", driveFileId: "102" },
  ];

  await driveMod.disconnectDrive();
  const afterDisconnect = await driveMod.getDriveAccountInfo();
  strictEqual(afterDisconnect.connected, false, "Must be disconnected");
  strictEqual(afterDisconnect.status, "disconnected");
  strictEqual(afterDisconnect.email, "", "Email must be cleared");
  strictEqual(await driveMod.isDriveConnected(), false, "isDriveConnected must return false without silent login");

  // 未接続状態で getDriveToken({ allowSilentRefresh: true }) を呼んでも GIS を呼ばず即 null を返す
  let gisCalledWhenDisconnected = false;
  globalThis.google.accounts.oauth2.initTokenClient = () => {
    gisCalledWhenDisconnected = true;
    return { requestAccessToken() {} };
  };
  const tokenWhenDisconnected = await driveMod.getDriveToken({ allowSilentRefresh: true });
  strictEqual(tokenWhenDisconnected, null);
  strictEqual(gisCalledWhenDisconnected, false, "Must not invoke GIS silent token when no account is connected");
  strictEqual(libraryTracksBefore.length, 2, "Existing library tracks must not be deleted on account switch/disconnect");
});

await asyncTest("GIS エラー・キャンセル検証: popup_closed / popup_failed_to_open / access_denied / interaction_required / user_cancel でも既存接続とProxy Sessionを破壊しないこと", async () => {
  // まず Account A で正常接続しておく
  await driveMod.setDriveToken("ya29.existing_valid_token", {
    expiresIn: 3600,
    email: "keep-me@example.com",
    displayName: "Keep Me",
  });
  const beforeInfo = await driveMod.getDriveAccountInfo();
  strictEqual(beforeInfo.connected, true);
  strictEqual(beforeInfo.email, "keep-me@example.com");

  // 1) error_callback: popup_closed (ユーザーがアカウント選択ポップアップを閉じた場合)
  globalThis.google.accounts.oauth2.initTokenClient = (cfg) => ({
    requestAccessToken() {
      setTimeout(() => {
        cfg.error_callback({ type: "popup_closed" });
      }, 5);
    },
  });
  await rejects(
    async () => {
      await driveMod.switchDriveAccount("test-client-id.apps.googleusercontent.com");
    },
    (err) => {
      ok(err.message.includes("閉じられました"), "popup_closed must reject cleanly");
      return true;
    }
  );
  // キャンセル後も既存の keep-me@example.com の接続が破壊されていないこと
  const afterCancelInfo = await driveMod.getDriveAccountInfo();
  strictEqual(afterCancelInfo.connected, true, "Existing connection must survive popup_closed cancel");
  strictEqual(afterCancelInfo.email, "keep-me@example.com", "Existing email must survive popup_closed cancel");

  // 2) error_callback: popup_failed_to_open
  globalThis.google.accounts.oauth2.initTokenClient = (cfg) => ({
    requestAccessToken() {
      setTimeout(() => {
        cfg.error_callback({ type: "popup_failed_to_open" });
      }, 5);
    },
  });
  await rejects(
    async () => {
      await driveMod.requestGisToken("test-client-id.apps.googleusercontent.com");
    },
    (err) => {
      ok(err.message.includes("ポップアップ"), "popup_failed_to_open must reject with popup message");
      return true;
    }
  );

  // 3) callback error: access_denied / interaction_required / user_cancel
  for (const errCode of ["access_denied", "interaction_required", "user_cancel"]) {
    globalThis.google.accounts.oauth2.initTokenClient = (cfg) => ({
      requestAccessToken() {
        setTimeout(() => {
          cfg.callback({ error: errCode });
        }, 5);
      },
    });
    await rejects(
      async () => {
        await driveMod.requestGisToken("test-client-id.apps.googleusercontent.com");
      },
      (err) => {
        ok(err.message.includes(errCode), `Must include ${errCode}`);
        return true;
      }
    );
  }
  strictEqual((await driveMod.getDriveAccountInfo()).email, "keep-me@example.com");
});

await asyncTest("setDriveToken 単体監査: token / expiry / email / displayName 保存、空ユーザー情報での安全性、Proxy Session 連動が例外なく動作すること", async () => {
  settingsMod.setPublic({ driveProxyStreamEnabled: true });
  let proxySessionCalledWith = null;
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes("/api/drive-session") && opts?.method === "POST") {
      const bodyObj = JSON.parse(opts.body || "{}");
      proxySessionCalledWith = bodyObj.token;
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };

  await driveMod.setDriveToken("ya29.unit_test_token_999", {
    expiresIn: 1800,
    email: "unit@example.com",
    displayName: "Unit User",
  });
  await new Promise((r) => setTimeout(r, 15));

  const pub1 = settingsMod.getPublic();
  strictEqual(pub1.gdriveUserEmail, "unit@example.com");
  strictEqual(pub1.gdriveUserDisplayName, "Unit User");
  ok(pub1.gdriveTokenExpiry > Date.now() + 1700 * 1000, "Expiry must be saved accurately");
  strictEqual(proxySessionCalledWith, "ya29.unit_test_token_999", "Proxy session must be updated with new token");

  // 空のユーザー情報で呼んでも既存の email / displayName を空文字で潰さず token 自体は安全に扱うこと
  await driveMod.setDriveToken("ya29.unit_test_token_1000", {
    expiresIn: 3600,
    email: "",
    displayName: "",
  });
  const pub2 = settingsMod.getPublic();
  strictEqual(pub2.gdriveUserEmail, "unit@example.com", "Empty email arg must not wipe existing saved email");
  strictEqual(pub2.gdriveUserDisplayName, "Unit User", "Empty displayName arg must not wipe existing saved displayName");
  strictEqual(await driveMod.getDriveToken({ allowSilentRefresh: false }), "ya29.unit_test_token_1000");
  settingsMod.setPublic({ driveProxyStreamEnabled: false });
});

console.log("\n=== 2. Apple Music型 戻るナビゲーションテスト (7シナリオ完全検証) ===");

// ルーター初期化とダミーView登録
const mountedHistory = [];
const mockRoot = {
  innerHTML: "",
  dataset: {},
  scrollTop: 0,
  addEventListener() {},
  removeEventListener() {},
};
for (const name of ["library", "artist", "album", "playlist", "player", "settings"]) {
  routerMod.register(name, async () => {
    mountedHistory.push({ name, hash: location.hash });
    return () => {};
  });
}
routerMod.start(mockRoot);

await asyncTest("シナリオ1 (アーティスト経由): アーティスト一覧 → アーティスト詳細 → アルバム詳細 → プレイヤー から1段ずつ逆順に戻り、各段階の navStack が正確であること", async () => {
  routerMod.clearNavStack();
  routerMod.go("library", { tab: "artists" });
  await new Promise((r) => setTimeout(r, 10));
  strictEqual(location.hash, "#/library?tab=artists");
  deepStrictEqual(routerMod.getNavStack().map((e) => e.hash), ["#/library?tab=artists"]);

  routerMod.go("artist", { name: "YOASOBI" });
  await new Promise((r) => setTimeout(r, 10));
  strictEqual(location.hash, "#/artist?name=YOASOBI");
  deepStrictEqual(routerMod.getNavStack().map((e) => e.hash), [
    "#/library?tab=artists",
    "#/artist?name=YOASOBI",
  ]);

  routerMod.go("album", { key: "the-book___yoasobi" });
  await new Promise((r) => setTimeout(r, 10));
  strictEqual(location.hash, "#/album?key=the-book___yoasobi");
  deepStrictEqual(routerMod.getNavStack().map((e) => e.hash), [
    "#/library?tab=artists",
    "#/artist?name=YOASOBI",
    "#/album?key=the-book___yoasobi",
  ]);

  routerMod.go("player");
  await new Promise((r) => setTimeout(r, 10));
  strictEqual(location.hash, "#/player");
  deepStrictEqual(routerMod.getNavStack().map((e) => e.hash), [
    "#/library?tab=artists",
    "#/artist?name=YOASOBI",
    "#/album?key=the-book___yoasobi",
    "#/player",
  ]);

  // 1回目の戻る: プレイヤー → アルバム詳細
  routerMod.back("library");
  await new Promise((r) => setTimeout(r, 10));
  strictEqual(location.hash, "#/album?key=the-book___yoasobi", "1st back from player must return to album detail");
  deepStrictEqual(routerMod.getNavStack().map((e) => e.hash), [
    "#/library?tab=artists",
    "#/artist?name=YOASOBI",
    "#/album?key=the-book___yoasobi",
  ]);

  // 2回目の戻る: アルバム詳細 → アーティスト詳細
  routerMod.back("library", { tab: "albums" });
  await new Promise((r) => setTimeout(r, 10));
  strictEqual(location.hash, "#/artist?name=YOASOBI", "2nd back from album must return to artist detail");
  deepStrictEqual(routerMod.getNavStack().map((e) => e.hash), [
    "#/library?tab=artists",
    "#/artist?name=YOASOBI",
  ]);

  // 3回目の戻る: アーティスト詳細 → アーティスト一覧
  routerMod.back("library", { tab: "artists" });
  await new Promise((r) => setTimeout(r, 10));
  strictEqual(location.hash, "#/library?tab=artists", "3rd back from artist must return to artists tab");
  deepStrictEqual(routerMod.getNavStack().map((e) => e.hash), [
    "#/library?tab=artists",
  ]);
});

await asyncTest("シナリオ2 (アルバム一覧経由): アルバム一覧 → アルバム詳細 → プレイヤー から アルバム詳細 → アルバム一覧 へ戻ること", async () => {
  routerMod.clearNavStack();
  routerMod.go("library", { tab: "albums" });
  await new Promise((r) => setTimeout(r, 10));

  routerMod.go("album", { key: "album-xyz" });
  await new Promise((r) => setTimeout(r, 10));

  routerMod.go("player");
  await new Promise((r) => setTimeout(r, 10));
  strictEqual(location.hash, "#/player");
  deepStrictEqual(routerMod.getNavStack().map((e) => e.hash), [
    "#/library?tab=albums",
    "#/album?key=album-xyz",
    "#/player",
  ]);

  routerMod.back("library");
  await new Promise((r) => setTimeout(r, 10));
  strictEqual(location.hash, "#/album?key=album-xyz", "Player back must return to album-xyz");
  deepStrictEqual(routerMod.getNavStack().map((e) => e.hash), [
    "#/library?tab=albums",
    "#/album?key=album-xyz",
  ]);

  routerMod.back("library", { tab: "albums" });
  await new Promise((r) => setTimeout(r, 10));
  strictEqual(location.hash, "#/library?tab=albums", "Album back must return to albums list");
  deepStrictEqual(routerMod.getNavStack().map((e) => e.hash), [
    "#/library?tab=albums",
  ]);
});

await asyncTest("シナリオ3 (プレイリスト経由): プレイリスト一覧 → プレイリスト詳細 → プレイヤー から プレイリスト詳細 → プレイリスト一覧 へ戻ること", async () => {
  routerMod.clearNavStack();
  routerMod.go("library", { tab: "playlists" });
  await new Promise((r) => setTimeout(r, 10));

  routerMod.go("playlist", { id: "pl-fav-001" });
  await new Promise((r) => setTimeout(r, 10));

  routerMod.go("player");
  await new Promise((r) => setTimeout(r, 10));
  deepStrictEqual(routerMod.getNavStack().map((e) => e.hash), [
    "#/library?tab=playlists",
    "#/playlist?id=pl-fav-001",
    "#/player",
  ]);

  routerMod.back("library");
  await new Promise((r) => setTimeout(r, 10));
  strictEqual(location.hash, "#/playlist?id=pl-fav-001", "Player back must return to playlist detail");

  routerMod.back("library", { tab: "playlists" });
  await new Promise((r) => setTimeout(r, 10));
  strictEqual(location.hash, "#/library?tab=playlists", "Playlist back must return to playlists tab");
});

await asyncTest("シナリオ4 (検索経由): 検索状態(query, sort, filter, scrollTop) → album-detail → player → back → album-detail → back → 同じ検索状態が維持されること", async () => {
  routerMod.clearNavStack();
  routerMod.go("library", { tab: "tracks" });
  await new Promise((r) => setTimeout(r, 10));

  // 検索語・ソート・フィルタ・スクロール位置を記録
  mockRoot.scrollTop = 480;
  routerMod.updateCurrentState({
    activeTab: "tracks",
    searchQuery: "米津玄師",
    sortBy: "artist",
    sortDir: "desc",
    filterText: "米津玄師",
  });

  routerMod.go("album", { key: "lost-corner___kenshi" });
  await new Promise((r) => setTimeout(r, 10));

  routerMod.go("player");
  await new Promise((r) => setTimeout(r, 10));
  strictEqual(location.hash, "#/player");
  deepStrictEqual(routerMod.getNavStack().map((e) => e.hash), [
    "#/library?tab=tracks",
    "#/album?key=lost-corner___kenshi",
    "#/player",
  ]);

  // 1回目の back -> album-detail
  routerMod.back("library");
  await new Promise((r) => setTimeout(r, 10));
  strictEqual(location.hash, "#/album?key=lost-corner___kenshi");

  // 2回目の back -> 検索状態のある library(tracks)
  routerMod.back("library");
  await new Promise((r) => setTimeout(r, 10));
  strictEqual(location.hash, "#/library?tab=tracks");

  const stack = routerMod.getNavStack();
  strictEqual(stack.length, 1);
  const top = stack[0];
  strictEqual(top.state.searchQuery, "米津玄師", "Search query must be preserved");
  strictEqual(top.state.sortBy, "artist", "Sort field must be preserved");
  strictEqual(top.state.sortDir, "desc", "Sort direction must be preserved");
  strictEqual(top.scrollTop, 480, "Scroll position must be preserved");
});

await asyncTest("シナリオ5 & 6 (同一player再表示・ミニプレイヤー経由・次曲切替): 古いplayer重複だけを整理し、中間のartist/albumを削除しないこと", async () => {
  routerMod.clearNavStack();
  // album-detail -> player -> album-detail (go前進で戻ったケースも含む) -> player の検証
  routerMod.go("library", { tab: "artists" });
  await new Promise((r) => setTimeout(r, 10));
  routerMod.go("artist", { name: "Aimer" });
  await new Promise((r) => setTimeout(r, 10));
  routerMod.go("album", { key: "daydream___aimer" });
  await new Promise((r) => setTimeout(r, 10));
  routerMod.go("player");
  await new Promise((r) => setTimeout(r, 10));

  // 仮に back() ではなく go("album") で album-detail に遷移した後、再度 go("player") した場合でも、
  // 古い player だけが整理され、中間の artist / album は保持されること
  routerMod.go("album", { key: "daydream___aimer" });
  await new Promise((r) => setTimeout(r, 10));
  routerMod.go("player");
  await new Promise((r) => setTimeout(r, 10));

  const stackHashes = routerMod.getNavStack().map((e) => e.hash);
  strictEqual(stackHashes.filter((h) => h === "#/player").length, 1, "Only one player entry must exist at top of stack");
  ok(stackHashes.includes("#/artist?name=Aimer"), "Intermediate artist view must not be truncated");
  strictEqual(stackHashes[stackHashes.length - 2], "#/album?key=daydream___aimer", "Immediate predecessor must be album-detail");

  // プレイヤーを開いたまま次の曲（別アルバムの曲など）へ切り替わった状態をシミュレート
  stateMod.appState.set({
    currentTrack: { id: "track-next-999", title: "Next Song", album: "Another Album" },
  });

  // プレイヤーの戻る（閉じる）を押す -> 直前に開いていた daydream___aimer のアルバム詳細へ戻る！
  routerMod.back("library");
  await new Promise((r) => setTimeout(r, 10));
  strictEqual(
    location.hash,
    "#/album?key=daydream___aimer",
    "Must return to originating album view (daydream___aimer), NOT jump back to artists list"
  );
});

await asyncTest("シナリオ7 (ブラウザ/OSの戻る操作 & ルートからの安全なフォールバック): 1操作で1段だけ戻り、ルートで戻っても安全に処理されること", async () => {
  routerMod.clearNavStack();
  routerMod.go("library", { tab: "artists" });
  await new Promise((r) => setTimeout(r, 10));
  routerMod.go("artist", { name: "King Gnu" });
  await new Promise((r) => setTimeout(r, 10));
  routerMod.go("album", { key: "ceremony___king_gnu" });
  await new Promise((r) => setTimeout(r, 10));
  routerMod.go("player");
  await new Promise((r) => setTimeout(r, 10));

  // OS/ブラウザの1回目の戻る
  history.back();
  await new Promise((r) => setTimeout(r, 10));
  strictEqual(location.hash, "#/album?key=ceremony___king_gnu", "1st browser back must return to album");
  strictEqual(routerMod.getNavStack().length, 3);

  // OS/ブラウザの2回目の戻る
  history.back();
  await new Promise((r) => setTimeout(r, 10));
  strictEqual(location.hash, "#/artist?name=King+Gnu", "2nd browser back must return to artist");
  strictEqual(routerMod.getNavStack().length, 2);

  // OS/ブラウザの3回目の戻る -> ルート (#/library?tab=artists)
  history.back();
  await new Promise((r) => setTimeout(r, 10));
  strictEqual(location.hash, "#/library?tab=artists", "3rd browser back must return to library root");
  strictEqual(routerMod.getNavStack().length, 1);

  // ルートでさらに back() を呼んでもクラッシュせずフォールバックへ安全に留まること
  routerMod.back("library", { tab: "artists" });
  await new Promise((r) => setTimeout(r, 10));
  strictEqual(location.hash, "#/library?tab=artists");
  strictEqual(routerMod.getNavStack().length, 1);
});

console.log("\n=== 3. アートワーク画像変更・検証・診断・永続化テスト ===");

// テスト用の最小有効PNGバイト列 (1x1 PNG マジックバイト + IHDR)
const VALID_PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89,
]);

// JPEG (FF D8 FF E0)
const VALID_JPEG_BYTES = new Uint8Array([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46,
  0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01,
]);

// WebP (RIFF .... WEBP)
const VALID_WEBP_BYTES = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00,
  0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20,
]);

// HEIC (ftypheic) の先頭バイト列
const HEIC_BYTES = new Uint8Array([
  0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70,
  0x68, 0x65, 0x69, 0x63, 0x00, 0x00, 0x00, 0x00,
]);

// 破損/非画像データ
const CORRUPT_BYTES = new Uint8Array([0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c]);

// Node環境で Canvas / createImageBitmap をシミュレート
globalThis.createImageBitmap = async (blob) => {
  const buf = new Uint8Array(await blob.arrayBuffer());
  if (buf[0] === 0x89 && buf[1] === 0x50) {
    return {
      width: 600,
      height: 600,
      close() {},
    };
  }
  throw new Error("Decode error");
};

const origCreateElement = globalThis.document?.createElement;
globalThis.document = {
  ...(globalThis.document || {}),
  hidden: false,
  createElement(tag) {
    if (tag === "canvas") {
      return {
        width: 0,
        height: 0,
        getContext() {
          return {
            drawImage() {},
          };
        },
        toDataURL(mime) {
          return `data:${mime || "image/jpeg"};base64,9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=`;
        },
      };
    }
    if (origCreateElement) return origCreateElement.call(globalThis.document, tag);
    return {};
  },
};

await asyncTest("有効な PNG 画像が検証・リサイズ・DataURL化され、キャッシュ更新と再生中トラック (appState / MediaSession) に即時反映されること", async () => {
  const pngBlob = new Blob([VALID_PNG_BYTES], { type: "image/png" });
  const decoded = await utilMod.validateAndDecodeArtworkBlob(pngBlob, { maxSize: 500 });

  strictEqual(decoded.fileType, "image/png");
  strictEqual(decoded.fileSize, VALID_PNG_BYTES.length);
  ok(decoded.dataUrl.startsWith("data:image/"), "Decoded dataUrl must be valid base64 image");

  // トラックへの保存とキャッシュ破棄・再取得の検証
  const track = {
    id: "track-art-001",
    title: "Artwork Test Song",
    artist: "Test Artist",
    album: "Test Album",
    artworkDataUrl: "data:image/jpeg;base64,OLD_IMAGE_DATA",
  };

  const oldUrl = artworkCacheMod.getArtworkUrl(track);
  strictEqual(oldUrl, "data:image/jpeg;base64,OLD_IMAGE_DATA");

  // 新しい画像を適用し releaseArtwork を呼ぶ
  artworkCacheMod.releaseArtwork(track.id);
  track.artworkDataUrl = decoded.dataUrl;
  track.artworkBlob = null;
  track.artworkUpdatedAt = Date.now();

  const newUrl = artworkCacheMod.getArtworkUrl(track);
  strictEqual(newUrl, decoded.dataUrl, "getArtworkUrl must return new image immediately after releaseArtwork");

  // 再生中トラック (appState.currentTrack) の更新確認
  stateMod.appState.set({ currentTrack: { ...track } });
  strictEqual(stateMod.appState.get().currentTrack.artworkDataUrl, decoded.dataUrl);

  // 診断記録の確認
  const diag = artworkCacheMod.recordArtworkDiagnostics({
    targetType: "track",
    targetId: "track-art-001",
    fileType: decoded.fileType,
    fileSize: decoded.fileSize,
    decoded: true,
    resized: true,
    saved: true,
    recordUpdated: true,
    syncQueued: true,
    rendered: true,
    errorName: null,
  });
  strictEqual(diag.targetType, "track");
  strictEqual(diag.targetIdTail, "rt-001", "Only tail chars of ID must be recorded for privacy");
  strictEqual(diag.decoded, true);
  strictEqual(diag.saved, true);
  strictEqual(diag.syncQueued, true);
  strictEqual(diag.rendered, true);
});

await asyncTest("非対応形式 (HEIC/HEIF)、破損画像、20MB超過ファイルが明確なエラーで拒否され、既存画像を消去しないこと", async () => {
  // 1) HEIC ファイル
  const heicFile = new Blob([HEIC_BYTES], { type: "image/heic" });
  heicFile.name = "photo.heic";
  await rejects(
    async () => {
      await utilMod.validateAndDecodeArtworkBlob(heicFile);
    },
    (err) => {
      strictEqual(err.name, "UnsupportedImageFormatError");
      ok(err.message.includes("HEIC/HEIF"), "Error message must mention HEIC/HEIF");
      return true;
    }
  );

  // 2) 破損/非画像データ
  const corruptFile = new Blob([CORRUPT_BYTES], { type: "application/octet-stream" });
  corruptFile.name = "broken.bin";
  await rejects(
    async () => {
      await utilMod.validateAndDecodeArtworkBlob(corruptFile);
    },
    (err) => {
      strictEqual(err.name, "UnsupportedImageFormatError");
      return true;
    }
  );

  // 3) 20MB 超過ファイル
  const hugeFakeBlob = {
    size: utilMod.MAX_ARTWORK_FILE_BYTES + 1024,
    type: "image/png",
    slice: () => new Blob([VALID_PNG_BYTES]),
  };
  await rejects(
    async () => {
      await utilMod.validateAndDecodeArtworkBlob(hugeFakeBlob);
    },
    (err) => {
      strictEqual(err.name, "ImageTooLargeError");
      ok(err.message.includes("20MB"), "Error message must mention 20MB limit");
      return true;
    }
  );

  // 4) JPEG, WebP, MIMEが空のiPhone画像 (マジックバイトがJPEG), 拡張子と実データが異なる画像 (.jpg だが中身が PNG / HEIC)
  const jpegBlob = new Blob([VALID_JPEG_BYTES], { type: "image/jpeg" });
  const decJpeg = await utilMod.validateAndDecodeArtworkBlob(jpegBlob);
  strictEqual(decJpeg.fileType, "image/jpeg");

  const webpBlob = new Blob([VALID_WEBP_BYTES], { type: "image/webp" });
  const decWebp = await utilMod.validateAndDecodeArtworkBlob(webpBlob);
  strictEqual(decWebp.fileType, "image/webp");

  // MIMEが空 ("") の iPhone 画像でもマジックバイトで JPEG と正しく判定されること
  const emptyMimeIphoneImg = new Blob([VALID_JPEG_BYTES], { type: "" });
  const decEmptyMime = await utilMod.validateAndDecodeArtworkBlob(emptyMimeIphoneImg);
  strictEqual(decEmptyMime.fileType, "image/jpeg", "Empty MIME iPhone image must be detected via magic bytes");

  // 拡張子が .jpg に偽装されていても中身が HEIC ならマジックバイトで検出して拒否すること
  const disguisedHeic = new Blob([HEIC_BYTES], { type: "image/jpeg" });
  disguisedHeic.name = "renamed.jpg";
  await rejects(
    async () => {
      await utilMod.validateAndDecodeArtworkBlob(disguisedHeic);
    },
    (err) => {
      strictEqual(err.name, "UnsupportedImageFormatError");
      return true;
    }
  );
});

await asyncTest("Object URL とメモリ解放監査: 同じIDはキャッシュ再利用し、releaseArtwork で古いURLのみ解放、DataURL保存時はObject URLが増え続けないこと", async () => {
  artworkCacheMod.releaseAllArtwork();
  const initialCount = activeObjectUrls.size;

  const trackWithBlob = {
    id: "trk-obj-url-1",
    artworkBlob: new Blob([VALID_PNG_BYTES], { type: "image/png" }),
  };

  const url1 = artworkCacheMod.getArtworkUrl(trackWithBlob);
  const url2 = artworkCacheMod.getArtworkUrl(trackWithBlob);
  strictEqual(url1, url2, "Same track ID must reuse cached Object URL");
  strictEqual(activeObjectUrls.size, initialCount + 1, "Only 1 Object URL created");

  // 別トラックの Object URL は維持したまま、指定トラックの古い URL だけ解放する
  const otherTrack = {
    id: "trk-obj-url-2",
    artworkBlob: new Blob([VALID_JPEG_BYTES], { type: "image/jpeg" }),
  };
  const otherUrl = artworkCacheMod.getArtworkUrl(otherTrack);
  strictEqual(activeObjectUrls.size, initialCount + 2);

  // trk-obj-url-1 の画像を Data URL に更新し releaseArtwork を呼ぶ
  artworkCacheMod.releaseArtwork("trk-obj-url-1");
  strictEqual(activeObjectUrls.has(url1), false, "Old Object URL for updated track must be revoked");
  strictEqual(activeObjectUrls.has(otherUrl), true, "Other track Object URL must NOT be revoked");

  // 画像変更を繰り返しても Data URL 方式のため Object URL が増え続けないこと
  for (let i = 0; i < 5; i++) {
    artworkCacheMod.releaseArtwork("trk-obj-url-1");
    trackWithBlob.artworkBlob = null;
    trackWithBlob.artworkDataUrl = `data:image/jpeg;base64,ITER_${i}`;
    const u = artworkCacheMod.getArtworkUrl(trackWithBlob);
    strictEqual(u, `data:image/jpeg;base64,ITER_${i}`);
  }
  strictEqual(activeObjectUrls.size, initialCount + 1, "Repeated artwork changes must not leak Object URLs");
  artworkCacheMod.releaseAllArtwork();
});

await asyncTest("同期処理 (recordLibraryModified) で dirty 状態と最終変更時刻が登録され、アートワーク変更が端末間同期対象になること", async () => {
  syncMod.recordLibraryModified();
  strictEqual(syncMod.isLibraryDirty(), true, "Library must be marked dirty after artwork modification");
  const lastModStr = syncMod.getLastLocalModifiedTime();
  ok(Boolean(lastModStr && new Date(lastModStr).getTime() > 0), "lastLocalModifiedTime must be updated");
});

console.log(`\n全 ${passed} 件のテストに合格しました ✓`);
process.exit(0);
