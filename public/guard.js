(function(){
  'use strict';

  // Firebaseが利用可能になるまで待機
  async function waitForFirebase() {
    let attempts = 0;
    while (attempts < 100) { // 最大5秒待機
      if (typeof firebase !== 'undefined' && firebase.auth) {
        return firebase.auth();
      }
      await new Promise(resolve => setTimeout(resolve, 50));
      attempts++;
    }
    throw new Error('Firebase is not available');
  }

  function isAuthPage(){
    const p = location.pathname;
    return p.endsWith('/login.html') || p.endsWith('login.html') || p.endsWith('/signup.html') || p.endsWith('signup.html');
  }

  async function signOut(){
    try {
      const auth = await waitForFirebase();
      await auth.signOut();
    } catch (error) {
      console.error('Sign out error:', error);
    } finally {
      location.replace('login.html');
    }
  }

  document.addEventListener('DOMContentLoaded', async () => {
    try {
      const auth = await waitForFirebase();
      auth.onAuthStateChanged((user) => {
        if (!user && !isAuthPage()) {
          location.replace('login.html');
          return;
        }
        if (user && isAuthPage()) {
          // 認証画面にいるがログイン済みの場合はトップへ
          location.replace('index.html');
        }
      });
    } catch (error) {
      console.error('Auth guard initialization failed:', error);
      if (!isAuthPage()) {
        location.replace('login.html');
      }
    }
  });

  window.signOut = signOut;
})();
