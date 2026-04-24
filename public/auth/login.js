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
    const rememberMeEl = $("rememberMe");
    const btn     = $("loginBtn");

    const email = (emailEl?.value || '').trim();
    const password = passEl?.value || '';
    const rememberMe = rememberMeEl?.checked ?? true;
    
    if (!email || !password){ setMsg('メールアドレスとパスワードを入力してください。', true); return; }

    btn?.setAttribute('disabled','disabled');
    setMsg('ログイン中...');

    try {
      // チェックボックスの状態に応じて永続化設定を変更
      const persistence = rememberMe 
        ? firebase.auth.Auth.Persistence.LOCAL    // ブラウザを閉じても保持
        : firebase.auth.Auth.Persistence.SESSION; // タブを閉じると削除
      
      try { 
        await auth().setPersistence(persistence);
        console.log(`永続化モード: ${rememberMe ? 'LOCAL (保持する)' : 'SESSION (保持しない)'}`);
      } catch(err) {
        console.warn('永続化設定に失敗:', err);
      }
      
      await auth().signInWithEmailAndPassword(email, password);
      setMsg('ログインしました。移動します...');
      // ホームページへリダイレクト
      setTimeout(()=> location.href = '/', 200);
    } catch (e) {
      console.error(e);
      // エラーコードに応じて日本語メッセージに変換
      let errorMsg = 'ログインに失敗しました。';
      if (e.code === 'auth/invalid-email') {
        errorMsg = 'メールアドレスの形式が正しくありません。正しいメールアドレスを入力してください。';
      } else if (e.code === 'auth/invalid-credential' || e.code === 'auth/invalid-login-credentials') {
        errorMsg = '❌ メールアドレスまたはパスワードが正しくありません。\n\n以下をご確認ください：\n• メールアドレスとパスワードのスペルミスがないか\n• 大文字・小文字が正しいか\n• まだアカウントを作成していない場合は「新規登録」から登録してください';
      } else if (e.code === 'auth/user-not-found') {
        errorMsg = 'このメールアドレスは登録されていません。新規登録ページからアカウントを作成してください。';
      } else if (e.code === 'auth/wrong-password') {
        errorMsg = 'パスワードが正しくありません。パスワードを確認してください。';
      } else if (e.code === 'auth/too-many-requests') {
        errorMsg = 'ログイン試行回数が多すぎます。しばらく待ってから再度お試しください。';
      } else if (e.code === 'auth/user-disabled') {
        errorMsg = 'このアカウントは無効化されています。管理者にお問い合わせください。';
      } else if (e.code === 'auth/network-request-failed') {
        errorMsg = 'ネットワークエラーが発生しました。インターネット接続を確認してください。';
      } else if (e.message) {
        errorMsg = e.message;
      }
      setMsg(errorMsg, true);
    } finally {
      btn?.removeAttribute('disabled');
    }
  }

  // パスワードリセット（メール宛）
  async function sendReset(evt){
    if (evt) evt.preventDefault();
    const emailEl = $("loginEmail");
    const email = (emailEl?.value || '').trim();
    
    if (!email){ 
      setMsg('パスワードリセットには、上のメールアドレス欄にメールアドレスを入力してください。', true); 
      emailEl?.focus();
      return; 
    }
    
    // メールアドレスの基本的な形式チェック
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      setMsg('メールアドレスの形式が正しくありません。正しいメールアドレスを入力してください。', true);
      emailEl?.focus();
      return;
    }
    
    setMsg('パスワードリセットメールを送信中...');
    
    try {
      // actionCodeSettings で日本語のメール設定
      const actionCodeSettings = {
        url: window.location.origin + '/login.html',
        handleCodeInApp: false
      };
      
      await auth().sendPasswordResetEmail(email, actionCodeSettings);
      
      setMsg(`✅ パスワードリセットメールを ${email} に送信しました。\n\n受信トレイ（または迷惑メールフォルダ）を確認してください。\nメールに記載されたリンクをクリックして、新しいパスワードを設定してください。`);
      
      // 5秒後にメッセージをクリア
      setTimeout(() => {
        setMsg('');
      }, 10000);
      
    } catch (e) {
      console.error('Password reset error:', e);
      // エラーコードに応じて日本語メッセージに変換
      let errorMsg = 'パスワードリセットメールの送信に失敗しました。';
      if (e.code === 'auth/invalid-email') {
        errorMsg = 'メールアドレスの形式が正しくありません。正しいメールアドレスを入力してください。';
      } else if (e.code === 'auth/user-not-found') {
        errorMsg = 'このメールアドレスは登録されていません。入力内容を確認するか、新規登録してください。';
      } else if (e.code === 'auth/too-many-requests') {
        errorMsg = 'リセットメールの送信回数が多すぎます。しばらく待ってから再度お試しください。';
      } else if (e.code === 'auth/network-request-failed') {
        errorMsg = 'ネットワークエラーが発生しました。インターネット接続を確認してください。';
      } else if (e.code === 'auth/missing-continue-uri' || e.code === 'auth/invalid-continue-uri') {
        errorMsg = 'システム設定エラーです。管理者にお問い合わせください。';
      } else if (e.message) {
        errorMsg = e.message;
      }
      setMsg(errorMsg, true);
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
