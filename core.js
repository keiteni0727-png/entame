/* ============================================================
   ここから旧 shared/u-sync.js（同期の見張り役）。エンタメ管理専用に取り込み
   ============================================================ */
/* ===================== 保存と同期の見張り役：4アプリ（エンタメ管理・おかね手帳・FitLife・ウリログ）で同じファイルを使う =====================
  ふつうの <script> で読み込む（window.USync）。Firebase を使うコードより前に置く。

  使い方
    エンタメ管理・おかね手帳 … u-core.js が中で使う（U.sync は USync と同じもの）
    FitLife・ウリログ        … const W = USync.wrap(Firestoreの関数一式, db, { id:"アプリ名", badge:true })
                               W.onSnapshot / W.setDoc / W.updateDoc / W.addDoc / W.deleteDoc / W.writeBatch / W.runTransaction を、
                               Firebase の同じ名前の関数と同じ書き方で使う

  やっていること
    ・読み込み（onSnapshot）が止まったら、少し待って自動でつなぎ直す（開き直さなくても戻る）
    ・書き込みが失敗したら、自動で保存し直す（同じ文書をあとから丸ごと書いたときは、古い失敗は捨てる）
      まとめ書き・トランザクションは、やり直すと二重になるおそれがあるので自動ではやり直さない（失敗を知らせるだけ）
    ・iPhoneで裏から戻ったとき・電波が戻ったとき・保存が20秒以上終わらないときは、通信をつなぎ直す
    ・端末内の保存場所が壊れたとき（iPhoneで長く裏にいたあとなど）は、未保存がなければ自動で開き直す
    ・badge:true のアプリは、保存できていない変更があるときだけ画面の下に小さく知らせる

  状態を見る
    USync.on(関数)      … 状態が変わるたびに呼ぶ（すぐ1回呼ぶ）。返り値で止める
    USync.view(同期済み) … 表示用の [種類 ok/busy/wait/err, 文字, 説明]
    USync.retry()       … 保存し直し・つなぎ直しを今すぐ行う */
window.USync = (() => {
  const SY = { pend: new Map(), fails: new Map(), lerr: new Map(), fatal: null, online: navigator.onLine !== false, at: 0, id: "app" };
  const subs = new Set();
  let emitQ = false;
  const emit = () => {
    if (emitQ) return;
    emitQ = true;
    queueMicrotask(() => {
      emitQ = false;
      subs.forEach(f => {
        try {
          f(SY);
        } catch (e) {
          console.warn(e);
        }
      });
    });
  };
  SY.on = f => {
    subs.add(f);
    f(SY);
    return () => subs.delete(f);
  };
  const hm = t => `${new Date(t).getHours()}:${String(new Date(t).getMinutes()).padStart(2, "0")}`;
  const failDocs = () => new Set([...SY.fails.values()].map(w => w.path)).size;
  SY.view = (synced = true) => {
    if (SY.fatal) return ["err", "接続エラー", "画面を開き直してください"];
    if (SY.fails.size) {
      const perm = [...SY.fails.values()].find(w => w.perm);
      return ["err", `未保存 ${failDocs()}件`, perm ? `保存できませんでした（${perm.code || "error"}）` : "自動で保存し直しています"];
    }
    if (SY.lerr.size) return ["err", "再接続中…", "読み込みが止まったので、自動でつなぎ直しています"];
    if (SY.pend.size) return SY.online ? ["busy", "保存中…", ""] : ["busy", "オフライン", "電波が戻ったら自動で保存します"];
    if (!SY.online) return ["wait", "オフライン", ""];
    if (!synced) return ["wait", "同期中…", "最新のデータを読み込んでいます"];
    return ["ok", "保存済み", SY.at ? `最後の保存 ${hm(SY.at)}` : ""];
  };

  /* 失敗の見分け：一時的なもの（電波など）は自動で保存し直す。端末内の保存場所が壊れたものは開き直す */
  const TEMP = new Set(["unavailable", "deadline-exceeded", "aborted", "internal", "unknown", "cancelled", "resource-exhausted"]);
  const BROKEN = /IndexedDB|INTERNAL ASSERTION|required state|refresh the (browser|page)|persistence layer/i;
  const isBroken = e => !!e && BROKEN.test(String(e.message || e));
  SY.isTemp = e => !!e && TEMP.has(e.code);
  const RETRY_S = [3, 10, 30, 60, 120];

  /* 画面の上に出す帯（開き直すボタンつき）・下に出す小さな知らせ。どのアプリでも同じ見た目（色は端末の明暗に合わせる） */
  const DARK = matchMedia("(prefers-color-scheme: dark)");
  const boxCss = top =>
    `position:fixed;left:50%;transform:translateX(-50%);${top ? "top:calc(10px + env(safe-area-inset-top,0px))" : "bottom:calc(84px + env(safe-area-inset-bottom,0px))"};z-index:2147483000;display:flex;align-items:center;gap:12px;width:max-content;max-width:calc(100% - 24px);border-radius:12px;padding:8px 8px 8px 16px;font:13px/1.5 system-ui,-apple-system,"Hiragino Sans",sans-serif;box-shadow:0 6px 20px rgba(0,0,0,.25);background:${DARK.matches ? "#f2f2f4" : "#26262b"};color:${DARK.matches ? "#1c1c1e" : "#fff"}`;
  const btnCss = "border:0;border-radius:8px;padding:6px 12px;font:700 12.5px/1.5 inherit;white-space:nowrap;cursor:pointer;background:#e8743b;color:#fff";
  function bar(id, top, text, label, onClick) {
    let el = document.getElementById(id);
    if (!text) return void (el && el.remove());
    if (!el) {
      el = document.createElement("div");
      el.id = id;
      el.setAttribute("role", top ? "alert" : "status");
      el.innerHTML = `<span></span><button type="button"></button>`;
      document.body.appendChild(el);
    }
    el.style.cssText = boxCss(top);
    el.querySelector("span").textContent = text;
    const b = el.querySelector("button");
    b.style.cssText = btnCss;
    b.textContent = label;
    b.onclick = onClick;
  }
  function onBroken(e) {
    console.warn("保存場所のエラー", e);
    SY.fatal = e;
    emit();
    const RK = "u-reload:" + SY.id;
    let last = 0;
    try {
      last = +sessionStorage.getItem(RK) || 0;
    } catch (_) {}
    /* 未保存がなく、画面を見ているときだけ自動で開き直す（2分に1回まで） */
    if (!document.hidden && !SY.fails.size && Date.now() - last > 120000) {
      try {
        sessionStorage.setItem(RK, String(Date.now()));
      } catch (_) {}
      location.reload();
      return;
    }
    bar("u-syncerr", true, "保存先との接続が切れました。開き直すと直ります。", "開き直す", () => location.reload());
  }

  /* 書き込み1回分。full＝文書を丸ごと書く（set・delete）。丸ごと書いたら、それより前の同じ文書の失敗は不要
     once＝自動ではやり直さない（まとめ書き・トランザクション） */
  let wseq = 0;
  const lastFull = {};
  function attempt(w) {
    const tok = {};
    SY.pend.set(tok, Date.now());
    emit();
    return w.run().then(
      r => {
        SY.pend.delete(tok);
        SY.at = Date.now();
        clearTimeout(w.t);
        SY.fails.delete(w.id);
        if (w.full)
          SY.fails.forEach((f, k) => {
            if (f.path === w.path && k < w.id) {
              clearTimeout(f.t);
              SY.fails.delete(k);
            }
          });
        emit();
        return r;
      },
      e => {
        SY.pend.delete(tok);
        if (w.once || (w.full && lastFull[w.path] !== w.id)) SY.fails.delete(w.id); // やり直さないもの・あとから丸ごと書いたもの
        else {
          w.code = (e && e.code) || "error";
          w.perm = !TEMP.has(w.code);
          SY.fails.set(w.id, w);
          if (!w.perm && w.tries < RETRY_S.length) w.t = setTimeout(() => retryOne(w), RETRY_S[w.tries++] * 1000);
          console.warn("保存できませんでした", w.path, e);
        }
        if (isBroken(e)) onBroken(e);
        emit();
        throw e;
      },
    );
  }
  function retryOne(w) {
    if (!SY.fails.has(w.id)) return;
    clearTimeout(w.t);
    attempt(w).catch(() => {});
  }
  function track(path, full, run, once) {
    const w = { id: ++wseq, path, full, run, tries: 0, once: !!once };
    if (full) lastFull[path] = w.id;
    return attempt(w);
  }

  /* 読み込み（onSnapshot）を見張る。make(ok, ng) で読み込みを始めて、止める関数を返す。止まったら少し待ってつなぎ直す */
  const lsn = new Set();
  function listen(make, cb, err) {
    const L = { off: null, t: 0, n: 0, dead: false };
    L.start = () => {
      clearTimeout(L.t);
      if (L.dead) return;
      try {
        L.off && L.off();
      } catch (_) {}
      L.off = make(
        s => {
          L.n = 0;
          if (SY.lerr.delete(L)) emit();
          if (cb) cb(s);
        },
        e => {
          L.off = null;
          SY.lerr.set(L, e);
          emit();
          console.warn("読み込みが止まりました", e);
          if (err) err(e);
          if (isBroken(e)) onBroken(e);
          if (!L.dead) L.t = setTimeout(L.start, [2, 5, 15, 30, 60][Math.min(L.n++, 4)] * 1000);
        },
      );
    };
    lsn.add(L);
    L.start();
    return () => {
      L.dead = true;
      clearTimeout(L.t);
      lsn.delete(L);
      if (SY.lerr.delete(L)) emit();
      try {
        L.off && L.off();
      } catch (_) {}
    };
  }
  /* 今すぐやり直す：止まった読み込みをつなぎ直し、保存できなかったものを保存し直す（all＝あきらめたものも） */
  function redo(all) {
    lsn.forEach(L => SY.lerr.has(L) && L.start());
    SY.fails.forEach(w => (all || !w.perm) && ((w.tries = Math.min(w.tries, RETRY_S.length - 1)), retryOne(w)));
  }
  let kick = () => {};
  SY.retry = () => {
    kick(true);
    redo(true);
  };

  /* Firestore に取り付ける（1回だけ）：裏から戻ったとき・電波が戻ったとき・保存が終わらないときに通信をつなぎ直す */
  let attached = false;
  function attach(F, fs, opt) {
    if (opt && opt.id) SY.id = opt.id;
    if (attached) return;
    attached = true;
    let kickAt = 0;
    kick = async force => {
      if (!force && Date.now() - kickAt < 15000) return;
      kickAt = Date.now();
      try {
        await F.disableNetwork(fs);
      } catch (_) {}
      try {
        await F.enableNetwork(fs);
      } catch (_) {}
    };
    let hiddenAt = 0;
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) return void (hiddenAt = Date.now());
      if (hiddenAt && Date.now() - hiddenAt > 20000) kick();
      redo(false);
    });
    addEventListener("online", () => {
      SY.online = true;
      emit();
      F.enableNetwork(fs).catch(() => {});
      redo(false);
    });
    addEventListener("offline", () => {
      SY.online = false;
      emit();
    });
    setInterval(() => {
      if (document.hidden || !SY.online || !SY.pend.size) return;
      if (Date.now() - Math.min(...SY.pend.values()) > 20000) kick();
    }, 10000);
    /* 保存できていない変更があるときだけ、画面の下に小さく知らせる（状態表示を持たないアプリ用） */
    if (opt && opt.badge)
      SY.on(() => {
        const n = failDocs();
        bar("u-syncfail", false, n ? (SY.fails.size && [...SY.fails.values()].every(w => w.perm) ? `保存できなかった変更があります（${n}件）` : `保存できていない変更があります（${n}件）・自動で保存し直しています`) : "", "今すぐ保存", () => SY.retry());
      });
  }

  /* Firebase の関数と同じ書き方で使える版を作る（FitLife・ウリログ用） */
  function wrap(F, fs, opt) {
    attach(F, fs, opt);
    const isOpts = x => x && typeof x === "object" && typeof x.next !== "function" && !("next" in x);
    return {
      onSnapshot: (ref, ...a) => {
        const o = isOpts(a[0]) ? a.shift() : null;
        const [next, err] = a;
        return listen((ok, ng) => (o ? F.onSnapshot(ref, o, ok, ng) : F.onSnapshot(ref, ok, ng)), next, err);
      },
      setDoc: (ref, data, o) => track(ref.path, !(o && (o.merge || o.mergeFields)), () => (o ? F.setDoc(ref, data, o) : F.setDoc(ref, data))),
      updateDoc: (ref, ...a) => track(ref.path, false, () => F.updateDoc(ref, ...a)),
      deleteDoc: ref => track(ref.path, true, () => F.deleteDoc(ref)),
      /* 新しい文書：IDを先に決めてから書く（やり直しても二重にならない） */
      addDoc: (col, data) => {
        const r = F.doc(col);
        return track(r.path, true, () => F.setDoc(r, data)).then(() => r);
      },
      writeBatch: db => {
        const b = F.writeBatch(db),
          commit = b.commit.bind(b);
        b.commit = () => track(`batch-${wseq + 1}`, false, commit, true);
        return b;
      },
      runTransaction: (db, fn, o) => track(`tx-${wseq + 1}`, false, () => F.runTransaction(db, fn, o), true),
    };
  }

  return Object.assign(SY, { track, listen, attach, wrap });
})();

/* ============================================================
   ここから旧 shared/u-auth.js（ログインの処理）。エンタメ管理専用に取り込み
   ============================================================ */
/* ===================== ログインの共通処理：4アプリ（エンタメ管理・おかね手帳・FitLife・ウリログ）で同じファイルを使う =====================
  ふつうの <script> で読み込む（window.UAuth）。ログイン画面の見た目は各アプリのまま、処理だけをここにまとめる。
  A は Firebase の auth の関数一式（import した firebase-auth.js）

  UAuth.STANDALONE          … ホーム画面のアイコンから開いているか
  UAuth.IN_LINE             … LINE の中のブラウザで開いているか（Googleログインが使えない）
  UAuth.appUrl()            … このアプリのURL（? や # を除いたもの）
  UAuth.normEmail(s)        … メールアドレスを小文字・前後の空白なしにそろえる
  UAuth.emailOk(s)          … メールアドレスの形になっているか
  UAuth.msg(err, 上書き)     … ログインのエラーを、やさしい日本語にする（アプリごとに文を上書きできる）
  UAuth.google(auth, A)     … Googleでログイン。ポップアップが使えないとき（ホーム画面から開いたときなど）は画面を切り替えてログイン
                               自分で閉じたときは false。それ以外の失敗はエラーを投げる
  UAuth.sendLink(auth, A, email, url, key)   … ログイン用のリンクをメールで送る（送ったアドレスを端末に覚えておく）
  UAuth.finishLink(auth, A, email, link, key) … メールのリンクでログインを終える（覚えたアドレスを消して、URLをもとに戻す）
  UAuth.setPassword(A, user, pw)              … パスワードを作る・変える */
window.UAuth = (() => {
  const STANDALONE = navigator.standalone === true || matchMedia("(display-mode: standalone)").matches;
  const IN_LINE = / Line\//i.test(navigator.userAgent);
  const appUrl = () => location.origin + location.pathname;
  const normEmail = s => String(s || "").trim().toLowerCase();
  const emailOk = s => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
  const ERR = {
    "auth/invalid-email": "メールアドレスの形がちがうみたい",
    "auth/missing-password": "パスワードを入れてね",
    "auth/weak-password": "パスワードは6文字以上にしてね",
    "auth/email-already-in-use": "このメールアドレスはもう登録されているよ。「ログイン」から入ってね",
    "auth/invalid-credential": "メールアドレスかパスワードがちがうみたい",
    "auth/wrong-password": "メールアドレスかパスワードがちがうみたい",
    "auth/user-not-found": "メールアドレスかパスワードがちがうみたい",
    "auth/too-many-requests": "何度も失敗したので、少し時間をおいてね",
    "auth/network-request-failed": "ネットにつながっていないみたい",
    "auth/operation-not-allowed": "Firebaseで、このログイン方法がまだオンになっていないみたい",
    "auth/unauthorized-domain": "このURLがFirebaseの「承認済みドメイン」に入っていないみたい",
    "auth/unauthorized-continue-uri": "このURLがFirebaseの「承認済みドメイン」に入っていないみたい",
    "auth/invalid-action-code": "このリンクは使えません（期限切れか使用ずみ）。もう一度メールを送ってね",
    "auth/expired-action-code": "リンクの期限が切れています。もう一度メールを送ってね",
    "auth/quota-exceeded": "今日はメールを送れる回数の上限です。明日また試すか、Googleでログインしてね",
    "auth/account-exists-with-different-credential": "このメールアドレスは別の方法で登録ずみです。メールのリンクでログインしてね",
    "auth/requires-recent-login": "安全のため、一度ログアウトして、もう一度ログインしてから設定してね",
  };
  const msg = (e, over) => (over && over[e?.code]) || ERR[e?.code] || `うまくいかなかったよ（${e?.code || e?.message || "不明"}）`;
  async function google(auth, A) {
    const pv = new A.GoogleAuthProvider();
    pv.setCustomParameters({ prompt: "select_account" });
    try {
      await A.signInWithPopup(auth, pv);
      return true;
    } catch (e) {
      if (["auth/popup-blocked", "auth/operation-not-supported-in-this-environment"].includes(e?.code)) {
        await A.signInWithRedirect(auth, pv);
        return true;
      }
      if (["auth/popup-closed-by-user", "auth/cancelled-popup-request"].includes(e?.code)) return false;
      throw e;
    }
  }
  async function sendLink(auth, A, email, url, key) {
    email = normEmail(email);
    await A.sendSignInLinkToEmail(auth, email, { url: url || appUrl(), handleCodeInApp: true });
    try {
      localStorage.setItem(key, email);
    } catch (_) {}
    return email;
  }
  async function finishLink(auth, A, email, link, key) {
    await A.signInWithEmailLink(auth, normEmail(email), link);
    try {
      localStorage.removeItem(key);
    } catch (_) {}
    if (location.search || location.hash) history.replaceState(null, "", appUrl());
  }
  async function setPassword(A, user, pw) {
    if ((user.providerData || []).some(p => p.providerId === "password")) await A.updatePassword(user, pw);
    else await A.linkWithCredential(user, A.EmailAuthProvider.credential(user.email, pw));
  }
  return { STANDALONE, IN_LINE, appUrl, normEmail, emailOk, msg, google, sendLink, finishLink, setPassword };
})();

/* ============================================================
   ここから旧 shared/u-core.js（共通の土台・動作）。エンタメ管理専用に取り込み
   ============================================================ */
/* ===================== 共通の土台（動作）：おかね手帳・エンタメ管理で同じファイルを使う =====================
  アプリごとの設定は、このファイルより前に window.U_APP で渡す
    id   … アプリの名前（"okane" / "entame"）
    fb   … Firebase の設定（firebaseConfig）
    root … Firebase での保存場所。uid を受け取ってパスを返す関数（省略時は users/<uid>）
  U.esc(文字) … HTMLに入れる文字をエスケープ
  U.ls.get(キー) / U.ls.set(キー, 値) … 端末に覚える小さな設定（localStorage）
  U.copy(文字) … クリップボードにコピー（できたら true）
  U.toast(文, { html, undo, ms }) … 画面の下に短く通知
  U.store() … 保存先（Firebase）につなぐ。ログインしていなければログイン画面を出す。何度呼んでも接続は1回だけ
    返り値 { kind, db, uid, logout }
      kind … "fb"＝Firebase / "none"＝つながらない
      db   … doc(path) と collection(path) を持つ
      uid  … 利用者のID（つながらないときは null） */
const U = { app: Object.assign({ id: "app", fb: null, root: null }, window.U_APP || {}), FB_VER: "12.15.0" };
/* ---------- 表示（ライト／ダーク）：auto＝端末に合わせる。アプリごと・端末ごとに覚える ----------
   開いた瞬間に白く光らないよう、各アプリの index.html の head でも同じ処理を先に行う */
U.THEME_KEY = "u-theme:" + U.app.id;
U.THEME_NAME = { auto: "自動（端末に合わせる）", light: "ライト", dark: "ダーク" };
U.theme = () => {
  try {
    const v = localStorage.getItem(U.THEME_KEY);
    return v === "light" || v === "dark" ? v : "auto";
  } catch (_) {
    return "auto";
  }
};
U.applyTheme = (v = U.theme()) => {
  const r = document.documentElement;
  if (v === "auto") r.removeAttribute("data-theme");
  else r.setAttribute("data-theme", v);
  /* 実際に出ている方（自動のときは端末の設定）を th-l / th-d の印で付ける。ライトとダークで形の違う所はこの印で書き分ける */
  const dark = v === "dark" || (v === "auto" && matchMedia("(prefers-color-scheme: dark)").matches);
  r.classList.toggle("th-d", dark);
  r.classList.toggle("th-l", !dark);
  /* iPhoneの上の帯などの色も合わせる */
  document.querySelectorAll('meta[name="theme-color"]').forEach(m => {
    if (!m.dataset.orig) m.dataset.orig = m.content;
    m.content = v === "light" ? "#f7f1e8" : v === "dark" ? "#17151b" : m.dataset.orig;
  });
};
/* 「自動」のとき、端末のライト／ダークが切り替わったら印も付け直す */
try {
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => U.applyTheme());
} catch (_) {}
U.setTheme = v => {
  try {
    if (v === "auto") localStorage.removeItem(U.THEME_KEY);
    else localStorage.setItem(U.THEME_KEY, v);
  } catch (_) {}
  U.applyTheme(v);
  /* 表示の切り替えボタンや設定の印は、この知らせで描き直す */
  document.dispatchEvent(new Event("u-theme"));
};
U.applyTheme();
(() => {
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  U.esc = esc;
  /* 検索用に文字をそろえる（大文字小文字・全角半角・カタカナ→ひらがな、記号や空白は無視） */
  U.norm = t =>
    String(t || "")
      .toLowerCase()
      .normalize("NFKC")
      .replace(/[\u30a1-\u30f6]/g, c => String.fromCharCode(c.charCodeAt(0) - 0x60))
      .replace(/[\s・、。!！?？〜~\-－]/g, "");

  /* ---------- 端末に覚える小さな設定（localStorage に JSON で）。使えない端末では何もしない ---------- */
  U.ls = {
    get(k) {
      try {
        return JSON.parse(localStorage.getItem(k) || "null");
      } catch (e) {
        return null;
      }
    },
    set(k, v) {
      try {
        localStorage.setItem(k, JSON.stringify(v));
      } catch (e) {}
    },
  };

  /* ---------- 文字をコピー。iPhoneでも動くよう、まず選択してコピー → だめなら clipboard。できたら true ---------- */
  U.copy = async text => {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.cssText = "position:fixed;left:0;top:0;width:1px;height:1px;opacity:0";
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch (e) {}
    ta.remove();
    if (ok) return true;
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (e) {
      return false;
    }
  };

  /* ---------- Firebase ---------- */
  /* ログイン画面：Googleでログインのみ。ポップアップが使えないとき（ホーム画面から開いたとき等）は画面を切り替えてログイン */
  function loginForm(auth, mod, msg) {
    let host = document.getElementById("u-login");
    if (!host) {
      host = document.createElement("div");
      host.id = "u-login";
      host.className = "u-login";
      document.body.appendChild(host);
    }
    host.innerHTML = `<form><h3>ログイン</h3>
      <p>Googleアカウントでログインしてください。一度ログインすると、この端末では次からログイン不要です。</p>
      <button type="submit" class="u-google"><svg viewBox="0 0 48 48" width="20" height="20" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>Googleでログイン</button>${msg ? `<p class="u-login-err" role="alert">${esc(msg)}</p>` : ""}</form>`;
    host.querySelector("form").onsubmit = async ev => {
      ev.preventDefault();
      const btn = host.querySelector("button");
      btn.disabled = true;
      /* Googleログインの処理は4アプリ共通の shared/u-auth.js */
      try {
        if (!(await window.UAuth.google(auth, mod))) btn.disabled = false;
      } catch (e) {
        loginForm(auth, mod, `ログインできませんでした。もう一度お試しください。（${(e && e.code) || "error"}）`);
      }
    };
  }
  /* ---------- 保存と同期の見張り：共通の shared/u-sync.js（4アプリ共通）。U.sync は USync と同じもの ---------- */
  const SY = (U.sync = window.USync);
  const { track, listen } = SY;
  const wid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  async function fbStore() {
    const base = `https://www.gstatic.com/firebasejs/${U.FB_VER}/`;
    const [A, Au, F] = await Promise.all([
      import(base + "firebase-app.js"),
      import(base + "firebase-auth.js"),
      import(base + "firebase-firestore.js"),
    ]);
    const app = A.initializeApp(U.app.fb);
    const auth = Au.getAuth(app);
    await Au.setPersistence(auth, Au.browserLocalPersistence).catch(() => {});
    /* 端末内の控えは「1つのタブだけ」が使う。同じサイトの別アプリ（エンタメ管理・おかね手帳）や2つ目のタブは、
       控えを使わずメモリだけで動く（タブどうしで控えを取り合って、読み込みや保存が止まるのを防ぐ） */
    let fs;
    try {
      fs = F.initializeFirestore(app, {
        ignoreUndefinedProperties: true,
        localCache: F.persistentLocalCache({ tabManager: F.persistentSingleTabManager() }),
      });
    } catch (e) {
      fs = F.getFirestore(app);
    }
    /* 画面を切り替えてログインした後の戻り。失敗したときは理由を表示 */
    let redirErr = null;
    await Au.getRedirectResult(auth).catch(e => (redirErr = e));
    const user = await new Promise(res => {
      const off = Au.onAuthStateChanged(auth, u => {
        if (u) {
          off();
          res(u);
        } else loginForm(auth, Au, redirErr ? `ログインできませんでした。もう一度お試しください。（${redirErr.code || "error"}）` : "");
      });
    });
    document.getElementById("u-login")?.remove();

    /* 裏から戻ったとき・電波が戻ったときのつなぎ直しなどを取り付ける */
    SY.attach(F, fs, { id: U.app.id });

    const root = U.app.root ? U.app.root(user.uid) : `users/${user.uid}`;
    const snap = d => ({ id: d.id, exists: d.exists(), data: () => d.data() });
    const doc = path => {
      const full = `${root}/${path}`;
      const ref = F.doc(fs, full);
      return {
        id: ref.id,
        get: async () => snap(await F.getDoc(ref)),
        set: (data, opt) => track(full, !(opt && opt.merge), () => (opt ? F.setDoc(ref, data, opt) : F.setDoc(ref, data))),
        /* 渡した項目だけ書きかえる。{items:{id:中身}} なら items の中の id ごとに丸ごと入れ替え（null は削除の印として残す） */
        update: data => {
          const args = [];
          Object.entries(data).forEach(([k, v]) => {
            if (v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length)
              Object.entries(v).forEach(([k2, v2]) => args.push(new F.FieldPath(k, k2), v2));
            else args.push(new F.FieldPath(k), v);
          });
          if (!args.length) return Promise.resolve();
          return track(full, false, () =>
            F.updateDoc(ref, ...args).catch(e => {
              if (e && e.code === "not-found") return F.setDoc(ref, data, { merge: true });
              throw e;
            }),
          );
        },
        delete: () => track(full, true, () => F.deleteDoc(ref)),
        onSnapshot: (cb, err) => listen((ok, ng) => F.onSnapshot(ref, d => ok(snap(d)), ng), cb, err),
      };
    };
    const db = {
      doc,
      /* まとめ書き：[[パス, 中身], …] を1回の通信で書く（取り込み用。1回に500件まで） */
      setMany: list =>
        track(`batch-${wid()}`, false, () => {
          const b = F.writeBatch(fs);
          list.forEach(([path, data]) => b.set(F.doc(fs, `${root}/${path}`), data));
          return b.commit();
        }),
      collection: name => ({
        doc: id => doc(`${name}/${id}`),
        /* opt.meta＝true なら「端末に残っていた古いデータか（fromCache）」が変わったときも呼ぶ */
        onSnapshot: (cb, err, opt) =>
          listen(
            (ok, ng) =>
              F.onSnapshot(
                F.collection(fs, `${root}/${name}`),
                { includeMetadataChanges: !!(opt && opt.meta) },
                q => {
                  const docs = q.docs.map(snap);
                  ok({ docs, size: docs.length, empty: !docs.length, forEach: f => docs.forEach(f), fromCache: q.metadata.fromCache });
                },
                ng,
              ),
            cb,
            err,
          ),
      }),
    };
    return {
      kind: "fb",
      db,
      uid: user.uid,
      logout: async () => {
        await Au.signOut(auth);
        location.reload();
      },
    };
  }

  /* ---------- 通知：画面の下に短く出す ----------
    U.toast(文, { html, undo, ms })
      html … true なら文をHTMLとして入れる（呼ぶ側で esc 済みのものだけ）
      undo … 関数を渡すと「元に戻す」ボタンを付ける
      ms   … 出しておく時間（省略時は文の長さに合わせて 2.5〜6秒、undo つきは 8秒） */
  let toastT = null;
  U.toastClose = () => {
    clearTimeout(toastT);
    document.querySelectorAll(".u-toast").forEach(e => e.remove());
  };
  U.toast = (msg, { html = false, undo = null, ms } = {}) => {
    U.toastClose();
    const el = document.createElement("div");
    el.className = "u-toast" + (undo ? " undo" : "");
    el.setAttribute("role", "status");
    const sp = document.createElement("span");
    if (html) sp.innerHTML = msg;
    else sp.textContent = msg;
    el.append(sp);
    if (undo) {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = "元に戻す";
      b.onclick = ev => {
        ev.stopPropagation();
        U.toastClose();
        undo();
      };
      el.append(b);
    }
    document.body.appendChild(el);
    const len = (html ? sp.textContent : msg).length;
    toastT = setTimeout(U.toastClose, ms ?? (undo ? 8000 : Math.min(6000, Math.max(2500, len * 90))));
  };

  let conn = null;
  U.store = () =>
    conn ||
    (conn = (async () => {
      try {
        if (U.app.fb) return await fbStore();
      } catch (e) {
        return { kind: "none", db: null, uid: null, logout: null, error: e };
      }
      return { kind: "none", db: null, uid: null, logout: null };
    })());

  /* ---------- パスワード管理アプリ（1Password・Bitwarden・LastPass など）の候補ボタンを、ログイン以外の入力欄では出さない ----------
     パスワード・メールアドレス・ユーザー名の欄（ログイン画面）はそのまま。画面を描き直して増えた入力欄にも付ける */
  const pmLogin = el => el.type === "password" || el.type === "email" || /username|password|email/.test(el.getAttribute("autocomplete") || "");
  const pmMark = root => {
    const l = root.matches && root.matches("input,textarea") ? [root] : [];
    if (root.querySelectorAll) l.push(...root.querySelectorAll("input,textarea"));
    l.forEach(el => {
      if (el.hasAttribute("data-1p-ignore") || pmLogin(el)) return;
      el.setAttribute("data-1p-ignore", "");
      el.setAttribute("data-lpignore", "true");
      el.setAttribute("data-bwignore", "");
      el.setAttribute("data-form-type", "other");
      /* 自動で出る候補の一覧もしまっておく（1Password は候補を自動では開かなくなる）。もともと指定がある欄はそのまま */
      if (!el.hasAttribute("autocomplete")) el.setAttribute("autocomplete", "off");
    });
  };
  new MutationObserver(ms => ms.forEach(m => m.addedNodes.forEach(n => n.nodeType === 1 && pmMark(n)))).observe(document.documentElement, { childList: true, subtree: true });
  pmMark(document);
})();

/* ===== アプリ共通：折りたたみの印と、⠿を押さえて動かす並び替え（エンタメ管理・おかね手帳で共通） ===== */
/* ---------- 折りたたみの印：どこでも同じ「›」。たたんでいると右向き、開くと下向き（CSSで回す） ---------- */
const FOLD_IC = `<svg class="fic" viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M6 3.5 10.5 8 6 12.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
/* ---------- 並び替え：⠿（data-grip="種類"）を押さえたまま上下に動かす。マウス・指どちらでも。どの画面も同じ動き ----------
   動かす行は data-sortrow、同じ親の中だけで動く。離したら SORT_DONE[種類](親, 行の並び) を呼ぶ */
const GRIP = kind => `<span class="mgrip" data-grip="${kind}" aria-hidden="true" title="押さえたまま上下に動かして並び替え">⠿</span>`;
const SORT_DONE = {};
let gDrag = null;
document.addEventListener("pointerdown", e => {
  const g = e.target.closest("[data-grip]");
  if (!g || e.button > 0) return;
  const row = g.closest("[data-sortrow]");
  if (!row) return;
  const box = row.parentElement;
  e.preventDefault();
  try {
    g.setPointerCapture(e.pointerId);
  } catch (_) {}
  gDrag = { row, box, kind: g.dataset.grip, sc: row.closest(".mlist") || row.closest(".sheet") };
  row.classList.add("dragging");
  box.classList.add("sorting");
});
document.addEventListener("pointermove", e => {
  if (!gDrag) return;
  const { row, box, sc } = gDrag;
  if (sc) {
    const r = sc.getBoundingClientRect();
    if (e.clientY < r.top + 40) sc.scrollTop -= 8;
    else if (e.clientY > r.bottom - 40) sc.scrollTop += 8;
  }
  const rows = [...box.children].filter(x => x.matches("[data-sortrow]") && x !== row);
  const next = rows.find(x => {
    const b = x.getBoundingClientRect();
    return e.clientY < b.top + b.height / 2;
  });
  /* 最後へ動かすときは、最後の行のすぐ後ろ（行のあとにあるボタンなどより前）に入れる */
  const ref = next || (rows.length ? rows[rows.length - 1].nextSibling : null);
  if (ref !== row && ref !== row.nextSibling) box.insertBefore(row, ref);
});
/* 離したあとに続けて来るクリックは捨てる（描き直しで消えた⠿へのクリックが「外を押した」扱いになり、編集が閉じてしまうため） */
let gripEat = 0;
document.addEventListener(
  "click",
  e => {
    if (!gripEat || Date.now() - gripEat > 150) return;
    gripEat = 0;
    e.stopImmediatePropagation();
    e.preventDefault();
  },
  true,
);
const gripEnd = () => {
  if (!gDrag) return;
  gripEat = Date.now();
  const { row, box, kind } = gDrag;
  row.classList.remove("dragging");
  box.classList.remove("sorting");
  gDrag = null;
  const fn = SORT_DONE[kind];
  if (fn) fn(box, [...box.children].filter(x => x.matches("[data-sortrow]")));
};
document.addEventListener("pointerup", gripEnd);
document.addEventListener("pointercancel", gripEnd);

/* ============================================================
   ここから旧 shared/u-ui.js（共通の画面部品）。エンタメ管理専用に取り込み
   ============================================================ */
/* ===================== 共通の画面部品：おかね手帳・エンタメ管理で同じファイルを使う（u-core.js のあとに読み込む） =====================
  U.TOUCH        … 指で操作する端末か（スマホ・iPad）
  U.sheetMode()  … 下から出すシートの形にする画面幅か（スマホ）。U.noSheet を true にしたアプリは、スマホでも欄のすぐ下に出す
  U.lock(on)     … シートなどを開いている間、後ろの画面をスクロールさせない（iPhoneでも効くよう body を固定）。U.lockY は固定前の位置
  表示の切り替えボタン（#hTheme）… 自動 → ライト → ダーク → 自動。押したときの処理とアイコンはここで行う
  U.pick         … プルダウン（select）を開くと、端末標準ではなく同じ見た目の一覧を出す。スマホは下から、PCは欄のすぐ下
    U.pick.close() … 開いている一覧を閉じる
    U.pick.onOpen  … 一覧を開く直前に呼ぶ関数（ほかの部品を閉じるときに使う）
    data-native を付けた select は端末標準のまま */
U.TOUCH = matchMedia("(hover:none) and (pointer:coarse)").matches;
U.sheetMode = () => !U.noSheet && matchMedia("(max-width:699px)").matches;
/* 欄のすぐ下に出した一覧を、画面の大きさの変化・スクロールで閉じてよいか（スマホでキーボードが出たとき・一覧の中の欄に入力中は閉じない） */
U.popKeep = box => U.TOUCH || !!(document.activeElement && document.activeElement.closest && document.activeElement.closest(box));
U.IC = {
  check: `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>`,
  x: `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>`,
  search: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>`,
};

/* ---------- 後ろの画面を止める ---------- */
U.lockY = null;
U.lock = on => {
  const b = document.body.style;
  if (on && U.lockY === null) {
    U.lockY = scrollY;
    Object.assign(b, { position: "fixed", top: `-${U.lockY}px`, left: "0", right: "0", width: "100%" });
  } else if (!on && U.lockY !== null) {
    const y = U.lockY;
    U.lockY = null;
    Object.assign(b, { position: "", top: "", left: "", right: "", width: "" });
    scrollTo(0, y);
  }
};

/* ---------- 表示の切り替えボタン ---------- */
(() => {
  const IC = {
    auto: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor"/></svg>`,
    light: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>`,
    dark: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/></svg>`,
  };
  const paint = () =>
    document.querySelectorAll("#hTheme").forEach(b => {
      const v = U.theme();
      b.innerHTML = IC[v];
      b.setAttribute("aria-label", `表示：${U.THEME_NAME[v]}（押すと切り替え）`);
      b.title = `表示：${U.THEME_NAME[v]}`;
    });
  document.addEventListener("u-theme", paint);
  document.addEventListener("click", e => {
    if (!e.target.closest || !e.target.closest("#hTheme")) return;
    const nx = { auto: "light", light: "dark", dark: "auto" }[U.theme()];
    U.setTheme(nx);
    U.toast(`表示：${U.THEME_NAME[nx]}`);
  });
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", paint);
  else paint();
})();

/* ---------- プルダウン：選択の一覧 ----------
   使いにくくならない工夫：
   ・今の値にチェックを付け、開いたときにその位置までスクロール
   ・項目が10個を超えるときだけ上に「探す」欄（スマホでは自動でキーボードを出さない）
   ・選んだらすぐ閉じる。外を押す・✕・Escでも閉じる
   ・開いた直後の指の離れで下の項目を選ばないよう、0.3秒は選べない
   ・PCは ↑↓ で項目を移動、Enterで決定。スマホは開いている間、後ろの画面がスクロールしない */
U.pick = (() => {
  const esc = U.esc;
  const SEL = "select:not([data-native])";
  let cur = null,
    at = 0,
    t0 = null;
  const api = { onOpen: null };
  /* 一覧の見出し：aria-label、なければ欄の名前（label の文字） */
  function title(sel) {
    const a = sel.getAttribute("aria-label");
    if (a) return a;
    const l = (sel.id && document.querySelector(`label[for="${sel.id}"]`)) || sel.closest("label");
    const t = l ? [...l.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join("").trim() : "";
    return t || "選ぶ";
  }
  function close(refocus) {
    const s = cur;
    cur = null;
    document.getElementById("pkPop")?.remove();
    document.documentElement.classList.remove("pkopen");
    if (s && refocus && !U.TOUCH && s.isConnected) s.focus();
  }
  function rows() {
    const opts = [...cur.options].filter(o => !o.hidden);
    return opts
      .map(o => {
        const on = cur.selectedIndex === o.index;
        return `<button type="button" class="dd-row${on ? " on" : ""}" role="option" aria-selected="${on}" data-pki="${o.index}"${o.disabled ? " disabled" : ""}><span class="dd-l">${esc(o.textContent)}</span>${on ? U.IC.check : ""}</button>`;
      })
      .join("");
  }
  function open(sel) {
    close();
    if (api.onOpen) api.onOpen();
    cur = sel;
    at = Date.now();
    const tt = title(sel);
    const sheet = U.sheetMode();
    const box = document.createElement("div");
    box.id = "pkPop";
    box.className = sheet ? "sheetmode" : "popmode";
    box.innerHTML = `<div class="dd-scrim" data-pkclose="1"></div><div class="dd-box" role="dialog" aria-label="${esc(tt)}">
      ${sheet ? `<div class="dd-h"><b>${esc(tt)}</b><span>選ぶと閉じます</span><button type="button" class="dd-x" data-pkclose="1" aria-label="閉じる">${U.IC.x}</button></div>` : ""}
      <div class="dd-list" role="listbox" id="pkList">${rows()}</div></div>`;
    document.body.appendChild(box);
    if (sheet) document.documentElement.classList.add("pkopen");
    else {
      /* PC：欄のすぐ下（下に場所がなければ上）に出す */
      const r = sel.getBoundingClientRect(),
        b = box.querySelector(".dd-box");
      const w = Math.min(Math.max(r.width, 220), 420);
      b.style.width = w + "px";
      b.style.left = Math.max(8, Math.min(r.left, innerWidth - w - 8)) + "px";
      const below = innerHeight - r.bottom - 12,
        above = r.top - 12;
      if (below >= 240 || below >= above) {
        b.style.top = r.bottom + 6 + "px";
        b.style.maxHeight = Math.min(420, below) + "px";
      } else {
        b.style.bottom = innerHeight - r.top + 6 + "px";
        b.style.maxHeight = Math.min(420, above) + "px";
      }
    }
    const on = box.querySelector(".dd-row.on");
    if (on) on.scrollIntoView({ block: "center" });
    if (!U.TOUCH) (on || box.querySelector(".dd-row"))?.focus();
  }
  function pick(i) {
    const s = cur;
    if (!s || Date.now() - at < 300) return;
    close();
    if (s.selectedIndex !== i) {
      s.selectedIndex = i;
      s.dispatchEvent(new Event("input", { bubbles: true }));
      s.dispatchEvent(new Event("change", { bubbles: true }));
    }
    if (!U.TOUCH && s.isConnected) s.focus();
  }
  const hit = e => e.target.closest && e.target.closest(SEL);
  /* PC：標準の選択を開かせずに、こちらの一覧を出す */
  document.addEventListener(
    "mousedown",
    e => {
      const s = hit(e);
      if (!s || e.button !== 0 || s.disabled) return;
      e.preventDefault();
      s.focus();
      open(s);
    },
    true,
  );
  /* スマホ：指を動かさずに離したときだけ開く（スクロールのつもりで触れたときは開かない） */
  document.addEventListener(
    "touchstart",
    e => {
      const s = hit(e);
      t0 = s && e.touches.length === 1 ? { s, x: e.touches[0].clientX, y: e.touches[0].clientY } : null;
    },
    { capture: true, passive: true },
  );
  document.addEventListener(
    "touchend",
    e => {
      const s = hit(e);
      if (!s || s.disabled) return;
      e.preventDefault();
      const t = e.changedTouches[0];
      if (!t0 || t0.s !== s || Math.abs(t.clientX - t0.x) > 10 || Math.abs(t.clientY - t0.y) > 10) return;
      open(s);
    },
    { capture: true, passive: false },
  );
  document.addEventListener(
    "click",
    e => {
      /* PC：プルダウンを押したときのクリック（一覧が開いたあと、画面全体に届く）は捨てる */
      if (cur && Date.now() - at < 800 && !(e.target.closest && e.target.closest("#pkPop .dd-box"))) {
        e.stopPropagation();
        e.preventDefault();
        return;
      }
      if (!e.target.closest || !e.target.closest("#pkPop")) return;
      e.stopPropagation();
      const r = e.target.closest("[data-pki]");
      if (r) pick(+r.dataset.pki);
      else if (e.target.closest("[data-pkclose]")) close(true);
    },
    true,
  );
  /* キーボード：選択欄で Enter・Space・↑↓ を押すと開く。一覧の中は ↑↓・Home・End で移動、Escで閉じる。
     アプリ側の一覧（編集画面のプルダウン・絞り込みの選択肢）も同じ動き */
  document.addEventListener(
    "keydown",
    e => {
      const t = e.target;
      if (!t || !t.closest) return;
      if (t.matches && t.matches(SEL) && ["Enter", " ", "ArrowDown", "ArrowUp"].includes(e.key) && !cur) {
        e.preventDefault();
        e.stopPropagation();
        open(t);
        return;
      }
      if (cur && e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        close(true);
        return;
      }
      const box = t.closest(".dd-box,.fsh-sub");
      if (!box || !["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
      const rs = [...box.querySelectorAll(".dd-row")];
      if (!rs.length) return;
      e.preventDefault();
      const i = rs.indexOf(t.closest(".dd-row"));
      const n = e.key === "Home" ? 0 : e.key === "End" ? rs.length - 1 : i < 0 ? 0 : Math.max(0, Math.min(rs.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)));
      rs[n].focus();
      rs[n].scrollIntoView({ block: "nearest" });
    },
    true,
  );
  /* PC：画面の大きさが変わったり、後ろをスクロールしたら閉じる（欄からずれるため） */
  addEventListener("resize", () => cur && !U.sheetMode() && !U.popKeep("#pkPop") && close());
  document.addEventListener("scroll", e => cur && !U.sheetMode() && !(e.target.closest && e.target.closest("#pkPop")) && !(U.TOUCH && document.activeElement && document.activeElement.closest && document.activeElement.closest("#pkPop")) && close(), true);
  api.close = close;
  api.isOpen = () => !!cur;
  return api;
})();

/* ============================================================
   ここから旧 shared/u-swipe.js（スワイプ操作の部品）。エンタメ管理専用に取り込み
   ============================================================ */
/* スマホのスワイプ（エンタメ管理・おかね手帳で共通）
   ・メニュー：開いているときは指に合わせて左へ引いて閉じる。左端から（またはページ送りの先頭で）右へ引くと開く
   ・ページ送り（任意）：画面を指にぴったり付けて横に動かし、離すと端まで流して隣の画面を反対側から入れる
   uSwipe({ sb, scrim, setDrawer(on), edge, blocked(), pager: { el, move, block, can(dir), go(dir) } })
   pager.move（任意）：指に合わせて動かす部分。渡さなければ el 全体を動かす（スワイプを受け付ける範囲は el のまま）
   sb を渡さなければメニューのスワイプはしない（ページ送りだけ） */
(function () {
  window.uSwipe = function (o) {
    const mq = matchMedia("(max-width:899px)");
    const q = s => document.querySelector(s);
    const isOpen = () => document.body.classList.contains("drawer");
    const W = () => (q(o.sb) && q(o.sb).getBoundingClientRect().width) || 280;
    let g = null;

    /* メニューを指の位置に置く（x：0＝全開、-W＝閉） */
    function drag(x) {
      const s = q(o.sb),
        c = q(o.scrim),
        w = W();
      x = Math.max(-w, Math.min(0, x));
      s.style.transition = c.style.transition = "none";
      s.style.visibility = "visible";
      s.style.transform = `translateX(${x}px)`;
      c.style.opacity = String(1 + x / w);
    }
    /* 指を離したら、開く／閉じるの位置まで動かして、手で付けた位置を外す */
    function settle(open) {
      const s = q(o.sb),
        c = q(o.scrim);
      o.setDrawer(open);
      requestAnimationFrame(() => {
        s.style.transition = c.style.transition = "";
        s.style.transform = s.style.visibility = c.style.opacity = "";
      });
    }
    /* 画面を指にぴったり付けて動かす（薄くしない）。ms を渡すとその時間で滑らかに動かす */
    const pm = () => q(o.pager.move || o.pager.el);
    function page(x, ms) {
      const m = pm();
      if (!m) return;
      m.style.transition = ms ? `transform ${ms}ms cubic-bezier(.25,.9,.3,1)` : "none";
      m.style.transform = x ? `translate3d(${x}px,0,0)` : "translate3d(0,0,0)";
      m.style.willChange = "transform";
    }
    function pageClear() {
      const m = pm();
      if (m) m.style.transition = m.style.transform = m.style.willChange = "";
    }
    /* 離したら：今の画面をそのまま端まで流し、次の画面を反対側から続けて入れる */
    function flip(dir, from) {
      const w = innerWidth;
      const out = Math.max(90, Math.round(170 * (1 - Math.min(1, Math.abs(from || 0) / w))));
      page(dir > 0 ? -w : w, out);
      setTimeout(() => {
        o.pager.go(dir);
        page(dir > 0 ? w * 0.6 : -w * 0.6, 0);
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            page(0, 260);
            setTimeout(pageClear, 280);
          }),
        );
      }, out);
    }

    document.addEventListener(
      "touchstart",
      e => {
        g = null;
        if (!mq.matches || e.touches.length !== 1) return;
        const t = e.touches[0],
          el = e.target;
        let mode = null;
        if (o.sb && isOpen()) mode = "close";
        else if (o.blocked && o.blocked()) return;
        else if (o.sb && t.clientX < (o.edge || 24)) mode = "open";
        else if (o.pager && !(el.closest && el.closest(o.pager.block))) mode = "page";
        if (mode) g = { mode, x: t.clientX, y: t.clientY, at: Date.now(), lock: false, dx: 0 };
      },
      { passive: true },
    );
    document.addEventListener(
      "touchmove",
      e => {
        if (!g) return;
        const t = e.touches[0],
          dx = t.clientX - g.x,
          dy = t.clientY - g.y;
        if (!g.lock) {
          if (Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy) * 1.2) {
            g.lock = true;
            g.x = t.clientX - Math.sign(dx) * 2; // 動き出しで跳ねないように
            if (o.sb && g.mode === "page" && dx > 0 && !o.pager.can(-1)) g.mode = "open";
          } else if (Math.abs(dy) > 10) return (g = null);
          else return;
        }
        g.dx = t.clientX - g.x;
        if (g.mode === "close") drag(Math.min(0, g.dx));
        else if (g.mode === "open") drag(-W() + Math.max(0, g.dx));
        else page(o.pager.can(g.dx < 0 ? 1 : -1) ? g.dx : g.dx * 0.15, 0);
      },
      { passive: true },
    );
    function end(cancel) {
      if (!g) return;
      const { mode, dx, lock } = g,
        fast = Math.abs(dx) > 35 && Date.now() - g.at < 280,
        w = W();
      g = null;
      if (!lock) return;
      if (mode === "close") settle(cancel ? true : !(dx < -w * 0.3 || (fast && dx < 0)));
      else if (mode === "open") settle(cancel ? false : dx > w * 0.3 || (fast && dx > 0));
      else {
        const dir = dx < 0 ? 1 : -1;
        if (!cancel && (Math.abs(dx) > innerWidth * 0.25 || fast) && o.pager.can(dir)) flip(dir, dx);
        else {
          page(0, 220);
          setTimeout(pageClear, 240);
        }
      }
    }
    document.addEventListener("touchend", () => end(false), { passive: true });
    document.addEventListener("touchcancel", () => end(true), { passive: true });
  };
})();

/* ============================================================
   ここから core.js 本体
   ============================================================ */
/* ===================== エンタメ管理：土台 =====================
   決まった値・画面の状態・作品データの組み立て・保存（Firebase）・マスタ・話数・未入力チェック。
   ファイルの読み込み順：core → view → filters → paste → detail → episodes → epaste → dropdown → form → settings → yt → yt-detail → lists → anilist → al-ui → events → helpers → boot（最後に起動） */

const DOW = ["月", "火", "水", "木", "金", "土", "日"];
/* 左メニュー */
const MODE_NAME = { w: "番組表", a: "アニメ", d: "ドラマ", m: "映画", s: "バラエティ", yt: "YouTube", sr: "シリーズ", mu: "主題歌", o: "その他" };
/* o＝スマホの下メニュー「その他」（映画・バラエティ・YouTube・シリーズ・主題歌のタイル）。左メニューには出さない */
const MODE_KEYS = Object.keys(MODE_NAME).filter(k => k !== "o");
const STATUSES = ["未視聴", "視聴中", "視聴済み", "見ない"];
/* 表示の言い回し：保存データの値は「視聴済み」のまま、画面では「視聴済」と出す */
const stLabel = s => String(s ?? "").replace(/視聴済み/g, "視聴済");
const COLLAB_SUBS_DEF = ["TOP4", "最俺", "P-P"];
const TV_STATIONS = ["フジテレビ", "日本テレビ", "テレビ朝日", "TBS", "テレビ東京", "TOKYO MX", "NHK", "BS", "その他"];
/* よく見る3つ（Netflix・Disney＋・ABEMA）を先頭に固定 */
const VOD_TOP = ["Netflix", "Disney＋", "ABEMA"];
const VODS = [
  "Netflix",
  "Disney＋",
  "ABEMA",
  "U-NEXT",
  "Prime Video",
  "Lemino",
  "dアニメストア",
  "TVer",
];
/* 配信サイトの色（ブランドカラー）[背景, 文字]。ロゴが白黒のサイトは黒系 */
const VOD_COLOR = {
  Netflix: ["#E50914", "#fff"],
  "Disney＋": ["#113CCF", "#fff"],
  ABEMA: ["#000000", "#fff"],
  "U-NEXT": ["#1F2A3A", "#fff"],
  "Prime Video": ["#1A98FF", "#fff"],
  Lemino: ["#7B2CE0", "#fff"],
  dアニメストア: ["#F08300", "#fff"],
  TVer: ["#00A0E9", "#fff"],
};
const vcStyle = v => {
  const c = VOD_COLOR[v];
  return c ? ` style="--vc:${c[0]};--vt:${c[1]}"` : "";
};
const vlab = v => `<span class="lab v${VOD_COLOR[v] ? " vc" : ""}"${vcStyle(v)}>${esc(v)}</span>`;
const MEDIA = [
  ["tv", "TV"],
  ["sp", "TV SP"],
  ["movie", "映画"],
  ["ova", "OVA"],
  ["stream", "配信"],
];
const SONG_TYPES = ["OP", "ED", "主題歌", "挿入歌"];
const SEASONS = ["冬", "春", "夏", "秋"];
const ALLYEAR = "通年";
const SORTS = [
  ["new", "新しい順"],
  ["old", "古い順"],
  ["time", "曜日・時間順"],
  ["title", "タイトル順"],
];
/* ライブラリの見出しの分け方 */
const GROUPS = [
  ["cour", "クール別"],
  ["year", "年別"],
  ["month", "月別"],
  ["series", "シリーズ別"],
  ["none", "分けない"],
];
const K_UI = "adb.v3.ui";
/* 共通部品（shared/u-core.js）：端末に覚える設定・エスケープ */
const ls = U.ls;
/* プルダウンの一覧は、スマホでも下から出すシートにせず、押した欄のすぐ下に小さく出す（PCと同じ） */
U.noSheet = true;
const esc = U.esc;
const $ = s => document.querySelector(s);
/* クリックの割り当て表を上から順に試す。表は [目印のセレクタ, 処理(押した要素, 作品など, イベント)] の並び。
   セレクタが null の行は毎回試す。処理が false を返したら「ここでは扱わない」として次の行へ。どれかが扱ったら true */
function runActions(table, e, ctx) {
  for (const [sel, fn] of table) {
    const el = sel ? e.target.closest(sel) : e.target;
    if (el && fn(el, ctx, e) !== false) return true;
  }
  return false;
}
const mins = t => {
  const m = /^(\d{1,2}):(\d{2})/.exec(t || "");
  return m ? +m[1] * 60 + +m[2] : 9999;
};

/* ---------- 画面の状態 ---------- */
let over = {}, // titles：作品（1作品1件）
  prog = {}; // progress：話数リストと視聴チェック
let items = [],
  eras = [];
/* 画面の状態。mode＝メニュー（w 番組表・a アニメ・d ドラマ・m 映画・s バラエティ・yt YouTube・sr シリーズ・mu 主題歌・o その他）、
   sub＝映画の絞り込み「種類」（all/a アニメ映画/d 実写）。
   そのほかは絞り込み（sf 視聴・era 放送年・type 種別・cour 放送クール・series シリーズ・vod 配信サイト）と並び順 */
const SUBS = { m: ["all", "a", "d"] };
const state = Object.assign(
  {
    mode: "w",
    sub: "all",
    q: "",
    sf: [],
    era: [],
    type: [],
    cour: [],
    courY: new Date().getFullYear(),
    sort: "new",
    grp: "cour",
    vod: "",
    slot: "",
    missOnly: false,
    missKey: "",
    fm: {},
  },
  ls.get(K_UI) || {},
  { q: "", limit: 200, fOpen: "", fSub: "", qOpen: false, wday: "", xser: false },
);
/* 端末に覚えた表示状態のうち、今は無い値は外す */
const arrOf = v => (Array.isArray(v) ? v : v && v !== "すべて" ? [v] : []);
["sf", "era", "cour", "type", "series"].forEach(k => (state[k] = arrOf(state[k])));
if (!state.fm || typeof state.fm !== "object") state.fm = {};
state.sf = state.sf.filter(x => [...STATUSES, "未設定"].includes(x));
if (!SORTS.some(([v]) => v === state.sort)) state.sort = "new";
if (!GROUPS.some(([v]) => v === state.grp)) state.grp = "cour";
if (!MODE_KEYS.includes(state.mode) && state.mode !== "o") state.mode = "w";
if (!(SUBS[state.mode] || ["all"]).includes(state.sub)) state.sub = "all";
if (typeof state.vod !== "string") state.vod = "";
if (typeof state.slot !== "string") state.slot = "";
if (state.view !== "grid") state.view = "list";
state.missOnly = !!state.missOnly;
if (typeof state.missKey !== "string") state.missKey = "";
/* 今の一覧のジャンル：all＝すべて、a＝アニメ、d＝ドラマ（映画では実写映画も）、x＝アニメ以外 */
const curKind = () => (state.mode === "a" || state.mode === "d" ? state.mode : SUBS[state.mode] ? state.sub : "all");
const saveUI = () =>
  ls.set(K_UI, {
    mode: state.mode,
    view: state.view,
    sub: state.sub,
    vod: state.vod,
    slot: state.slot,
    missOnly: state.missOnly,
    missKey: state.missKey,
    sf: state.sf,
    era: state.era,
    type: state.type,
    cour: state.cour,
    courY: state.courY,
    sort: state.sort,
    grp: state.grp,
    series: state.series,
    fm: state.fm,
  });
/* ---------- 作品のデータ：放送形態・主題歌・並び ---------- */
const TYPES = [
  ["すべて", "すべて"],
  ["tv", "TV"],
  ["sp", "TV SP"],
  ["stream", "配信"],
  ["movie", "映画"],
  ["ova", "OVA"],
];
const typeOk = i => !state.type.length || state.type.includes(mediaOf(i).media);
/* 放送形態: media＝tv（放送局 stations）・stream（配信サイト plat）・movie・ova。vods＝見られる配信サイト */
const mediaOf = i => ({ media: i.media || "tv", stations: i.stations || [], plat: i.plat || [], vods: i.vods || [] });
/* 映画・OVA・TV SP：毎週の放送時間と放送クールを持たない（TV SPは1回だけの放送。放送局はある） */
const noSched = m => m === "movie" || m === "ova" || m === "sp";
const hasSt = m => m === "tv" || m === "sp";
const MEDIA_LAB = { tv: "TV", sp: "TV SP", stream: "配信", movie: "映画", ova: "OVA" };
/* 映画の公開：rel＝"stream" なら配信で公開（Netflix映画など）。放送形態は映画のまま */
const relStream = i => mediaOf(i).media === "movie" && i.rel === "stream";
/* 放送形態のラベル [文字, 色クラス]。ジャンル映画の劇場公開はジャンルと同じなので出さない */
const mediaLabOf = i => {
  const md = mediaOf(i).media;
  if (md === "movie") return relStream(i) ? [i.k === "f" ? "配信" : "配信映画", "stream"] : i.k === "f" ? null : ["映画", "movie"];
  return MEDIA_LAB[md] ? [MEDIA_LAB[md], md] : null;
};
const ONE_LAB = { movie: "映画", ova: "OVA", sp: "TV SP" };
/* 主題歌: songs＝[{type,s,a,b,ex}] a〜b話で使われた曲。ex＝飛び飛びのときの追加の話 [{a,b}] */
const songsOf = i => i.songs || [];
/* 曲名とアーティストは入力欄ごとに別々に保存（自動で分けたりつないだりしない）。
   s は検索用に「曲名 アーティスト」を並べたもの。st がない古いデータは s をそのまま曲名として扱う */
const songTA = x => (x.st !== undefined ? { st: x.st || "", ar: x.ar || "" } : { st: x.s || "", ar: "" });
const songJoin = (st, ar) => [st.trim(), ar.trim()].filter(Boolean).join(" ");
function epSpan(it) {
  const ns = (it ? episodes(it) : []).map(e => epNum(e.n)).filter(n => n != null);
  return ns.length ? [Math.min(...ns), Math.max(...ns)] : null;
}
/* 曲の種類ごとの色（OP=青・ED=紫・主題歌=緑・挿入歌=橙） */
const SG_CLS = { OP: "t-op", ED: "t-ed", 主題歌: "t-th", 挿入歌: "t-in" };
const rangeTxt = x =>
  x.a == null && x.b == null ? "" : x.a != null && x.b === x.a ? `${x.a}話` : `${x.a ?? ""}〜${x.b ?? ""}話`;
/* 飛び飛びのときの追加の話：ex＝[{a,b}]。b が空なら a 話だけ */
const exOf = x => (x.ex || []).filter(r => r && r.a != null);
const exTxt = r => (r.b == null || r.b === r.a ? `${r.a}話` : `${r.a}〜${r.b}話`);
/* 使われた話を、範囲ごとのラベルの配列に（話の順に並べる） */
/* sp＝話数リストの[最初, 最後]。渡すと、最初・最後が空の曲は話数リストの最初・最後の話として出す */
const rangeItems = (x, sp) => {
  const l = [];
  if (x.a != null || x.b != null || sp) {
    const y = sp && !x.one ? { a: x.a ?? sp[0], b: x.b ?? sp[1] } : x;
    if (y.a != null || y.b != null) l.push({ a: y.a ?? 1, b: y.b, t: rangeTxt(y) });
  }
  exOf(x).forEach(r => l.push({ a: r.a, b: r.b ?? r.a, t: exTxt(r) }));
  return l.sort((p, q) => p.a - q.a);
};
const rangeList = (x, sp) => rangeItems(x, sp).map(r => r.t);
/* n話がどの範囲に入るか（rangeList の何番目か。入らなければ -1） */
const rangeHit = (x, n, sp) => rangeItems(x, sp).findIndex(r => n >= r.a && (r.b == null || n <= r.b));

/* 並び：o（Notionから取り込んだときの順番）→ あとから追加したものはidの順 */
const byOrder = ([a, x], [b, y]) => (x.o ?? 1e9) - (y.o ?? 1e9) || (a < b ? -1 : a > b ? 1 : 0);
/* 作品＝データベースの titles の各ドキュメント（1作品1件） */
function rebuild() {
  items = Object.entries(over)
    .filter(([, o]) => o && typeof o.t === "string" && !o.deleted)
    .sort(byOrder)
    .map(([id, o]) => {
      const x = { id, k: "a", s: "", dow: -1, time: "", from: "", series: "", url: "", ...o };
      /* 「1900」のように保存されている古い放送時間も「19:00」として扱う */
      const h = normHM(x.time);
      if (h) x.time = h;
      return x;
    });
  buildEras();
}

/* ---------- 放送クール：「2026秋」の形。クールに関係なく続く作品は「通年」 ---------- */
const coursOf = i => i.cours || [];
const courLabel = c =>
  c === ALLYEAR ? "通年" : /^\d{4}/.test(c) ? `${c.slice(0, 4)}年${c.slice(4)}` : c;

/* ---------- 放送年の区切り：1年ずつ。古い年は30作品くらいになるまでまとめる ---------- */
const yearOf = i => +String(i.from || "").slice(0, 4) || 0;
function buildEras() {
  const cnt = {};
  items.forEach(i => {
    if (yearOf(i)) cnt[yearOf(i)] = (cnt[yearOf(i)] || 0) + 1;
  });
  const years = Object.keys(cnt)
    .map(Number)
    .sort((a, b) => b - a);
  const MIN = 30;
  const out = [];
  let cur = null;
  years.forEach(y => {
    if (!cur && cnt[y] >= MIN) {
      out.push({ from: y, to: y, n: cnt[y] });
      return;
    }
    if (!cur) cur = { from: y, to: y, n: 0 };
    cur.from = y;
    cur.n += cnt[y];
    if (cur.n >= MIN) {
      out.push(cur);
      cur = null;
    }
  });
  if (cur) {
    if (out.length && out[out.length - 1].from !== out[out.length - 1].to)
      Object.assign(out[out.length - 1], { from: cur.from, n: out[out.length - 1].n + cur.n });
    else out.push(cur);
  }
  if (out.length) {
    const last = out[out.length - 1];
    if (last.from !== last.to) last.label = `〜${last.to}`;
  }
  out.forEach(b => (b.label = b.label || (b.from === b.to ? String(b.from) : `${b.from}–${String(b.to).slice(2)}`)));
  eras = [
    ...out.map(b => ({ key: b.label, test: i => yearOf(i) >= b.from && yearOf(i) <= b.to })),
    { key: "年不明", test: i => !yearOf(i) },
  ];
  state.era = state.era.filter(k => eras.some(e => e.key === k));
}
const courOk = i => !state.cour.length || coursOf(i).some(c => state.cour.includes(c));
const seriesOk = i => !state.series.length || state.series.includes(i.series);
const sfOk = i => !state.sf.length || state.sf.some(s => (s === "未設定" ? !i.s : i.s === s));
const eraOk = i => !state.era.length || eras.some(e => state.era.includes(e.key) && e.test(i));
const toggle = (arr, v) => (arr.includes(v) ? arr.filter(x => x !== v) : [...arr, v]);
/* 検索用に文字をそろえる（共通部品 U.norm） */
const norm = U.norm;

/* ---------- 保存（Firebase）。保存先への接続とログインは u-core.js（アプリ共通） ---------- */
let db = null;
/* 保存状況：保存中・未保存・再接続などは共通の U.sync（u-core.js）が見張る。
   ここで持つのは最後に変更した時刻だけ（各データに _at として記録し、どの端末でも同じ時刻を出す） */
let lastAt = 0;
function calcLastAt() {
  let m = 0;
  [over, prog, ytOver].forEach(o =>
    Object.values(o || {}).forEach(d => {
      if (d && +d._at > m) m = +d._at;
    }),
  );
  if (m > lastAt) lastAt = m;
}
const fmtAt = t => {
  if (!t) return "";
  const d = new Date(t),
    n = new Date();
  const hm = `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
  return d.toDateString() === n.toDateString()
    ? `今日 ${hm}`
    : `${d.getFullYear() !== n.getFullYear() ? d.getFullYear() + "/" : ""}${d.getMonth() + 1}/${d.getDate()} ${hm}`;
};
const SV_CLS = { ok: "ok", busy: "ing", wait: "ing", err: "err" };
function saveNoteHtml() {
  const [k, t, why] = U.sync.view(!db || isSynced());
  return `<span class="sv ${SV_CLS[k]}"${why ? ` title="${esc(why)}"` : ""}><i></i>${t}</span>${lastAt ? `<span class="svat">最終変更 ${fmtAt(lastAt)}</span>` : ""}`;
}
function updateSaveNote() {
  const h = saveNoteHtml();
  ["#saveNote", "#sbSave"].forEach(q => {
    const n = $(q);
    if (n) n.innerHTML = h;
  });
}
function removeDoc(col, id) {
  lastAt = Date.now();
  return db.doc(`${col}/${id}`).delete();
}
function saveDoc(col, id, data) {
  data._at = Date.now();
  lastAt = data._at;
  return db.doc(`${col}/${id}`).set(data);
}
/* 渡した項目だけ書きかえる（ほかの端末で変えた項目は消さない） */
function mergeDoc(col, id, patch) {
  const data = { ...patch, _at: Date.now() };
  lastAt = data._at;
  return db.doc(`${col}/${id}`).set(data, { merge: true });
}
/* ---------- 同期：最新のデータ（fromCache=false）が届くまで「同期中」。裏から戻ったときのつなぎ直しは U.sync が行う ---------- */
var syncOk = { titles: false, progress: false };
const isSynced = () => syncOk.titles && syncOk.progress;
const bootT = { show: 0, sync: 0 };
/* 話数の編集など、リストをまとめて保存するものは同期中は止める（視聴チェックは話ごとに保存するので止めない） */
function syncBlock() {
  if (isSynced()) return false;
  toast("最新のデータを読み込み中です。少しだけ待ってからもう一度お試しください");
  return true;
}
U.sync.on(updateSaveNote);
/* ---------- マスタ（シリーズ・放送局・配信サイト・投稿者・グループ）：並び順と名前を保存 ---------- */
let master = {};
const MKEYS = [
  ["series", "シリーズ"],
  ["stations", "放送局"],
  ["slots", "放送枠（ドラマ）"],
  ["vods", "配信サイト"],
  ["authors", "YouTube投稿者"],
  ["soloGroups", "一人実況のグループ"],
  ["groups", "コラボのグループ"],
];
function usedNames(key) {
  const c = {};
  const add = n => {
    if (n) c[n] = (c[n] || 0) + 1;
  };
  /* シリーズはアニメ・ドラマ・映画・バラエティで共通の1つ（実写化などをまたいで同じ名前を使う） */
  if (key === "series") items.forEach(i => add(i.series));
  else if (key === "stations") items.forEach(i => mediaOf(i).stations.forEach(add));
  else if (key === "slots") items.forEach(i => add(i.slot));
  else if (key === "vods")
    items.forEach(i => {
      const m = mediaOf(i);
      [...new Set([...m.plat, ...m.vods])].forEach(add);
    });
  else if (key === "authors") ytItems.forEach(x => add(x.a));
  else if (key === "groups") ytItems.forEach(x => add(ytSub(x)));
  else if (key === "soloGroups") ytItems.forEach(x => add(ytSolo(x)));
  return c;
}
const MDEF = { stations: TV_STATIONS, vods: VODS, groups: COLLAB_SUBS_DEF, soloGroups: ["シリーズ", "単発"] };
/* マスタの並び（保存した順 → まだマスタにない使用中の名前を件数順で後ろに） */
function M(key) {
  const c = usedNames(key);
  const base = Array.isArray(master[key]) ? master[key] : MDEF[key] || [];
  const rest = Object.keys(c)
    .filter(n => !base.includes(n))
    .sort((a, b) => c[b] - c[a] || a.localeCompare(b, "ja"));
  return [...base, ...rest];
}
async function saveMaster() {
  try {
    await saveDoc("master", "all", master);
  } catch (e) {
    fail(e);
  }
}
function banner(html) {
  $("#banner").innerHTML = html
    ? `<div class="banner" role="status"><div style="flex:1;min-width:200px">${html}</div></div>`
    : "";
}
async function doLogout() {
  const s = await U.store();
  if (s.logout) await s.logout();
  else location.reload();
}
/* 前の版の形で保存されているデータを、今の形に直して保存し直す（最初に読み込んだとき1回だけ。直すものがなければ何もしない）
   ・シリーズの並び：アニメ用（seriesA）・ドラマ用（seriesD）の2つ → 共通の1つ（series）に。作品がないドラマ用のシリーズはメインのジャンルをドラマに
   ・「毎週の放送ではない」作品（曜日なし・放送時間なしの印なし） → 「放送時間なし」に
   最終変更の時刻（_at）は変えない */
let oldFixed = false;
function fixOldData() {
  if (oldFixed) return;
  oldFixed = true;
  const put = (path, data) => db.doc(path).set(data).catch(fail);
  if (Array.isArray(master.seriesA) || Array.isArray(master.seriesD)) {
    const { seriesA = [], seriesD = [], ...m } = master;
    if (!Array.isArray(m.series)) m.series = [...new Set([...seriesA, ...seriesD])];
    const used = new Set(Object.values(over).map(o => o && o.series));
    const sm = { ...(m.seriesMain || {}) };
    seriesD.forEach(n => !sm[n] && !used.has(n) && (sm[n] = "d"));
    m.seriesMain = sm;
    master = m;
    put("master/all", m);
  }
  Object.entries(over).forEach(([id, o]) => {
    if (!o || typeof o.t !== "string" || o.deleted) return;
    const md = o.media || "tv";
    if (noSched(md) || !o.from || (o.dow ?? -1) >= 0 || (o.noF || []).includes("time")) return;
    over[id] = { ...o, noF: [...(o.noF || []), "time"] };
    mergeDoc("titles", id, { noF: over[id].noF }).catch(fail);
    if (loaded) rebuild();
  });
  /* 配信URL：貼り付けたときと同じ形（プライムビデオ・TVer など）にそろえる */
  if (typeof normVurl === "function")
    Object.entries(over).forEach(([id, o]) => {
      if (!o || typeof o.vurl !== "string" || !o.vurl) return;
      const v = normVurl(o.vurl);
      if (v === o.vurl) return;
      over[id] = { ...o, vurl: v };
      mergeDoc("titles", id, { vurl: v }).catch(fail);
      if (loaded) rebuild();
    });
}
/* 前の版で TV SP を追加したときに自動で作っていた話「SP」（1話だけ）を消す（番組表は放送日で出すので不要。最初に読み込んだとき1回だけ） */
let spDropped = false;
function dropAutoSp() {
  if (spDropped || !db) return;
  spDropped = true;
  Object.entries(prog).forEach(([id, p]) => {
    const o = over[id];
    if (!o || o.media !== "sp" || !p || !Array.isArray(p.eps) || p.eps.length !== 1 || p.eps[0].n !== "SP") return;
    delete prog[id];
    removeDoc("progress", id).catch(fail);
  });
}
/* ゴミ箱：削除した作品は deleted（削除した日時）を付けて30日残し、過ぎたら完全に削除する（最新のデータが届いたあと1回だけ） */
const TRASH_DAYS = 30;
const purged = { titles: false, yt: false };
function trashGone(col, id) {
  const src = col === "yt" ? ytOver : over;
  delete src[id];
  removeDoc(col, id).catch(fail);
  if (col === "titles") {
    delete prog[id];
    removeDoc("progress", id).catch(fail);
  }
  /* 画像も消す（作品は作品ID、YouTube は yt_ID） */
  removeImageDocs(col === "yt" ? "yt_" + id : id);
}
function purgeTrash(col) {
  if (purged[col] || !db) return;
  purged[col] = true;
  const lim = Date.now() - TRASH_DAYS * 864e5;
  Object.entries(col === "yt" ? ytOver : over).forEach(([id, o]) => {
    if (o && o.deleted && +o.deleted < lim) trashGone(col, id);
  });
}
/* 保存先につないで、作品・話数と視聴チェック・マスタ・YouTube を読み込む（ほかの端末で変えた分も自動で反映） */
async function initStore() {
  const conn = await U.store();
  if (!conn.db) {
    banner(`<b>保存先に接続できませんでした</b>${esc(conn.error?.message || "")}　電波のよい場所で開き直してください。`);
    return;
  }
  db = conn.db;
  const got = { titles: false, progress: false, master: false };
  const done = () => {
    if (got.titles && got.master) fixOldData();
    if (!got.titles || !got.progress) return;
    loaded = true;
    dropAutoSp();
    calcLastAt();
    rebuild();
    fillEpTimesAll();
    render();
    if (openId && !epEdit) refreshSheet();
  };
  /* 読み込みが止まったときは U.sync が自動でつなぎ直す。ここでは「同期中」に戻すだけ */
  const onErr = k => () => {
    if (k && syncOk[k]) {
      syncOk[k] = false;
      updateSaveNote();
    }
  };
  const docsOf = s => {
    const m = {};
    s.docs.forEach(d => (m[d.id] = d.data()));
    return m;
  };
  /* fromCache＝端末に残っていた古いデータ。最新（fromCache=false）が届いたら同期完了 */
  const syncMark = (k, s) => {
    const ok = s.fromCache === false;
    /* 起動の速さ（設定に表示）：最初に画面に出せた時間・最新データが届いた時間 */
    if (!bootT.show) bootT.show = performance.now();
    if (syncOk[k] !== ok) {
      syncOk[k] = ok;
      if (ok && isSynced() && !bootT.sync) bootT.sync = performance.now();
      updateSaveNote();
    }
  };
  db.collection("titles").onSnapshot(
    s => {
      syncMark("titles", s);
      over = docsOf(s);
      if (s.fromCache === false) {
        purgeTrash("titles");
        cleanWideImages();
      }
      got.titles = true;
      done();
    },
    onErr("titles"),
    { meta: true },
  );
  db.collection("progress").onSnapshot(
    s => {
      syncMark("progress", s);
      prog = docsOf(s);
      got.progress = true;
      done();
      if (s.fromCache === false) migrateProg();
    },
    onErr("progress"),
    { meta: true },
  );
  db.collection("master").onSnapshot(s => {
    const d = s.docs.find(x => x.id === "all");
    master = d ? d.data() : {};
    got.master = true;
    if (got.titles) fixOldData();
    render();
    refreshSettings();
  }, onErr());
  db.collection("yt").onSnapshot(s => {
    ytOver = docsOf(s);
    if (s.fromCache === false) purgeTrash("yt");
    calcLastAt();
    ytRebuild();
    render();
    if (ytOpen) ytRefresh();
  }, onErr());
}
/* ---------- 話数（放送日時は「分」で持つ。日本時間の深夜25時台は前日扱い） ---------- */
const NOWMIN = () => Math.floor(Date.now() / 60000);
const WEEK = 7 * 1440;
/* 時刻をそろえる（番組の放送時間・話数の時刻で共通）：「1900」「19：00」「１９００」→「19:00」、「2430」→「24:30」。空は ""、読めなければ null */
const normHM = s => {
  const v = String(s || "")
    .trim()
    .replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/：/g, ":");
  if (!v) return "";
  const m = /^(\d{1,2}):?(\d{2})$/.exec(v);
  return m && +m[1] <= 29 && +m[2] <= 59 ? `${+m[1]}:${m[2]}` : null;
};
function dayTimeToT(day, hm) {
  // 放送日＋「25:23」のような時刻（日本時間）→ 1970年からの分（世界時）
  if (!day) return 0;
  const [y, m, d] = day.split("-").map(Number);
  const v = mins(hm);
  return Math.floor(Date.UTC(y, m - 1, d) / 60000) + (v < 9999 ? v : 9 * 60) - 540;
}
const hasTime = it => mins(it.time) < 9999;
// 時刻なしの日付は 0:00 UTC（日本時間 9:00）で持っているので、時刻としては出さない
const noTime = (e, it) => e.nt || (e.t % 1440 === 0 && !(it && mins(it.time) === 540));
/* 番組に放送時間があるとき、日付だけ入っていて時刻が未入力の話に番組の放送時間を入れる（入れた話の数を返す）。
   日付のない話・時刻が入っている話はそのまま */
/* 放送枠の変更：作品の slots = [{a:その話から, dow:曜日（DOWの番号。-1＝変えない）, time:時刻（""＝変えない）}]。
   最初の枠は作品の開始日・放送時間のまま。長編で途中に曜日・時間が変わっても、アラートや時刻の自動入力が追いつくようにする */
const slotsOf = it => (it.slots || []).filter(x => x && x.a != null).slice().sort((x, y) => x.a - y.a);
/* 話ごとの「その時点で効いている枠の変更」（数字でない話は直前の話と同じ。なければ null） */
function epSlotMap(it, l) {
  const sl = slotsOf(it);
  if (!sl.length) return l.map(() => null);
  let cur = null;
  return l.map(e => {
    const nn = epNum(e.n);
    if (nn != null) {
      let x = null;
      for (const r of sl) {
        if (nn >= r.a) x = r;
        else break;
      }
      if (x) cur = x;
    }
    return cur;
  });
}
function fillEpTime(it, list) {
  let n = 0;
  const sm = epSlotMap(it, list);
  list.forEach((e, i) => {
    if (!e.t || !noTime(e, it)) return;
    /* その話の時点の枠に時刻があればその時刻、なければ作品の放送時間 */
    const tm = sm[i] && sm[i].time ? sm[i].time : it.time;
    if (!(mins(tm) < 9999)) return;
    e.t = dayTimeToT(jst(e.t).day, tm);
    e.nt = false;
    n++;
  });
  return n;
}
/* 最新のデータが届いたあと1回だけ：登録済みの作品にも同じように入れる（話数リストだけ書きかえ、視聴チェックは触らない） */
let epTimeFilled = false;
function fillEpTimesAll() {
  if (epTimeFilled || !db || !isSynced()) return;
  epTimeFilled = true;
  items.forEach(it => {
    const p = prog[it.id];
    if (!hasWMap(p) || !Array.isArray(p.eps)) return;
    const l = episodes(it);
    if (!fillEpTime(it, l)) return;
    const at = Date.now();
    const eps = progDoc(l).eps;
    prog[it.id] = { ...p, eps, _at: at };
    lastAt = at;
    db.doc(`progress/${it.id}`).update({ eps, _at: at }).catch(fail);
  });
}
const epWhen = (e, it, withYear) => {
  const j = jst(e.t);
  if (!j) return "";
  return `${withYear && j.y !== new Date().getFullYear() ? j.y + "/" : ""}${j.md}(${j.dow})${noTime(e, it) ? "" : " " + j.hm}`;
};
/* 話ごとの「見た」の印は progress の w に { 話のキー: 見た日時 } で持つ（1＝日時なし、null・なし＝未視聴）。
   話のキー＝話の名前（同じ名前が2つ以上あるときは2つ目から「#2」…を付ける）。
   w がない作品は前の形（eps の各話に w・wt）として読む */
function epKeys(list) {
  const c = {};
  return list.map((e, i) => {
    const b = String(e.n || "").trim() || `#${i + 1}`;
    c[b] = (c[b] || 0) + 1;
    return c[b] > 1 ? `${b}#${c[b]}` : b;
  });
}
const hasWMap = p => !!(p && p.w && typeof p.w === "object" && !Array.isArray(p.w));
function episodes(it) {
  const p = prog[it.id];
  if (!p || !Array.isArray(p.eps)) return [];
  const m = hasWMap(p) ? p.w : null;
  const ks = m ? epKeys(p.eps) : null;
  return p.eps.map((e, i) => {
    const v = m ? +m[ks[i]] || 0 : e.w ? +e.wt || 1 : 0;
    return { n: e.n || "", sub: e.s || "", t: e.t || 0, w: v > 0, nt: !!e.nt, wt: v > 1 ? v : 0, sp: !!e.sp, x: !!e.x, na: !!e.na, go: e.go || 0 };
  });
}
/* 話数リストまるごとの保存用の中身（eps の w・wt は前の版の画面が開いたままの端末のための控え。読むときは w の印を使う） */
function progDoc(list) {
  const ks = epKeys(list),
    w = {};
  list.forEach((e, i) => {
    if (e.w) w[ks[i]] = e.wt || 1;
  });
  return {
    /* 未放送の話（na）は日付を持たない */
    eps: list.map(e => ({ n: e.n, s: e.sub || "", t: e.na ? 0 : e.t || 0, ...(e.nt ? { nt: 1 } : {}), ...(e.sp ? { sp: 1 } : {}), ...(e.x ? { x: 1 } : {}), ...(e.na ? { na: 1 } : {}), ...(e.go && e.go === e.t ? { go: e.go } : {}), ...(e.w ? { w: 1 } : {}), ...(e.w && e.wt ? { wt: e.wt } : {}) })),
    w,
  };
}
/* 前の形のままの話数を、今の形に直して保存し直す（最新のデータが届いたあと、1回だけ） */
let progMigrated = false;
async function migrateProg() {
  if (progMigrated || !db) return;
  progMigrated = true;
  const list = Object.entries(prog)
    .filter(([, p]) => p && Array.isArray(p.eps) && !hasWMap(p))
    .map(([id, p]) => {
      const d = progDoc(episodes({ id }));
      if (p._at) d._at = p._at;
      prog[id] = d;
      return [`progress/${id}`, d];
    });
  if (!list.length) return;
  try {
    for (let i = 0; i < list.length; i += 400) await db.setMany(list.slice(i, i + 400));
  } catch (e) {
    fail(e);
  }
}
const aired = e => !e.t || e.t <= NOWMIN();
/* 見ない話（配信にない総集編など）：視聴チェックの対象にしない。done＝見た話か見ない話 */
const done = e => e.w || e.x;
const watchable = l => l.filter(e => !e.x);
/* 話数の抜け・重複の場所。gap＝その話の直前に抜けている話数（[最初, 最後]）、dup＝同じ話数がほかにもある話。
   ok＝「問題なし」にした抜け（"41-41" の形）。数字の話数だけ見る */
function epGapDup(eps, ok) {
  const gap = new Map(),
    dup = new Set();
  const nums = eps.map(e => (e.sp ? null : epNum(e.n)));
  const cnt = {};
  nums.forEach(n => n != null && (cnt[n] = (cnt[n] || 0) + 1));
  nums.forEach((n, i) => n != null && cnt[n] > 1 && dup.add(i));
  /* 整数の話数を小さい順に見て、間が空いていたら、空いた後の話（並びで最初に出てくる行）に印を付ける */
  const ints = [...new Set(nums.filter(n => n != null && Number.isInteger(n)))].sort((a, b) => a - b);
  for (let k = 1; k < ints.length; k++)
    if (ints[k] - ints[k - 1] > 1) {
      const g = [ints[k - 1] + 1, ints[k] - 1];
      if ((ok || []).includes(`${g[0]}-${g[1]}`)) continue;
      const i = nums.indexOf(ints[k]);
      if (i >= 0) gap.set(i, g);
    }
  return { gap, dup };
}
function nextInfo(it) {
  const l = episodes(it);
  const un = l.filter(e => !done(e));
  return { all: l, back: un.filter(aired), up: un.find(e => !aired(e)) };
}
function jst(t) {
  if (!t) return null;
  const d = new Date((t + 540) * 60000);
  let h = d.getUTCHours();
  const mi = d.getUTCMinutes();
  let day = d;
  if (h < 5) {
    h += 24;
    day = new Date(d.getTime() - 86400e3);
  }
  return {
    md: `${day.getUTCMonth() + 1}/${day.getUTCDate()}`,
    dow: "日月火水木金土"[day.getUTCDay()],
    hm: `${h}:${String(mi).padStart(2, "0")}`,
    y: day.getUTCFullYear(),
    day: day.toISOString().slice(0, 10),
  };
}
/* 最終回：通年の作品以外で、登録されている最後の話 */
const finIdx = it => {
  if (coursOf(it).includes(ALLYEAR)) return -1;
  const l = episodes(it);
  return l.length > 1 ? l.length - 1 : -1;
};
const FIN = '<span class="fin">最終回</span>';
/* ---------- 未入力チェック（一覧のバッジ・詳細のアラート・絞り込み） ----------
   編集画面の項目のうち、その作品に関係あるものだけを見る。シリーズは「なければ空欄」なので対象外。
   k＝表示名、j＝押したときに開く編集項目（data-jump）、n＝「なし」にできる項目のキー（noF） */
/* 今日（日本時間）のクール：1〜3月＝冬、4〜6月＝春、7〜9月＝夏、10〜12月＝秋 */
const nowCour = () => {
  const d = new Date(Date.now() + 540 * 60000);
  return `${d.getUTCFullYear()}${SEASONS[Math.floor(d.getUTCMonth() / 3)]}`;
};
const IS_PC = () => matchMedia("(min-width:900px)").matches;
/* ---------- 話数の日付のチェック（話数タブの「要確認」・未入力アラートの「日付の確認」） ----------
   rev＝前の話より前の日付 / gap＝前の話から180日以上空いている / start＝1話の日付が開始日と違う /
   dow＝放送曜日と1日ずれている（深夜枠で実際の日付と「木 26:00」の書き方が混ざったとき。-1＝1日前にずらす、1＝1日後に）
   映画は対象外。OVAは発売の間が空くことが多いので gap を見ない。
   「問題なし」を押した話は rev・gap・dow を見ない（go＝押したときの日時。日付を変えたらまたチェックする）。全話が同じ日（まとめて配信）のときは曜日を見ない */
const dayNo = d => Math.round(Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) / 86400e3);
const DATE_WHY = { rev: "前の話より前の日付です", gap: "前の話から半年以上空いています", start: "開始日と違います", dow: "放送曜日と1日ずれています" };
function epDateCheck(it) {
  const md = mediaOf(it).media;
  const l = episodes(it);
  const out = { eps: l.map(() => null), start: "", dowN: 0, n: 0 };
  if (md === "movie" || upcoming(it)) return out;
  const ds = l.map(e => (e.t ? jst(e.t).day : ""));
  const dated = ds.filter(Boolean);
  if (!dated.length) return out;
  const mark = (i, k, v = true) => ((out.eps[i] = out.eps[i] || {})[k] = v);
  let prev = -1;
  ds.forEach((d, i) => {
    if (!d) return;
    if (prev >= 0) {
      const g = dayNo(d) - dayNo(ds[prev]);
      const ok = l[i].go && l[i].go === l[i].t;
      if (g < 0) !ok && mark(i, "rev");
      else if (g >= 180 && md !== "ova" && !ok) mark(i, "gap");
    }
    prev = i;
  });
  const f = normDate(it.from || "");
  if (f && ds[0] && ds[0] !== f) {
    mark(0, "start");
    out.start = ds[0];
  }
  const weekly = !noSched(md) && f && !(it.noF || []).includes("time") && !dated.every(d => d === dated[0]);
  if (weekly) {
    const fd = (dayNo(f) + 4) % 7; // 1970/1/1＝木
    /* 放送枠の変更が登録されていれば、その話の時点の枠の曜日と比べる */
    const sm = epSlotMap(it, l);
    ds.forEach((d, i) => {
      /* 「問題なし」を押した話は見ない（途中で放送曜日が変わった作品など） */
      if (!d || (l[i].go && l[i].go === l[i].t)) return;
      const bfd = sm[i] && sm[i].dow >= 0 ? (sm[i].dow + 1) % 7 : fd;
      const df = ((dayNo(d) + 4) % 7 - bfd + 7) % 7;
      if (df === 1 || df === 6) {
        mark(i, "dow", df === 1 ? -1 : 1);
        out.dowN++;
      }
    });
  }
  out.n = out.eps.filter(Boolean).length;
  return out;
}
const todayStr = () => new Date(Date.now() + 540 * 60000).toISOString().slice(0, 10);
/* 開始日が今日より後（放送前）の作品は、要確認を全部出さない（一覧・詳細・絞り込み・話数タブ・話数の編集・作品の編集）。開始日になったら出る */
const upcoming = i => !!i && (normDate(String(i.from || "").slice(0, 10)) || "") > todayStr();
/* 話数の抜け・重複（放送前の作品は見ない） */
const epGD = (it, l) => (upcoming(it) ? { gap: new Map(), dup: new Set() } : epGapDup(l, it.gapOk));
/* 最初のクールが、開始日（または2週間後）の季節と合っているか（9月末スタートの秋アニメなど） */
function courMismatch(i) {
  const cs = coursOf(i).filter(c => /^\d{4}/.test(c) && c !== ALLYEAR);
  if (!cs.length) return false;
  const first = cs.slice().sort((a, b) => courKey(a) - courKey(b))[0];
  const f = Date.parse(i.from.slice(0, 10) + "T00:00:00Z");
  if (isNaN(f)) return false;
  const cour = t => {
    const d = new Date(t);
    return `${d.getUTCFullYear()}${SEASONS[Math.floor(d.getUTCMonth() / 3)]}`;
  };
  return ![0, 14].some(k => cour(f + k * 86400e3) === first);
}
const courKey = c => +c.slice(0, 4) * 10 + SEASONS.indexOf(c.slice(4));
/* 配信URLのドメインから配信サイトを判定（分からないURLは null） */
const VURL_SITES = [
  [/netflix\.com/, "netflix"],
  [/disneyplus\.com|disney\.co\.jp/, "disney"],
  [/abema\.tv|abema\.app/, "abema"],
  [/unext\.jp/, "unext"],
  [/primevideo\.com|amazon\.co\.jp|amazon\.com/, "amazon"],
  [/animestore\.docomo\.ne\.jp/, "danime"],
  [/lemino\.docomo\.ne\.jp/, "lemino"],
  [/tver\.jp/, "tver"],
  [/youtube\.com|youtu\.be/, "youtube"],
  [/tv\.apple\.com/, "apple"],
  [/crunchyroll\.com/, "crunchyroll"],
];
const vurlSite = u => {
  const s = String(u || "").toLowerCase();
  const hit = s && VURL_SITES.find(([re]) => re.test(s));
  return hit ? hit[1] : null;
};
/* 配信サイト名を判定用の名前に（Netflix・Disney＋・ABEMA・U-NEXT・Prime Video・dアニメストアなど） */
const normVod = v => {
  const s = String(v || "").normalize("NFKC").toLowerCase().replace(/[\s\-・＋+]/g, "");
  if (/netflix|ネトフリ/.test(s)) return "netflix";
  if (/disney|ディズニー/.test(s)) return "disney";
  if (/abema|アベマ/.test(s)) return "abema";
  if (/unext/.test(s)) return "unext";
  if (/prime|amazon|アマゾン/.test(s)) return "amazon";
  if (/dアニメ|danime/.test(s)) return "danime";
  if (/lemino/.test(s)) return "lemino";
  if (/tver/.test(s)) return "tver";
  if (/youtube/.test(s)) return "youtube";
  if (/apple/.test(s)) return "apple";
  if (/crunchyroll/.test(s)) return "crunchyroll";
  return s;
};
/* 要確認の項目の一覧（1つの表にまとめる。並び＝一覧のバッジ・詳細のアラートに出る順）
   g＝絞り込みのまとまり、k＝表示名（作品によって名前が変わるものは候補を全部）、j＝押したときに開く編集項目（data-jump）、
   n＝「なし」にできる項目のキー（noF に入っていれば出さない）、ns＝「なし」ボタンで曲を「なし」にできる項目。
   test(c)＝出すときは true（名前が変わるものはその名前）。c は作品ごとに1回だけ作る材料（missCtx） */
const MISS_CHECKS = [
  { g: "基本情報", k: "ステータス", test: c => !c.i.s },
  { g: "話数", k: "話数", test: c => !c.ns && !c.eps.length },
  /* アニメ：登録済みの話のうち、1話でもサブタイトルが空なら（「なし」にはできない。サブタイトル欄はアニメだけ）
     今クール・通年の作品はサブタイトル未定が多いので対象外 */
  { g: "話数", k: "サブタイトル", test: c => c.i.k === "a" && !(c.ns && c.eps.length < 2) && !coursOf(c.i).some(x => x === ALLYEAR || x === nowCour()) && c.eps.some(e => !(e.sub || "").trim()) },
  { g: "話数", k: "話数の表記", test: c => c.eps.some(e => !epVal(e.n) && !e.sp) },
  { g: "話数", k: "日付の確認", test: c => epDateCheck(c.i).n > 0 },
  /* 話数の抜け（1・2・4話…）・重複（同じ話数が2つ）。数字の話数だけ見る（5.5話などは抜けに数えない） */
  { g: "話数", k: "話数の抜け", test: c => c.gd.gap.size > 0 },
  { g: "話数", k: "話数の重複", test: c => c.gd.dup.size > 0 },
  { g: "基本情報", k: ["開始日", "公開日", "発売日", "放送日"], j: "f-from", test: c => !c.i.from && ({ movie: "公開日", ova: "発売日", sp: "放送日" }[c.md] || "開始日") },
  { g: "基本情報", k: ["放送時間", "配信時間"], j: "f-time", n: "time", test: c => !c.ns && !(c.i.time || "").trim() && (c.md === "stream" ? "配信時間" : "放送時間") },
  { g: "基本情報", k: "放送局", j: "fMedia", n: "st", test: c => hasSt(c.md) && !c.m.stations.length },
  { g: "基本情報", k: "配信サイト", j: "fMedia", n: "plat", test: c => c.md === "stream" && !c.m.plat.length },
  { g: "基本情報", k: "配信サイト", j: "fMedia", n: "vods", test: c => c.md !== "stream" && !c.m.vods.length },
  { g: "基本情報", k: "放送クール", j: "coursBox", n: "cours", test: c => !c.ns && !coursOf(c.i).length },
  /* クールと開始日が合わない（最初のクールが開始日の季節と違う。9月末スタートの秋アニメなどは2週間までずれてよい） */
  { g: "ずれ", k: "クールのずれ", j: "coursBox", test: c => !c.ns && c.i.from && courMismatch(c.i) },
  /* 曲が1曲もなく「なし」にもしていないときだけ（OP・ED・主題歌まとめて1項目） */
  { g: "曲", k: "OP・ED・主題歌", j: "sgList", ns: 1, test: c => !c.sl.some(x => (x.s || "").trim()) && !(c.i.noSongs || []).length },
  /* 曲名・アーティストのどちらかだけ入っている曲（編集画面の2つの入力欄と同じ中身で判定） */
  { g: "曲", k: "アーティスト", j: "sgList", test: c => c.ta.some(x => x.st && !x.ar) },
  { g: "曲", k: "曲名", j: "sgList", test: c => c.ta.some(x => !x.st && x.ar) },
  /* 曲の使われた話が、登録されている話数を超えている（OPが1〜30話なのに24話まで、など） */
  { g: "曲", k: "曲の話数", j: "sgList", test: c => c.em > 0 && c.sl.some(x => [x.a, x.b, ...exOf(x).flatMap(r => [r.a, r.b])].some(v => v != null && +v > c.em)) },
  { g: "基本情報", k: "公式サイト", j: "f-url", n: "url", test: c => !(c.i.url || "").trim() },
  /* 配信サイトを「なし」にした作品は配信URLもいらない */
  { g: "基本情報", k: "配信URL", j: "f-vurl", n: "vurl", test: c => !(c.i.vurl || "").trim() && !nofHas(c.i, c.md === "stream" ? "plat" : "vods") },
  /* 配信URLのサイトが、作品の配信サイトに入っていない（URLからサイトが分かるときだけ） */
  { g: "ずれ", k: "配信URLのずれ", j: "f-vurl", test: c => { const us = vurlSite(c.i.vurl); return !!us && ![...c.m.plat, ...c.m.vods].some(v => normVod(v) === us); } },
];
/* 判定の材料：話数リストなどを作品ごとに1回だけ作る */
function missCtx(i) {
  const m = mediaOf(i),
    eps = episodes(i),
    sl = songsOf(i);
  const nums = eps.filter(e => !e.sp).map(e => epNum(e.n)).filter(n => n != null);
  return {
    i,
    m,
    md: m.media,
    ns: noSched(m.media),
    eps,
    sl,
    gd: epGD(i, eps),
    em: Math.max(0, ...nums),
    ta: sl.filter(x => (x.s || "").trim()).map(x => ({ st: songTA(x).st.trim(), ar: songTA(x).ar.trim() })),
  };
}
/* 作品の要確認の項目：[{k, j, n, ns}] */
function missingOf(i) {
  if (upcoming(i)) return [];
  const c = missCtx(i),
    nf = i.noF || [];
  const out = [];
  MISS_CHECKS.forEach(x => {
    if (x.n && nf.includes(x.n)) return;
    const r = x.test(c);
    if (r) out.push({ k: typeof r === "string" ? r : x.k, j: x.j || "", n: x.n || "", ...(x.ns ? { ns: 1 } : {}) });
  });
  return out;
}
/* 「なし」にできる項目（noF に入れる）。ステータス・話数・開始日は必ずあるはずなので「なし」にしない */
const NOF_LAB = { time: "時間", st: "放送局", plat: "配信サイト", vods: "配信サイト", cours: "放送クール", url: "公式サイト", vurl: "配信URL" };
const nofHas = (i, k) => (i.noF || []).includes(k);
const nofBox = (k, lab) =>
  `<label class="yr nofl" title="${lab || NOF_LAB[k]}なし"><input type="checkbox" class="nof" value="${k}" ${(form.noF || []).includes(k) ? "checked" : ""} aria-label="${lab || NOF_LAB[k]}なし"><span>なし</span></label>`;
/* 絞り込みの「要確認」の選択肢のまとまり（MISS_CHECKS から作る） */
const MISS_GROUPS = ["話数", "基本情報", "曲", "ずれ"].map(g => [g, [...new Set(MISS_CHECKS.filter(x => x.g === g).flatMap(x => [].concat(x.k)))]]);
/* 端末に覚えた「要確認」の項目のうち、今は無いものは外す */
if (state.missKey && !MISS_CHECKS.some(x => [].concat(x.k).includes(state.missKey))) state.missKey = "";
/* 一覧のバッジ：件数だけ（話数がないときだけ赤） */
/* 一覧の札は件数だけ（項目の名前はマウスを乗せると出る・詳細のアラートと絞り込みで見る）。YouTube も同じ形 */
const missPill = (names, hot) =>
  names.length ? `<span class="miss${hot ? " hot" : ""}" title="要確認：${esc(names.join("・"))}"><b>要確認</b><span class="mh">${names.length}</span></span>` : "";
function missBadge(i) {
  const names = missingOf(i).map(x => x.k);
  return missPill(names, names.includes("話数"));
}
function missOk(i) {
  if (!state.missOnly) return true;
  const l = missingOf(i);
  return state.missKey ? l.some(x => x.k === state.missKey) : l.length > 0;
}
/* 話数は数字だけ（5.5 など小数も可）。「1話」「第1話」「1」「第一話」「第一幕」は数字の話数（漢数字・「第◯」の後ろの単位も可。EP_NUM・EP_NOT・kanjiNum は paste.js）。
   それ以外（OVA・総集編など）は名前の話（sp）。話数の欄に名前を入れると sp になる（parseEpIn）。sp でない古い書き方の話数は表記アラートの対象 */
let EP_PLAIN = null;
const epVal = n => {
  EP_PLAIN = EP_PLAIN || new RegExp(`^(?:第\\s*(${EP_NUM})\\s*(?:${EP_NOT}\\p{L})?|(${EP_NUM})\\s*[話回幕夜]?)$`, "u");
  const m = EP_PLAIN.exec(String(n ?? "").trim());
  if (!m) return "";
  const t = zen(m[1] || m[2]);
  const k = /^[\d.]+$/.test(t) ? +t : kanjiNum(t);
  return Number.isFinite(k) ? String(k) : "";
};
/* 並び順・照合用の話数（数字の話数でなければ、文字の中の最初の数字） */
const epNum = n => {
  const v = epVal(n);
  if (v) return +v;
  const m = /\d+(?:\.\d+)?/.exec(n || "");
  return m ? +m[0] : null;
};
const epLab = v => `${+v}話`;
/* 話数の欄に入れた文字：数字（「3」「第3話」「３話」など）は「3話」、それ以外は書いたとおりの名前（SP・総集編など） */
const parseEpIn = t => {
  const v = epVal(String(t).trim());
  return v ? { n: epLab(v), sp: false } : { n: String(t).trim(), sp: true };
};
/* 折りたたみの印（FOLD_IC）と並び替え（GRIP／SORT_DONE）は、ほかのアプリと共通で shared/u-core.js にある */
