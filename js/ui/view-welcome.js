/**
 * ウェルカム / インストール案内ビュー
 *
 * 用途:
 *   - ブラウザでアクセスしたユーザにアプリの紹介と PWA インストール手順を提示
 *   - インストール済み PWA (standalone) ではこのビューは通常表示されない
 *
 * 表示制御:
 *   - User-Agent から iPhone / Android / その他を判定し、該当する手順を先頭に表示
 *   - Chrome/Edge の beforeinstallprompt が拾えた場合は「インストール」ボタンを有効化
 *
 * UI のリンクからライブラリへ「そのままブラウザで試す」もできる。
 */

import { go } from "../router.js";

// beforeinstallprompt はページロード時にしか発火しないので、
// app.js でグローバルに受け取って window.__deferredInstallPrompt に置く設計
let deferredPrompt = window.__deferredInstallPrompt || null;
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  deferredPrompt = e;
  window.__deferredInstallPrompt = e;
  // 既にこのビューが表示されているならボタンを有効化
  const btn = document.getElementById("welcome-install-btn");
  if (btn) {
    btn.disabled = false;
    btn.textContent = "インストール";
  }
});

export async function mount(root) {
  const ua = navigator.userAgent || "";
  const isIOS = /iPad|iPhone|iPod/.test(ua) ||
                (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const isAndroid = /Android/i.test(ua);
  const isStandalone = window.matchMedia("(display-mode: standalone)").matches
                       || window.navigator.standalone === true;

  root.innerHTML = render({ isIOS, isAndroid, isStandalone, canInstall: !!deferredPrompt });

  // 「ブラウザで試す」 → ライブラリへ
  root.querySelector("#welcome-try-btn")?.addEventListener("click", () => {
    go("library");
  });

  // インストールボタン（Chrome/Edge/Android Chrome 等）
  const installBtn = root.querySelector("#welcome-install-btn");
  if (installBtn) {
    installBtn.addEventListener("click", async () => {
      if (!deferredPrompt) return;
      installBtn.disabled = true;
      try {
        deferredPrompt.prompt();
        // BeforeInstallPromptEvent.prompt() は1イベントにつき1回しか呼べない
        // (2回目は InvalidStateError で reject)。受諾/却下に関わらずこのイベントは
        // 消費済みなので、outcome を問わず破棄する。
        await deferredPrompt.userChoice;
      } catch (e) {
        console.warn("install prompt 失敗", e);
      } finally {
        // 消費済みプロンプトでボタンを再有効化すると、再クリックで prompt() が無反応に
        // reject されるだけ。ボタンは無効のままにする(再表示はブラウザのメニュー/アドレス
        // バーから)。新しい beforeinstallprompt が発火すれば listener が再度有効化する。
        deferredPrompt = null;
        window.__deferredInstallPrompt = null;
        installBtn.disabled = true;
      }
    });
  }
}

function render({ isIOS, isAndroid, isStandalone, canInstall }) {
  // 該当プラットフォームの手順を先頭に
  const sections = [];
  if (isIOS) {
    sections.push(iosInstructions());
    sections.push(androidInstructions());
  } else if (isAndroid) {
    sections.push(androidInstructions());
    sections.push(iosInstructions());
  } else {
    sections.push(desktopInstructions(canInstall));
    sections.push(iosInstructions());
    sections.push(androidInstructions());
  }

  return `
    <section class="welcome-view">
      <div class="welcome-hero">
        <img class="welcome-icon" src="./icons/icon-192.png" alt="MUSIC-PLAYER" />
        <h1 class="welcome-title">MUSIC-PLAYER</h1>
        <p class="welcome-tagline">ローカル音源を再生し、Last.fm にスクロブル＆統計を表示する PWA</p>
        ${isStandalone ? `
          <p class="welcome-installed-note">既にインストール済みのようです。下のナビからご利用ください。</p>
        ` : ``}
      </div>

      <div class="welcome-card">
        <h2>主な機能</h2>
        <ul class="welcome-features">
          <li><b>多形式対応</b> ─ MP3 / M4A / M4B / AAC / MP4 / FLAC / OGG / OGA / Opus / WAV / WebM</li>
          <li><b>オフライン再生</b> ─ 曲も画面も端末内に保存、ネット不要</li>
          <li><b>Last.fm スクロブル</b> ─ 再生条件を満たすと自動で送信</li>
          <li><b>Last.fm 統計表示</b> ─ トップチャート・ジャンル分析・時間帯ヒートマップ・年別の振り返り など 8 タブ</li>
          <li><b>Love 機能</b> ─ 再生中の曲を Last.fm でお気に入り登録</li>
          <li><b>オフラインスクロブルキュー</b> ─ 通信復帰時に自動送信</li>
          <li><b>iPhone ロック画面操作</b> ─ メディアセッション API 対応</li>
        </ul>
      </div>

      <div class="welcome-card welcome-install">
        <h2>ホーム画面にインストール</h2>
        <p class="welcome-note">アプリのようにフルスクリーンで動き、オフラインでも起動できます。</p>
        ${sections.join("")}
      </div>

      <div class="welcome-card welcome-try">
        <h2>そのまま試す</h2>
        <p class="welcome-note">インストールせずブラウザ上で利用することもできます（曲データは端末に保存されます）。</p>
        <div class="welcome-actions">
          <button class="btn primary" id="welcome-try-btn">そのままブラウザで試す</button>
        </div>
      </div>

      <div class="welcome-card welcome-about">
        <h2>使い方</h2>
        <ol class="welcome-steps">
          <li><b>ライブラリ</b>タブで音源ファイルを追加（「ファイル」または「フォルダ」ボタンから選択）</li>
          <li><b>再生</b>タブで曲を再生、シャッフル / リピート / Love などを操作</li>
          <li>必要なら<b>設定</b>タブで Last.fm 認証（フル認証ならスクロブル可）</li>
          <li><b>統計</b>タブで Last.fm 上の自分の聴取データを閲覧</li>
        </ol>
      </div>

      <div class="welcome-card welcome-privacy">
        <h2>プライバシー</h2>
        <p class="welcome-note">
          すべての音源データはお使いの端末内（IndexedDB）に保存され、外部に送信されません。<br/>
          Last.fm の API キー等は AES-256-GCM で端末内に暗号化保管します。<br/>
          スクロブル送信先は Last.fm のみで、第三者にデータは送られません。
        </p>
      </div>
    </section>
  `;
}

function iosInstructions() {
  return `
    <div class="welcome-platform">
      <h3>iPhone / iPad (Safari)</h3>
      <ol>
        <li>このページを <b>Safari</b> で開く（他ブラウザでは追加できません）</li>
        <li>画面下中央の <b>共有ボタン ⬆︎</b> をタップ</li>
        <li>メニューを下にスクロールし、<b>「ホーム画面に追加」</b> をタップ</li>
        <li>右上の <b>「追加」</b> をタップ</li>
        <li>ホーム画面の <b>MUSIC-PLAYER</b> アイコンから起動</li>
      </ol>
    </div>
  `;
}

function androidInstructions() {
  return `
    <div class="welcome-platform">
      <h3>Android (Chrome)</h3>
      <ol>
        <li>このページを <b>Chrome</b> で開く</li>
        <li>画面上部に「ホーム画面に追加」バナーが出る場合は <b>「インストール」</b> をタップ</li>
        <li>または右上の <b>メニュー（⋮）</b> から <b>「アプリをインストール」</b> あるいは <b>「ホーム画面に追加」</b> を選択</li>
        <li>確認ダイアログで <b>「インストール」</b> をタップ</li>
        <li>ホーム画面/アプリ一覧の <b>MUSIC-PLAYER</b> から起動</li>
      </ol>
    </div>
  `;
}

function desktopInstructions(canInstall) {
  return `
    <div class="welcome-platform">
      <h3>PC (Chrome / Edge)</h3>
      <ol>
        <li>アドレスバー右端の <b>インストールアイコン</b>（⊕ のような形）をクリック</li>
        <li>または <b>メニュー（⋮）→「MUSIC-PLAYER をインストール」</b> を選択</li>
      </ol>
      ${canInstall ? `
        <div class="welcome-actions">
          <button class="btn primary" id="welcome-install-btn">インストール</button>
        </div>
      ` : `
        <p class="welcome-hint">※ ブラウザがインストールに対応していれば下にボタンが現れます。</p>
        <div class="welcome-actions">
          <button class="btn" id="welcome-install-btn" disabled>インストール（未対応 / 既にインストール済み）</button>
        </div>
      `}
    </div>
  `;
}
