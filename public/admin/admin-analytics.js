// ===== データ分析機能（読書率、統計、ランキング） =====
(function(){
  'use strict';
  
  // ダッシュボードを初期化
  window.initDashboard = async function() {
    try {
      window.showActionResult('処理中', 'データ分析中...', 'processing');
      
      const db = window.adminState.db;
      
      // 各種統計データを取得
      const [booksSnap, loansSnap, usersSnap] = await Promise.all([
        db.collection('books').get(),
        db.collection('loans').get(),
        db.collection('users').get()
      ]);
      
      // 基本統計
      const totalBooks = booksSnap.size;
      const totalUsers = usersSnap.size;
      
      // 貸出統計
      const allLoans = loansSnap.docs.map(d => ({ id: d.id, ...d.data() }));
      const activeLoans = allLoans.filter(l => l.status === 'active');
      const now = new Date();
      const overdueLoans = activeLoans.filter(l => {
        const dueDate = l.due_at?.toDate ? l.due_at.toDate() : new Date(l.due_at);
        return dueDate < now;
      });
      
      // 表示
      window.setText('dashTotalBooks', totalBooks);
      window.setText('dashActiveLoans', activeLoans.length);
      window.setText('dashOverdue', overdueLoans.length);
      window.setText('dashTotalUsers', totalUsers);
      
      // 最近の貸出（直近10件）
      const recentLoans = allLoans
        .sort((a, b) => {
          const dateA = a.checked_out_at?.toDate ? a.checked_out_at.toDate() : new Date(a.checked_out_at);
          const dateB = b.checked_out_at?.toDate ? b.checked_out_at.toDate() : new Date(b.checked_out_at);
          return dateB - dateA;
        })
        .slice(0, 10);
      
      renderRecentLoans(recentLoans);
      renderOverdueList(overdueLoans);
      
      const resultSection = window.$('actionResultSection');
      if (resultSection) resultSection.style.display = 'none';
    } catch (e) {
      console.error(e);
      window.showActionResult('エラー', 'ダッシュボードの読み込み失敗', 'error');
    }
  };
  
  // 最近の貸出を表示
  function renderRecentLoans(loans) {
    const container = window.$('dashRecentLoans');
    if (!container) return;
    
    if (!loans.length) {
      container.innerHTML = '<p>貸出記録がありません</p>';
      return;
    }
    
    const html = loans.map(loan => {
      const date = loan.checked_out_at?.toDate ? loan.checked_out_at.toDate() : new Date(loan.checked_out_at);
      const dateStr = date.toLocaleString('ja-JP', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      const status = loan.status === 'active' ? '📖 貸出中' : '✅ 返却済';
      
      return `
        <div class="recent-item">
          <div class="recent-info">
            <strong>${window.escapeHtml(loan.book_title || '不明')}</strong>
            <span class="recent-meta">${dateStr} - ${status}</span>
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
    
    if (!loans.length) {
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
  
  // 🔥 遅延読み込み用の関数として export
  window.showReadingAnalytics = async function() {
    const container = window.$('dashboardTab');
    if (!container) return;
    
    // 既に分析結果がある場合はスキップ
    if (container.querySelector('.analytics-grid')) {
      console.log('📊 分析結果は既に表示されています');
      return;
    }
    
    try {
      const db = window.adminState.db;
      
      window.showActionResult('処理中', 'データ分析中...（時間がかかる場合があります）', 'processing');
      
      // データ取得
      const [loansSnap, usersSnap, booksSnap] = await Promise.all([
        db.collection('loans').get(),
        db.collection('users').get(),
        db.collection('books').limit(500).get() // 書籍は500件まで
      ]);
      
      const loans = loansSnap.docs.map(d => d.data());
      const users = usersSnap.docs.map(d => ({ uid: d.id, ...d.data() }));
      const books = booksSnap.docs.map(d => ({ id: d.id, ...d.data() }));
      
      // ユーザーごとの貸出数
      const userLoanCounts = {};
      loans.forEach(loan => {
        const uid = loan.uid;
        if (!userLoanCounts[uid]) {
          userLoanCounts[uid] = { total: 0, active: 0 };
        }
        userLoanCounts[uid].total++;
        if (loan.status === 'active') {
          userLoanCounts[uid].active++;
        }
      });
      
      // 読書率カテゴリー分類
      const categories = {
        none: 0,      // 0冊
        low: 0,       // 1-3冊
        medium: 0,    // 4-9冊
        high: 0,      // 10-19冊
        veryHigh: 0   // 20冊以上
      };
      
      users.forEach(user => {
        const count = userLoanCounts[user.uid]?.total || 0;
        if (count === 0) categories.none++;
        else if (count <= 3) categories.low++;
        else if (count <= 9) categories.medium++;
        else if (count <= 19) categories.high++;
        else categories.veryHigh++;
      });
      
      // 人気書籍TOP10
      const bookLoanCounts = {};
      loans.forEach(loan => {
        const bookId = loan.book_id;
        bookLoanCounts[bookId] = (bookLoanCounts[bookId] || 0) + 1;
      });
      
      const popularBooks = Object.entries(bookLoanCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([bookId, count]) => {
          const book = books.find(b => b.id === bookId || b.book_id === bookId);
          return { bookId, title: book?.title || '不明', count };
        });
      
      // アクティブ読者TOP10
      const topReaders = Object.entries(userLoanCounts)
        .sort((a, b) => b[1].total - a[1].total)
        .slice(0, 10)
        .map(([uid, counts]) => {
          const user = users.find(u => u.uid === uid);
          return { uid, name: user?.name || '不明', total: counts.total, active: counts.active };
        });
      
      // 月別貸出推移（直近6ヶ月）
      const monthlyStats = calculateMonthlyStats(loans);
      
      // 分析結果を表示
      const analyticsHtml = `
        <div class="dashboard-section">
          <h3>📊 読書率分析</h3>
          <div class="analytics-grid">
            <div class="analytics-card">
              <h4>読書カテゴリー分布</h4>
              <div class="category-list">
                <div class="category-item">
                  <span class="category-label">📚 20冊以上</span>
                  <span class="category-value">${categories.veryHigh}人 (${((categories.veryHigh/users.length)*100).toFixed(1)}%)</span>
                </div>
                <div class="category-item">
                  <span class="category-label">📖 10-19冊</span>
                  <span class="category-value">${categories.high}人 (${((categories.high/users.length)*100).toFixed(1)}%)</span>
                </div>
                <div class="category-item">
                  <span class="category-label">📗 4-9冊</span>
                  <span class="category-value">${categories.medium}人 (${((categories.medium/users.length)*100).toFixed(1)}%)</span>
                </div>
                <div class="category-item">
                  <span class="category-label">📘 1-3冊</span>
                  <span class="category-value">${categories.low}人 (${((categories.low/users.length)*100).toFixed(1)}%)</span>
                </div>
                <div class="category-item">
                  <span class="category-label">❌ 未利用</span>
                  <span class="category-value">${categories.none}人 (${((categories.none/users.length)*100).toFixed(1)}%)</span>
                </div>
              </div>
            </div>
            
            <div class="analytics-card">
              <h4>🏆 人気書籍 TOP10</h4>
              <div class="ranking-list">
                ${popularBooks.map((book, i) => `
                  <div class="ranking-item">
                    <span class="rank">${i + 1}</span>
                    <span class="ranking-title">${window.escapeHtml(book.title)}</span>
                    <span class="ranking-count">${book.count}回</span>
                  </div>
                `).join('')}
              </div>
            </div>
            
            <div class="analytics-card">
              <h4>👑 アクティブ読者 TOP10</h4>
              <div class="ranking-list">
                ${topReaders.map((reader, i) => `
                  <div class="ranking-item">
                    <span class="rank">${i + 1}</span>
                    <span class="ranking-title">${window.escapeHtml(reader.name)}</span>
                    <span class="ranking-count">${reader.total}冊（貸出中${reader.active}）</span>
                  </div>
                `).join('')}
              </div>
            </div>
            
            <div class="analytics-card">
              <h4>📈 月別貸出推移（直近6ヶ月）</h4>
              <div class="monthly-chart">
                ${monthlyStats.map(stat => `
                  <div class="month-bar">
                    <div class="month-label">${stat.month}</div>
                    <div class="bar-container">
                      <div class="bar-fill" style="width: ${(stat.count / Math.max(...monthlyStats.map(s => s.count))) * 100}%">
                        ${stat.count}
                      </div>
                    </div>
                  </div>
                `).join('')}
              </div>
            </div>
          </div>
        </div>
      `;
      
      // ダッシュボードに追加
      const existingAnalytics = container.querySelector('.dashboard-section:last-child');
      if (existingAnalytics) {
        existingAnalytics.insertAdjacentHTML('afterend', analyticsHtml);
      }
      
      const resultSection = window.$('actionResultSection');
      if (resultSection) resultSection.style.display = 'none';
      
      window.showActionResult('成功', '詳細分析を読み込みました', 'success');
      setTimeout(() => {
        const rs = window.$('actionResultSection');
        if (rs) rs.style.display = 'none';
      }, 2000);
    } catch (e) {
      console.error('分析エラー:', e);
      window.showActionResult('エラー', '詳細分析の読み込みに失敗しました', 'error');
    }
  };
  
  // 月別統計を計算
  function calculateMonthlyStats(loans) {
    const stats = {};
    const now = new Date();
    
    // 直近6ヶ月を初期化
    for (let i = 5; i >= 0; i--) {
      const date = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
      const label = `${date.getMonth() + 1}月`;
      stats[key] = { month: label, count: 0 };
    }
    
    // 貸出を集計
    loans.forEach(loan => {
      const date = loan.checked_out_at?.toDate ? loan.checked_out_at.toDate() : new Date(loan.checked_out_at);
      const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
      if (stats[key]) {
        stats[key].count++;
      }
    });
    
    return Object.values(stats);
  }
  
  console.log('✅ admin-analytics.js loaded');
})();
