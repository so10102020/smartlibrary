(function(){
  'use strict';

  function loadScript(src){
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src; s.defer = true; s.onload = resolve; s.onerror = reject;
      document.head.appendChild(s);
    });
  }

  async function ensureFirebaseSdk(){
    if (typeof window.firebase !== 'undefined') return;
    
    try {
      // Hosting外でのフォールバック（gstatic CDN・compat版）
      const base = 'https://www.gstatic.com/firebasejs/9.23.0';
      await loadScript(base + '/firebase-app-compat.js');
      await loadScript(base + '/firebase-auth-compat.js');
      await loadScript(base + '/firebase-firestore-compat.js');
      console.log('Firebase SDK loaded successfully');
    } catch (error) {
      console.error('Failed to load Firebase SDK:', error);
      throw error;
    }
  }

  function connectEmulatorsIfLocal(){
    try {
      if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') {
        if (!window.__EMULATORS_BOUND__) {
          if (firebase.firestore) {
            try { firebase.firestore().useEmulator('localhost', 8080); } catch(_) {}
          }
          if (firebase.auth) {
            try { firebase.auth().useEmulator('http://localhost:9099'); } catch(_) {}
          }
          window.__EMULATORS_BOUND__ = true;
          console.log('Firebase emulators connected');
        }
      }
    } catch(e) { console.warn('Emulator binding skipped:', e); }
  }

  async function initializeFirebase(){
    await ensureFirebaseSdk();
    
    const config = window.FIREBASE_WEB_CONFIG;
    if (!config) {
      console.error('Firebase config not found');
      return null;
    }

    // Firebase アプリが既に存在するかチェック
    let app;
    try {
      app = firebase.app(); // 既存のアプリを取得
      console.log('Using existing Firebase app');
    } catch (error) {
      // アプリが存在しない場合は新しく初期化
      try {
        app = firebase.initializeApp(config);
        console.log('Firebase app initialized successfully');
      } catch (initError) {
        console.error('Firebase initialization failed:', initError);
        return null;
      }
    }

    // Firebase サービスをグローバル変数として初期化
    window.auth = firebase.auth();
    window.db = firebase.firestore();

    console.log('Firebase初期化完了');

    // 認証状態の監視
    auth.onAuthStateChanged((user) => {
      if (user) {
        console.log('ユーザーログイン:', user.email);
      } else {
        console.log('ユーザーログアウト');
      }
    });

    connectEmulatorsIfLocal();
  }

  async function initIfNeeded(){
    try {
      // Firebase SDKがロードされるまで待つ
      let attempts = 0;
      while (!window.firebase && attempts < 50) {
        await new Promise(r => setTimeout(r, 100));
        attempts++;
      }
      
      if (!window.firebase) {
        throw new Error('Firebase SDK not loaded');
      }
      
      // Firebase設定（firebase-config.jsから読み込み済み）
      const firebaseConfig = window.FIREBASE_WEB_CONFIG;
      
      if (!firebaseConfig || !firebaseConfig.apiKey) {
        throw new Error('Firebase config not found. Please check firebase-config.js');
      }

      // Firebase初期化（重複チェック付き）
      await initializeFirebase();
    } catch(e) {
      console.error('Firebase init failed:', e);
      // UIにエラーを表示
      const errorDiv = document.createElement('div');
      errorDiv.style.cssText = 'position:fixed;top:10px;right:10px;background:#f44;color:white;padding:10px;border-radius:5px;z-index:9999;';
      errorDiv.textContent = 'Firebase接続エラー: ' + e.message;
      document.body.appendChild(errorDiv);
      setTimeout(() => errorDiv.remove(), 10000);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initIfNeeded);
  } else {
    initIfNeeded();
  }
})();
