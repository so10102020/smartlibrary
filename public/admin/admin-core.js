// ===== 共通ユーティリティ =====
(function(){
  'use strict';
  
  // グローバル変数
  window.adminState = {
    isAuthenticated: false,
    auth: null,
    db: null
  };
  
  // Firebase初期化を待つ
  window.waitForFirebase = function() {
    return new Promise((resolve, reject) => {
      let attempts = 0;
      const maxAttempts = 50;
      
      const checkFirebase = () => {
        attempts++;
        if (window.firebase?.auth && window.firebase?.firestore) {
          window.adminState.auth = window.firebase.auth();
          window.adminState.db = window.firebase.firestore();
          resolve();
        } else if (attempts >= maxAttempts) {
          reject(new Error('Firebaseの初期化がタイムアウトしました'));
        } else {
          setTimeout(checkFirebase, 100);
        }
      };
      
      checkFirebase();
    });
  };
  
  // DOM utilities
  window.$ = (id) => document.getElementById(id);
  window.setText = (id, txt) => { const el = window.$(id); if (el) el.textContent = txt; };
  window.setHtml = (id, html) => { const el = window.$(id); if (el) el.innerHTML = html; };
  window.showElement = (id, show = true) => { 
    const el = window.$(id); 
    if (el) el.style.display = show ? 'block' : 'none'; 
  };
  
  // メッセージ表示
  window.showMessage = function(elementId, message, type = 'info') {
    const el = window.$(elementId);
    if (!el) return;
    el.textContent = message;
    el.className = `message ${type}`;
  };
  
  window.showActionResult = function(title, html, type = 'info') {
    const resultEl = window.$('actionResult');
    if (!resultEl) return;
    let className = 'result-card';
    let icon = '��';
    switch(type) {
      case 'success': className += ' success'; icon = '✅'; break;
      case 'error': className += ' error'; icon = '❌'; break;
      case 'warning': className += ' warning'; icon = '⚠️'; break;
      case 'processing': className += ' processing'; icon = '⏳'; break;
    }
    resultEl.className = className;
    resultEl.innerHTML = `<h3>${icon} ${title}</h3><div>${html}</div>`;
    window.showElement('actionResultSection', true);
    resultEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };
  
  // XSS対策
  window.escapeHtml = function(text) {
    if (!text) return '';
    const map = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#039;'
    };
    return text.toString().replace(/[&<>"']/g, m => map[m]);
  };
  
  // ISBN utilities
  window.toIsbn13 = function(code) {
    const digits = (code || '').replace(/[^0-9Xx]/g, '');
    if (digits.length === 13) return digits;
    if (digits.length !== 10) return '';
    const core = '978' + digits.substring(0, 9);
    let sum = 0;
    for (let i = 0; i < core.length; i++) {
      const n = parseInt(core[i], 10);
      sum += (i % 2 === 0) ? n : n * 3;
    }
    const cd = (10 - (sum % 10)) % 10;
    return core + String(cd);
  };
  
  window.extractIsbn13 = function(raw) {
    if (!raw) return '';
    let text = String(raw).replace(/^\s*ISBN(?:-1[03])?:?\s*/i, '').replace(/[-\s]/g, '');
    let m13 = text.match(/\b(97[89]\d{10})\b/) || String(raw).match(/\b(97[89]\d{10})\b/);
    if (m13) return m13[1];
    let m10 = text.match(/\b(\d{9}[\dXx])\b/) || String(raw).match(/\b(\d{9}[\dXx])\b/);
    if (m10) return window.toIsbn13(m10[1]);
    const digits = String(raw).replace(/[^0-9Xx]/g, '');
    if (digits.length === 13 && /^97[89]/.test(digits)) return digits;
    if (digits.length === 10) return window.toIsbn13(digits);
    return '';
  };
  
  // 検索用正規化
  window.normalizeForSearch = function(str) {
    return String(str || '')
      .replace(/[！-～]/g, s => String.fromCharCode(s.charCodeAt(0) - 0xFEE0))
      .replace(/　/g, ' ')
      .replace(/[‐‑‒–—―ー−]/g, '-')
      .replace(/[ァ-ン]/g, s => String.fromCharCode(s.charCodeAt(0) - 0x60))
      .toLowerCase();
  };
  
  window.onlyDigits = function(str) {
    return String(str || '').replace(/[^0-9xX]/g, '');
  };
  
  // 日付フォーマット
  window.fmtDate = function(val) {
    if (!val) return '-';
    const d = val?.toDate ? val.toDate() : (val instanceof Date ? val : new Date(val));
    if (!d || isNaN(d.getTime())) return '-';
    const y = d.getFullYear();
    const m = String(d.getMonth()+1).padStart(2,'0');
    const da = String(d.getDate()).padStart(2,'0');
    return `${y}/${m}/${da}`;
  };
  
  // タブ表示
  window.showTab = function(tabKey) {
    document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
    document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
    
    const tabEl = document.getElementById(`${tabKey}Tab`);
    if (tabEl) tabEl.classList.add('active');
    
    const btn = document.querySelector(`.tab-btn[onclick="showTab('${tabKey}')"]`);
    if (btn) btn.classList.add('active');
  };
  
  // ログアウト
  window.logout = function() {
    window.adminState.auth.signOut().then(() => {
      window.location.href = 'index.html';
    });
  };
  
  console.log('✅ admin-core.js loaded');
})();
