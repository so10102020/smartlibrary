(function(){
  'use strict';

  // 🔥 グローバルフラグで初期化済みかチェック
  if (window.__FIREBASE_INITIALIZED__) {
    console.log('⚠️ Firebase already initialized, skipping');
    return;
  }

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
    // 🔥 既に初期化済みならスキップ
    if (window.auth && window.db) {
      console.log('Firebase services already initialized');
      return;
    }

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

    // 🔥 永続化設定（1回のみ）
    if (!window.__PERSISTENCE_ENABLED__) {
      try {
        await window.db.enablePersistence({ synchronizeTabs: true });
        console.log('✅ Firestore persistence enabled');
        window.__PERSISTENCE_ENABLED__ = true;
      } catch (err) {
        if (err.code === 'failed-precondition') {
          console.warn('⚠️ Multiple tabs open, persistence can only be enabled in one tab at a time.');
        } else if (err.code === 'unimplemented') {
          console.warn('⚠️ The current browser does not support persistence.');
        } else {
          console.warn('⚠️ Persistence setup skipped:', err);
        }
      }
    }

    console.log('Firebase初期化完了');

    // 認証状態の監視（1回のみ）
    if (!window.__AUTH_LISTENER_ATTACHED__) {
      auth.onAuthStateChanged((user) => {
        if (user) {
          console.log('ユーザーログイン:', user.email);
        } else {
          console.log('ユーザーログアウト');
        }
      });
      window.__AUTH_LISTENER_ATTACHED__ = true;
    }

    connectEmulatorsIfLocal();
  }

  async function initIfNeeded(){
    // 🔥 初期化フラグをセット
    if (window.__FIREBASE_INITIALIZED__) {
      console.log('Firebase already initialized globally');
      return;
    }
    window.__FIREBASE_INITIALIZED__ = true;

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
      window.__FIREBASE_INITIALIZED__ = false; // エラー時はリセット
      // UIにエラーを表示
      const errorDiv = document.createElement('div');
      errorDiv.style.cssText = 'position:fixed;top:10px;right:10px;background:#f44;color:white;padding:10px;border-radius:5px;z-index:9999;';
      errorDiv.textContent = 'Firebase接続エラー: ' + e.message;
      document.body.appendChild(errorDiv);
      setTimeout(() => errorDiv.remove(), 10000);
    }
  }

  // 🔥 waitForFirebase ヘルパー関数
  window.waitForFirebase = async function() {
    let attempts = 0;
    while ((!window.auth || !window.db) && attempts < 100) {
      await new Promise(r => setTimeout(r, 50));
      attempts++;
    }
    if (!window.auth || !window.db) {
      throw new Error('Firebase initialization timeout');
    }
    return { auth: window.auth, db: window.db };
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initIfNeeded);
  } else {
    initIfNeeded();
  }
})();
