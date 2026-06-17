/**
 * 共通UIコンポーネント（トースト・モーダル・確認ダイアログ）
 */

/**
 * トースト通知を出す
 * @param {string} msg
 * @param {"info"|"ok"|"err"} kind
 * @param {number} ms
 */
export function toast(msg, kind = "info", ms = 2500) {
  const root = document.getElementById("toast-root");
  if (!root) return;
  const el = document.createElement("div");
  el.className = "toast" + (kind === "ok" ? " is-ok" : kind === "err" ? " is-err" : "");
  el.textContent = msg;
  root.appendChild(el);
  setTimeout(() => {
    el.style.opacity = "0";
    el.style.transition = "opacity 0.2s";
    setTimeout(() => el.remove(), 220);
  }, ms);
}

/**
 * モーダルを開く
 * @param {object} opts
 * @param {string} opts.title
 * @param {string|Node} opts.body
 * @param {Array<{label: string, primary?: boolean, danger?: boolean, onClick: () => (boolean|void|Promise<boolean|void>)}>} opts.actions
 *   onClick が false を返すとモーダルが閉じない
 * @returns {Promise<void>}
 */
export function openModal({ title, body, actions = [] }) {
  return new Promise((resolve) => {
    const root = document.getElementById("modal-root");
    if (!root) { resolve(); return; }
    root.innerHTML = "";
    root.hidden = false;

    const modal = document.createElement("div");
    modal.className = "modal";

    if (title) {
      const h = document.createElement("h2");
      h.textContent = title;
      modal.appendChild(h);
    }

    const bodyWrap = document.createElement("div");
    if (typeof body === "string") {
      bodyWrap.innerHTML = body;
    } else if (body instanceof Node) {
      bodyWrap.appendChild(body);
    }
    modal.appendChild(bodyWrap);

    const actionsWrap = document.createElement("div");
    actionsWrap.className = "modal-actions";

    // キーボード操作（全ダイアログ共通）:
    //   - Enter:  primary ボタン（送信/OK）を押下。promptForm の入力中に Enter で
    //             送信できるようにする。danger 確認（削除等）は primary を持たない
    //             ため Enter では確定せず、誤操作による破壊的アクションを防ぐ。
    //   - Escape: 先頭ボタン（慣例上キャンセル）を押下してダイアログを閉じる。
    // 実際のボタン要素を click することで、各ボタンの onClick（resolve(true/false/
    // null) 等）が正しく走り、Promise の取りこぼしが起きない。
    const onKeydown = (e) => {
      // ★ IME 変換中（日本語入力など）の Enter/Escape は「変換確定 / 変換取消」の
      //   操作であり、ダイアログ操作として扱ってはいけない。例えばプレイリスト名を
      //   日本語入力中、変換確定の Enter でフォームが早期送信されてしまうのを防ぐ。
      //   e.isComposing が標準。一部の旧 Android ブラウザ等は composition 中に
      //   keyCode=229 を返すため併せて弾く。
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === "Enter") {
        // textarea の改行入力は妨げない（現状 textarea は無いが防御的に）
        if (e.target && e.target.tagName === "TEXTAREA") return;
        const primary = modal.querySelector(".modal-actions .btn.primary");
        if (primary) { e.preventDefault(); primary.click(); }
      } else if (e.key === "Escape") {
        const firstBtn = modal.querySelector(".modal-actions .btn");
        if (firstBtn) { e.preventDefault(); firstBtn.click(); }
      }
    };

    const close = () => {
      document.removeEventListener("keydown", onKeydown);
      root.hidden = true;
      root.innerHTML = "";
      resolve();
    };

    if (actions.length === 0) {
      const ok = document.createElement("button");
      ok.className = "btn primary";
      ok.textContent = "OK";
      ok.addEventListener("click", close);
      actionsWrap.appendChild(ok);
    } else {
      for (const a of actions) {
        const btn = document.createElement("button");
        btn.className = "btn" + (a.primary ? " primary" : "") + (a.danger ? " danger" : "");
        btn.textContent = a.label;
        btn.addEventListener("click", async () => {
          try {
            const r = await a.onClick();
            if (r !== false) close();
          } catch (err) {
            toast(String(err && err.message || err), "err");
          }
        });
        actionsWrap.appendChild(btn);
      }
    }

    modal.appendChild(actionsWrap);
    root.appendChild(modal);

    // モーダル表示中のみ Enter/Escape を待ち受ける（close 時に解除）
    document.addEventListener("keydown", onKeydown);
  });
}

/**
 * 現在開いている共通モーダル(openModal / confirm / promptForm 由来)を「キャンセル」で閉じる。
 *   #modal-root は全画面共有のため、モーダルを開いたまま画面遷移(Android のハードウェア戻る/
 *   ブラウザ戻る/プログラム遷移)すると、半透明 backdrop(全画面 inset:0)が遷移後の画面に残り
 *   全タップを吸収してアプリが操作不能になる。router が遷移時にこれを呼んで確実に閉じる。
 *   先頭ボタン(慣例上キャンセル)を click することで、各ダイアログの onClick が走り、待機中の
 *   Promise が cancel 値(false/null)で resolve され、keydown リスナ解除・root 非表示まで既存の
 *   close 経路を通る(Promise の取りこぼし・リスナ漏れを防ぐ)。
 */
export function dismissActiveModal() {
  const root = document.getElementById("modal-root");
  if (!root || root.hidden) return;
  const firstBtn = root.querySelector(".modal-actions .btn");
  if (firstBtn) {
    firstBtn.click();
  } else {
    // 共通モーダル以外(独自構造のモーダル)が開いている場合のフォールバック: 直接閉じる。
    root.hidden = true;
    root.innerHTML = "";
  }
}

/**
 * 確認ダイアログ
 * @returns {Promise<boolean>}
 */
export function confirm(message, { title = "確認", okLabel = "OK", cancelLabel = "キャンセル", danger = false } = {}) {
  return new Promise((resolve) => {
    openModal({
      title,
      // white-space:pre-line で本文中の改行(\n)を尊重する(複数行の確認メッセージが
      //   HTML 折りたたみで 1 行に潰れないように。escapeHtml 済みなので XSS は無い)。
      body: `<p style="white-space:pre-line;">${escapeHtml(message)}</p>`,
      actions: [
        { label: cancelLabel, onClick: () => { resolve(false); } },
        { label: okLabel, primary: !danger, danger, onClick: () => { resolve(true); } },
      ],
    });
  });
}

/**
 * 簡単な入力フォームを表示
 * @param {Array<{name: string, label: string, type?: string, value?: string, placeholder?: string, autocomplete?: string}>} fields
 * @returns {Promise<Record<string,string>|null>}
 */
export function promptForm(title, fields, { okLabel = "OK", cancelLabel = "キャンセル" } = {}) {
  return new Promise((resolve) => {
    const wrap = document.createElement("div");
    const inputs = {};
    for (const f of fields) {
      const row = document.createElement("div");
      row.className = "modal-row";
      const label = document.createElement("label");
      label.textContent = f.label;
      const input = document.createElement("input");
      input.type = f.type || "text";
      input.value = f.value || "";
      input.placeholder = f.placeholder || "";
      // autocomplete は呼出側が指定可能。type=password では "off" がブラウザに
      // 無視されパスワードマネージャ保存を誘発するため、秘匿フィールドは
      // "new-password" を渡して保存プロンプトを抑止できるようにする。
      input.autocomplete = f.autocomplete || "off";
      input.spellcheck = false;
      inputs[f.name] = input;
      row.appendChild(label);
      row.appendChild(input);
      wrap.appendChild(row);
    }
    openModal({
      title,
      body: wrap,
      actions: [
        { label: cancelLabel, onClick: () => resolve(null) },
        { label: okLabel, primary: true, onClick: () => {
          const out = {};
          for (const k of Object.keys(inputs)) out[k] = inputs[k].value;
          resolve(out);
        }},
      ],
    });
    // 最初の入力にフォーカス
    setTimeout(() => {
      const first = Object.values(inputs)[0];
      if (first) first.focus();
    }, 50);
  });
}

/**
 * ステータスピル更新
 */
export function setStatus(text, kind = "") {
  const el = document.getElementById("status-pill");
  if (!el) return;
  el.textContent = text || "";
  el.classList.remove("is-ok", "is-err");
  if (kind === "ok") el.classList.add("is-ok");
  if (kind === "err") el.classList.add("is-err");
}

/**
 * HTML / 属性値のエスケープ
 * null / undefined は空文字として扱う（src="" や data-xxx="" の安全な初期値）
 *
 * < > & " ' を全てエスケープするので、テキストノード・属性値どちらの
 * コンテキストでも安全に使える。属性値専用に意味付けたい場合は escapeAttr を使う
 * (実装は同じだが、コードを読む人に「この箇所は属性値である」と明示できる)。
 */
export function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

/**
 * 属性値専用のエスケープ（escapeHtml の別名）。
 * 各 view-*.js で `const escapeAttr = escapeHtml;` と重複定義していた箇所を
 * 共通化するために導入。
 */
export const escapeAttr = escapeHtml;

/**
 * 時間表示 (秒 → mm:ss)
 */
export function formatTime(sec) {
  if (!isFinite(sec) || sec < 0) return "0:00";
  const s = Math.floor(sec);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r.toString().padStart(2, "0")}`;
}
