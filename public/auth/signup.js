(function(){
  'use strict';
  const auth = () => firebase.auth();
  const db = () => firebase.firestore();

  const ALLOWED_EMAIL_REGEX = /@(?:it-mirai-h\.ibk\.ed\.jp|ibk\.ed\.jp)$/i;

  function $(id){ return document.getElementById(id); }
  function setMsg(msg, isError=false){
    const el = $("signupMsg");
    if (!el) return;
    el.textContent = msg;
    el.style.color = isError ? '#c62828' : '#2e7d32';
  }

  function getForm(){
    return {
      lastName: ($("lastName")?.value || '').trim(),
      firstName: ($("firstName")?.value || '').trim(),
      email: ($("email")?.value || '').trim(),
      password: ($("password")?.value || '').trim(),
      passwordConfirm: ($("passwordConfirm")?.value || '').trim(),
    };
  }

  function validate(f){
    if (!f.lastName || !f.firstName) return '姓と名を入力してください。';
    if (!f.email) return 'メールアドレスを入力してください。';
    if (!ALLOWED_EMAIL_REGEX.test(f.email)) return '学校ドメインのメールのみ登録できます（@it-mirai-h.ibk.ed.jp または @ibk.ed.jp）。';
    if (!f.password || f.password.length < 6) return 'パスワードは6文字以上で入力してください。';
    if (f.password !== f.passwordConfirm) return 'パスワードが一致しません。';
    return '';
  }

  async function signup(){
    const f = getForm();
    const err = validate(f);
    if (err){ setMsg(err, true); return; }
    setMsg('作成中...');

    try {
      await auth().setPersistence(firebase.auth.Auth.Persistence.LOCAL);

      // アカウント作成
      const cred = await auth().createUserWithEmailAndPassword(f.email, f.password);
      const uid = cred.user.uid;
      const displayName = `${f.lastName} ${f.firstName}`.trim();
      await cred.user.updateProfile({ displayName });

      // プロフィール作成（role=student）
      await db().collection('users').doc(uid).set({
        uid,
        email: f.email,
        name: displayName,
        first_name: f.firstName,
        last_name: f.lastName,
        name_lc: displayName.toLowerCase(),
        role: 'student',
        created_at: firebase.firestore.FieldValue.serverTimestamp(),
        is_admin: false,
      }, { merge: true });

      setMsg('アカウントを作成しました。リダイレクトします...');
      setTimeout(()=> location.href = '/', 600);
    } catch (e) {
      console.error(e);
      // エラーコードに応じて日本語メッセージに変換
      let errorMsg = 'アカウント作成に失敗しました。';
      if (e.code === 'auth/invalid-email') {
        errorMsg = 'メールアドレスの形式が正しくありません。正しいメールアドレスを入力してください。';
      } else if (e.code === 'auth/email-already-in-use') {
        errorMsg = 'このメールアドレスは既に登録されています。ログインページからログインしてください。';
      } else if (e.code === 'auth/weak-password') {
        errorMsg = 'パスワードが弱すぎます。6文字以上の強力なパスワードを設定してください。';
      } else if (e.code === 'auth/operation-not-allowed') {
        errorMsg = 'メール/パスワード認証が有効化されていません。管理者にお問い合わせください。';
      } else if (e.code === 'auth/network-request-failed') {
        errorMsg = 'ネットワークエラーが発生しました。インターネット接続を確認してください。';
      } else if (e.message) {
        errorMsg = e.message;
      }
      setMsg(errorMsg, true);
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    const btn = $("signupBtn");
    if (btn) btn.addEventListener('click', signup);
    document.addEventListener('keydown', (e)=>{ if (e.key === 'Enter') signup(); });
  });
})();
