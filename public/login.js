(function(){
  'use strict';
  const auth = () => firebase.auth();

  function $(id){ return document.getElementById(id); }
  function setMsg(msg, isError=false){
    const el = $("loginMsg");
    if (!el) return;
    el.textContent = msg || '';
    el.style.color = isError ? '#c62828' : '#2e7d32';
  }

  // メール/パスワードでログイン
  async function login(evt){
    if (evt) evt.preventDefault();
    const emailEl = $("loginEmail");
    const passEl  = $("loginPassword");
    const btn     = $("loginBtn");

    const email = (emailEl?.value || '').trim();
    const password = passEl?.value || '';
    if (!email || !password){ setMsg('メールアドレスとパスワードを入力してください。', true); return; }

    btn?.setAttribute('disabled','disabled');
    setMsg('ログイン中...');

    try {
      // 永続化設定（必要なければ削除可）
      try { await auth().setPersistence(firebase.auth.Auth.Persistence.LOCAL); } catch(_) {}
      await auth().signInWithEmailAndPassword(email, password);
      setMsg('ログインしました。移動します...');
      // 遷移先は必要に応じて変更
      setTimeout(()=> location.href = 'index.html', 200);
    } catch (e) {
      console.error(e);
      setMsg(e?.message || 'ログインに失敗しました。', true);
    } finally {
      btn?.removeAttribute('disabled');
    }
  }

  // パスワードリセット（メール宛）
  async function sendReset(evt){
    if (evt) evt.preventDefault();
    const email = ($("loginEmail")?.value || '').trim();
    if (!email){ setMsg('パスワードリセットにはメールアドレスが必要です。', true); return; }
    setMsg('パスワードリセットメールを送信中...');
    try {
      await auth().sendPasswordResetEmail(email);
      setMsg('リセットメールを送信しました。');
    } catch (e) {
      console.error(e);
      setMsg(e?.message || '送信に失敗しました。', true);
    }
  }

  // パスワード表示トグル（ダブルクリックで切替）
  function setupToggle(){
    const pwd = document.getElementById('loginPassword');
    if (pwd) {
      pwd.addEventListener('dblclick', () => {
        pwd.type = pwd.type === 'password' ? 'text' : 'password';
      });
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    // フォームSubmitでも、ボタンクリックでも login() が走る
    document.querySelector('.auth-form')?.addEventListener('submit', login);
    $("loginBtn")?.addEventListener('click', login);
    $("resetBtn")?.addEventListener('click', sendReset);
    setupToggle();
  });

  // 必要なら公開
  window.login = login;
})();
