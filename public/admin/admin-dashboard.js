// ===== ダッシュボード機能 =====
(function(){
  'use strict';
  
  let dashboardCache = null;
  let cacheTimestamp = null;
  const CACHE_DURATION = 5 * 60 * 1000; // 5分間キャッシュ
  
  // 🔥 軽量版ダッシュボード初期化（集計クエリのみ）
  window.initDashboard = async function() {
    const container = window.$('dashboardTab');
    if (!container || !container.classList.contains('active')) return;
    
    try {
      // キャッシュチェック
      const now = Date.now();
      if (dashboardCache && cacheTimestamp && (now - cacheTimestamp < CACHE_DURATION)) {
        console.log('📦 ダッシュボードキャッシュから表示');
        renderDashboard(dashboardCache);
        return;
      }
      
      // ローディング表示
      showDashboardLoading();
      
      const db = window.adminState.db;
      
      // 🔥 最適化: 軽量クエリのみ（limit付き）
      const [booksSnap, activeLoansSnap, usersSnap] = await Promise.all([
        db.collection('books').limit(1).get(), // カウント用に1件だけ取得
        db.collection('loans').where('status', '==', 'active').limit(100).get(),
        db.collection('users').limit(1).get()
      ]);
      
      // 実際の総数を取得（より正確だが遅い場合は上記limitのみに）
      const [totalBooks, totalUsers] = await Promise.all([
        db.collection('books').get().then(snap => snap.size),
        db.collection('users').get().then(snap => snap.size)
      ]);
      
      const activeLoans = activeLoansSnap.docs.map(d => ({ id: d.id, ...d.data() }));
      const now_date = new Date();
      const overdueLoans = activeLoans.filter(l => {
        const dueDate = l.due_at?.toDate ? l.due_at.toDate() : new Date(l.due_at);
        return dueDate < now_date;
      });
      
      const stats = {
        totalBooks,
        activeLoansCount: activeLoans.length,
        overdueCount: overdueLoans.length,
        totalUsers,
        recentLoans: activeLoans.slice(0, 10), // 最新10件のみ
        overdueLoans: overdueLoans.slice(0, 10)
      };
      
      // キャッシュ保存
      dashboardCache = stats;
      cacheTimestamp = now;
      
      renderDashboard(stats);
      
    } catch (e) {
      console.error('ダッシュボード読み込みエラー:', e);
      window.showActionResult('エラー', 'ダッシュボードの読み込みに失敗しました', 'error');
    }
  };
  
  // ローディング表示
  function showDashboardLoading() {
    window.setText('dashTotalBooks', '...');
    window.setText('dashActiveLoans', '...');
    window.setText('dashOverdue', '...');
    window.setText('dashTotalUsers', '...');
    
    const recentContainer = window.$('dashRecentLoans');
    const overdueContainer = window.$('dashOverdueList');
    if (recentContainer) recentContainer.innerHTML = '<p>読み込み中...</p>';
    if (overdueContainer) overdueContainer.innerHTML = '<p>読み込み中...</p>';
  }
  
  // ダッシュボードをレンダリング
  function renderDashboard(stats) {
    // 統計カード
    window.setText('dashTotalBooks', stats.totalBooks);
    window.setText('dashActiveLoans', stats.activeLoansCount);
    window.setText('dashOverdue', stats.overdueCount);
    window.setText('dashTotalUsers', stats.totalUsers);
    
    // 最近の貸出
    renderRecentLoans(stats.recentLoans);
    
    // 延滞リスト
    renderOverdueList(stats.overdueLoans);
    
    // 結果セクションを非表示
    const resultSection = window.$('actionResultSection');
    if (resultSection) resultSection.style.display = 'none';
  }
  
  // 最近の貸出を表示
  function renderRecentLoans(loans) {
    const container = window.$('dashRecentLoans');
    if (!container) return;
    
    if (!loans || loans.length === 0) {
      container.innerHTML = '<p>貸出記録がありません</p>';
      return;
    }
    
    const html = loans.map(loan => {
      const date = loan.checked_out_at?.toDate ? loan.checked_out_at.toDate() : new Date(loan.checked_out_at);
      const dateStr = date.toLocaleString('ja-JP', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      
      return `
        <div class="recent-item">
          <div class="recent-info">
            <strong>${window.escapeHtml(loan.book_title || '不明')}</strong>
            <span class="recent-meta">${dateStr} - 📖 貸出中</span>
          </div>
        </div>
      `;
    }).join('');
    
    container.innerHTML = html;
  }
  
  // 延滞リストを表示
  function renderOverdueList(loans) {
    const container = window.$('dashOverdueList');
    if (!container) return;
    
    if (!loans || loans.length === 0) {
      container.innerHTML = '<p style="color: #4caf50;">✅ 延滞なし</p>';
      return;
    }
    
    const html = loans.map(loan => {
      const dueDate = loan.due_at?.toDate ? loan.due_at.toDate() : new Date(loan.due_at);
      const overdueDays = Math.floor((new Date() - dueDate) / (1000 * 60 * 60 * 24));
      
      return `
        <div class="recent-item warning">
          <div class="recent-info">
            <strong>${window.escapeHtml(loan.book_title || '不明')}</strong>
            <span class="recent-meta" style="color: #f44336;">⚠️ ${overdueDays}日延滞</span>
          </div>
        </div>
      `;
    }).join('');
    
    container.innerHTML = html;
  }
  
  // 🔥 詳細分析は別ボタンで遅延読み込み
  window.loadDetailedAnalytics = async function() {
    const btn = event.target;
    btn.disabled = true;
    btn.textContent = '読み込み中...';
    
    try {
      // admin-analytics.jsの関数を呼び出し
      if (typeof window.showReadingAnalytics === 'function') {
        await window.showReadingAnalytics();
        btn.textContent = '✅ 読み込み完了';
      } else {
        throw new Error('分析機能が読み込まれていません');
      }
    } catch (e) {
      console.error(e);
      btn.textContent = '❌ エラー';
      window.showActionResult('エラー', '詳細分析の読み込みに失敗しました', 'error');
    } finally {
      setTimeout(() => {
        btn.disabled = false;
        btn.textContent = '📊 詳細分析を読み込む';
      }, 3000);
    }
  };
  
  console.log('✅ admin-dashboard.js loaded');
})();
