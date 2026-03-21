// ===== Firebase制限モード（開発用コスト削減） =====
(function(){
  'use strict';
  
  // 🔥 制限モードの設定
  const LIMITER_CONFIG = {
    enabled: true, // true: 制限モード有効, false: 制限なし
    maxQueriesPerMinute: 50, // 1分間の最大クエリ数
    warnThreshold: 0.8, // 警告を出す閾値（80%で警告）
    maxDocumentsPerQuery: 100, // 1クエリあたりの最大ドキュメント数
    cacheEnabled: true, // キャッシュ有効化
    cacheDuration: 5 * 60 * 1000, // キャッシュ保持時間（5分）
  };
  
  // 統計データ
  const stats = {
    queries: [],
    totalQueries: 0,
    cachedQueries: 0,
    limitedQueries: 0,
    startTime: Date.now()
  };
  
  // キャッシュストア
  const cache = new Map();
  
  // クエリ実行時刻を記録
  function recordQuery(type = 'read') {
    const now = Date.now();
    stats.queries.push({ type, timestamp: now });
    stats.totalQueries++;
    
    // 1分以上前のクエリを削除
    stats.queries = stats.queries.filter(q => now - q.timestamp < 60000);
    
    // 警告チェック
    checkLimits();
  }
  
  // 制限チェック
  function checkLimits() {
    const queriesPerMinute = stats.queries.length;
    const threshold = LIMITER_CONFIG.maxQueriesPerMinute * LIMITER_CONFIG.warnThreshold;
    
    if (queriesPerMinute > threshold) {
      console.warn(`⚠️ Firebaseクエリ数が多い: ${queriesPerMinute}/${LIMITER_CONFIG.maxQueriesPerMinute} (1分間)`);
      
      if (queriesPerMinute >= LIMITER_CONFIG.maxQueriesPerMinute) {
        console.error(`❌ Firebaseクエリ制限に達しました！処理を一時停止します`);
        showLimitWarning();
      }
    }
  }
  
  // 警告表示
  function showLimitWarning() {
    const warning = document.createElement('div');
    warning.id = 'firebase-limit-warning';
    warning.style.cssText = `
      position: fixed;
      top: 20px;
      right: 20px;
      background: linear-gradient(135deg, #ff6b6b, #ee5a6f);
      color: white;
      padding: 16px 20px;
      border-radius: 12px;
      box-shadow: 0 8px 24px rgba(255, 107, 107, 0.4);
      z-index: 9999;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto;
      max-width: 350px;
      animation: slideIn 0.3s ease-out;
    `;
    warning.innerHTML = `
      <div style="display: flex; align-items: center; gap: 12px;">
        <span style="font-size: 24px;">⚠️</span>
        <div>
          <strong style="display: block; margin-bottom: 4px;">Firebase制限モード</strong>
          <span style="font-size: 14px; opacity: 0.9;">クエリ数が上限に達しました</span>
        </div>
      </div>
      <button onclick="this.parentElement.remove()" style="
        position: absolute;
        top: 8px;
        right: 8px;
        background: none;
        border: none;
        color: white;
        font-size: 20px;
        cursor: pointer;
        opacity: 0.8;
        transition: opacity 0.2s;
      " onmouseover="this.style.opacity='1'" onmouseout="this.style.opacity='0.8'">×</button>
    `;
    
    // 既存の警告を削除
    const existing = document.getElementById('firebase-limit-warning');
    if (existing) existing.remove();
    
    document.body.appendChild(warning);
    
    // 5秒後に自動削除
    setTimeout(() => warning.remove(), 5000);
  }
  
  // キャッシュキー生成
  function generateCacheKey(collection, queryParams) {
    return JSON.stringify({ collection, ...queryParams });
  }
  
  // キャッシュから取得
  function getFromCache(key) {
    const cached = cache.get(key);
    if (!cached) return null;
    
    const now = Date.now();
    if (now - cached.timestamp > LIMITER_CONFIG.cacheDuration) {
      cache.delete(key);
      return null;
    }
    
    stats.cachedQueries++;
    console.log(`📦 キャッシュヒット: ${key.substring(0, 50)}...`);
    return cached.data;
  }
  
  // キャッシュに保存
  function saveToCache(key, data) {
    cache.set(key, {
      data,
      timestamp: Date.now()
    });
  }
  
  // Firestore クエリをラップ
  window.limitedQuery = async function(db, collection, options = {}) {
    if (!LIMITER_CONFIG.enabled) {
      // 制限モード無効時は通常のクエリ
      let query = db.collection(collection);
      if (options.where) {
        options.where.forEach(([field, op, value]) => {
          query = query.where(field, op, value);
        });
      }
      if (options.orderBy) {
        query = query.orderBy(options.orderBy.field, options.orderBy.direction || 'asc');
      }
      if (options.limit) {
        query = query.limit(options.limit);
      }
      return await query.get();
    }
    
    // キャッシュチェック
    const cacheKey = generateCacheKey(collection, options);
    if (LIMITER_CONFIG.cacheEnabled) {
      const cached = getFromCache(cacheKey);
      if (cached) return cached;
    }
    
    // クエリ制限チェック
    const queriesPerMinute = stats.queries.length;
    if (queriesPerMinute >= LIMITER_CONFIG.maxQueriesPerMinute) {
      console.warn('⚠️ Firebase制限により処理を遅延します（1秒待機）');
      await new Promise(r => setTimeout(r, 1000));
    }
    
    // limit制限を適用
    if (!options.limit || options.limit > LIMITER_CONFIG.maxDocumentsPerQuery) {
      options.limit = LIMITER_CONFIG.maxDocumentsPerQuery;
      stats.limitedQueries++;
      console.log(`📊 クエリlimitを制限: ${LIMITER_CONFIG.maxDocumentsPerQuery}件`);
    }
    
    // クエリ実行
    recordQuery('read');
    let query = db.collection(collection);
    
    if (options.where) {
      options.where.forEach(([field, op, value]) => {
        query = query.where(field, op, value);
      });
    }
    if (options.orderBy) {
      query = query.orderBy(options.orderBy.field, options.orderBy.direction || 'asc');
    }
    if (options.limit) {
      query = query.limit(options.limit);
    }
    
    const result = await query.get();
    
    // キャッシュに保存
    if (LIMITER_CONFIG.cacheEnabled) {
      saveToCache(cacheKey, result);
    }
    
    return result;
  };
  
  // 統計情報を表示
  window.showFirebaseStats = function() {
    const elapsed = (Date.now() - stats.startTime) / 1000 / 60;
    const queriesPerMin = (stats.totalQueries / elapsed).toFixed(1);
    const cacheHitRate = stats.totalQueries > 0 
      ? ((stats.cachedQueries / stats.totalQueries) * 100).toFixed(1)
      : 0;
    
    console.log(`
📊 Firebase使用統計
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
⏱️  稼働時間: ${elapsed.toFixed(1)}分
📈 総クエリ数: ${stats.totalQueries}
⚡ クエリ/分: ${queriesPerMin}
📦 キャッシュヒット: ${stats.cachedQueries}回 (${cacheHitRate}%)
🔒 制限適用: ${stats.limitedQueries}回
🎯 制限モード: ${LIMITER_CONFIG.enabled ? '有効' : '無効'}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    `);
  };
  
  // 制限モードのON/OFF切り替え
  window.toggleFirebaseLimiter = function(enabled) {
    LIMITER_CONFIG.enabled = enabled;
    console.log(`🔥 Firebase制限モード: ${enabled ? '有効' : '無効'}`);
    if (!enabled) {
      cache.clear();
      console.log('📦 キャッシュをクリアしました');
    }
  };
  
  // キャッシュクリア
  window.clearFirebaseCache = function() {
    cache.clear();
    console.log('📦 Firebaseキャッシュをクリアしました');
  };
  
  // 統計リセット
  window.resetFirebaseStats = function() {
    stats.queries = [];
    stats.totalQueries = 0;
    stats.cachedQueries = 0;
    stats.limitedQueries = 0;
    stats.startTime = Date.now();
    console.log('📊 Firebase統計をリセットしました');
  };
  
  // 定期的に統計を表示（開発中のみ）
  if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') {
    setInterval(() => {
      const queriesPerMinute = stats.queries.length;
      if (queriesPerMinute > 10) {
        console.log(`📊 Firebase: ${queriesPerMinute}クエリ/分 | キャッシュ: ${stats.cachedQueries}/${stats.totalQueries}`);
      }
    }, 30000); // 30秒ごと
  }
  
  console.log('🔥 Firebase制限モード初期化完了');
  console.log('💡 コマンド:');
  console.log('  showFirebaseStats() - 統計表示');
  console.log('  toggleFirebaseLimiter(true/false) - ON/OFF切り替え');
  console.log('  clearFirebaseCache() - キャッシュクリア');
  console.log('  resetFirebaseStats() - 統計リセット');
})();
