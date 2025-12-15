// Firebase Web App Config
// 必ず自分のプロジェクトの値に置き換えてください。
// Firebase Console > プロジェクト設定 > マイアプリ（Web）
// ここで取得できる config オブジェクトを貼り付けます。

window.FIREBASE_WEB_CONFIG = window.FIREBASE_WEB_CONFIG || {
  apiKey: "AIzaSyCpZcNXJMyXU5kfZhhTJnc7iaOsrWI9lO8",
  authDomain: "librarycirculationsystem.firebaseapp.com",
  projectId: "librarycirculationsystem",
  appId: "1:120373031563:web:6b00a20a46f612ebf0da8e"
  // measurementId, storageBucket など任意の追加も可
};

(function(){
  const c = window.FIREBASE_WEB_CONFIG || {};
  if (!c.apiKey || String(c.apiKey).includes('YOUR_')) {
    console.warn('[firebase-config] ダミー設定のままです。Firebase Hosting 以外で動かす場合は、firebase-config.js を正しい値に更新してください。');
  }
})();
