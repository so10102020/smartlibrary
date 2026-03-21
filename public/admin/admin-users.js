// ===== ユーザー管理機能（強化版） =====
(function(){
  'use strict';
  
  let usersCache = [];
  let statsCache = null;
  
  // ユーザー管理画面を表示
  window.showUserManagement = async function() {
    const container = window.$('userManagementContainer');
    if (!container) return;
    
    container.innerHTML = `
      <h2>👥 ユーザー管理</h2>
      
      <!-- 検索とフィルター -->
      <div class="management-toolbar">
        <div class="search-group">
          <input id="userSearchInput" type="text" placeholder="名前、メール、IDで検索..." oninput="searchUsers()">
          <button class="btn btn-primary" onclick="searchUsers()">🔍 検索</button>
        </div>
        <div class="filter-group">
          <select id="userRoleFilter" onchange="searchUsers()">
            <option value="">すべての権限</option>
            <option value="student">学生</option>
            <option value="teacher">教員</option>
            <option value="admin">管理者</option>
          </select>
          <button class="btn btn-secondary" onclick="exportUsersCsv()">📥 CSVエクスポート</button>
          <button class="btn btn-success" onclick="showAddUserModal()">➕ ユーザー追加</button>
        </div>
      </div>
      
      <!-- 統計サマリー -->
      <div class="dashboard-grid" style="margin: 20px 0;">
        <div class="dashboard-card">
          <div class="card-icon">👥</div>
          <div class="card-content">
            <h3>総ユーザー数</h3>
            <div class="card-value" id="userTotalCount">-</div>
          </div>
        </div>
        <div class="dashboard-card">
          <div class="card-icon">📚</div>
          <div class="card-content">
            <h3>アクティブ読者</h3>
            <div class="card-value" id="userActiveReaders">-</div>
          </div>
        </div>
        <div class="dashboard-card">
          <div class="card-icon">📖</div>
          <div class="card-content">
            <h3>現在の貸出数</h3>
            <div class="card-value" id="userCurrentLoans">-</div>
          </div>
        </div>
        <div class="dashboard-card">
          <div class="card-icon">📊</div>
          <div class="card-content">
            <h3>平均貸出冊数</h3>
            <div class="card-value" id="userAvgLoans">-</div>
          </div>
        </div>
      </div>
      
      <!-- ユーザーテーブル -->
      <div id="userTableContainer" class="table-responsive"></div>
      
      <!-- ユーザー追加/編集モーダル -->
      <div id="userModal" class="modal" style="display: none;">
        <div class="modal-content">
          <button class="modal-close" onclick="closeUserModal()">×</button>
          <h3 id="userModalTitle">ユーザー追加</h3>
          <form id="userForm" onsubmit="saveUser(event)">
            <div class="form-grid">
              <div class="form-group">
                <label>名前 *</label>
                <input id="userName" type="text" required>
              </div>
              <div class="form-group">
                <label>メールアドレス *</label>
                <input id="userEmail" type="email" required>
              </div>
              <div class="form-group">
                <label>ユーザーID *</label>
                <input id="userId" type="text" required>
              </div>
              <div class="form-group">
                <label>権限 *</label>
                <select id="userRole" required>
                  <option value="student">学生</option>
                  <option value="teacher">教員</option>
                  <option value="admin">管理者</option>
                </select>
              </div>
              <div class="form-group">
                <label>学年/部署</label>
                <input id="userGrade" type="text">
              </div>
              <div class="form-group">
                <label>クラス/所属</label>
                <input id="userClass" type="text">
              </div>
            </div>
            <div class="form-actions">
              <button type="submit" class="btn btn-success">保存</button>
              <button type="button" class="btn btn-secondary" onclick="closeUserModal()">キャンセル</button>
            </div>
          </form>
        </div>
        <div class="modal-backdrop" onclick="closeUserModal()"></div>
      </div>
    `;
    
    await loadUsers();
  };
  
  // ユーザー一覧を読み込み
  async function loadUsers() {
    try {
      window.showActionResult('処理中', 'ユーザーデータ読み込み中...', 'processing');
      
      const db = window.adminState.db;
      
      // ユーザー情報を取得
      const usersSnap = await db.collection('users').get();
      usersCache = usersSnap.docs.map(d => ({ uid: d.id, ...d.data() }));
      
      // 貸出統計を取得
      const loansSnap = await db.collection('loans')
        .where('status', '==', 'active')
        .get();
      
      const userLoanCounts = {};
      loansSnap.docs.forEach(doc => {
        const uid = doc.data().uid;
        userLoanCounts[uid] = (userLoanCounts[uid] || 0) + 1;
      });
      
      // 統計を計算
      const activeReaders = Object.keys(userLoanCounts).length;
      const totalLoans = loansSnap.size;
      const avgLoans = usersCache.length > 0 ? (totalLoans / usersCache.length).toFixed(1) : 0;
      
      // 統計を表示
      window.setText('userTotalCount', usersCache.length);
      window.setText('userActiveReaders', activeReaders);
      window.setText('userCurrentLoans', totalLoans);
      window.setText('userAvgLoans', avgLoans);
      
      // ユーザーに貸出数を追加
      usersCache.forEach(user => {
        user.currentLoans = userLoanCounts[user.uid] || 0;
      });
      
      renderUsersTable(usersCache);
      
      const resultSection = window.$('actionResultSection');
      if (resultSection) resultSection.style.display = 'none';
    } catch (e) {
      console.error(e);
      window.showActionResult('エラー', 'ユーザー一覧の読み込み失敗', 'error');
    }
  }
  
  // ユーザー検索
  window.searchUsers = function() {
    const term = (window.$('userSearchInput')?.value || '').trim().toLowerCase();
    const roleFilter = window.$('userRoleFilter')?.value || '';
    
    let filtered = usersCache;
    
    if (term) {
      filtered = filtered.filter(u => {
        const text = [
          u.name, u.email, u.user_id, u.grade, u.class
        ].filter(Boolean).join(' ').toLowerCase();
        return text.includes(term);
      });
    }
    
    if (roleFilter) {
      filtered = filtered.filter(u => u.role === roleFilter);
    }
    
    renderUsersTable(filtered);
  };
  
  // ユーザーテーブルをレンダリング
  function renderUsersTable(users) {
    const container = window.$('userTableContainer');
    if (!container) return;
    
    if (!users.length) {
      container.innerHTML = '<p>該当するユーザーはありません</p>';
      return;
    }
    
    const header = `
      <table class="preview-table">
        <thead>
          <tr>
            <th>名前</th>
            <th>メール</th>
            <th>ID</th>
            <th>権限</th>
            <th>学年/部署</th>
            <th>現在の貸出</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
    `;
    
    const body = users.map(u => {
      const roleLabel = {
        'student': '学生',
        'teacher': '教員',
        'admin': '管理者'
      }[u.role] || u.role;
      
      return `
        <tr>
          <td>${window.escapeHtml(u.name || '-')}</td>
          <td>${window.escapeHtml(u.email || '-')}</td>
          <td>${window.escapeHtml(u.user_id || '-')}</td>
          <td><span class="status-badge">${window.escapeHtml(roleLabel)}</span></td>
          <td>${window.escapeHtml(u.grade || '-')} ${window.escapeHtml(u.class || '')}</td>
          <td>${u.currentLoans || 0}冊</td>
          <td>
            <button class="btn btn-sm" onclick="editUser('${u.uid}')">編集</button>
            <button class="btn btn-sm" onclick="viewUserLoans('${u.uid}')">貸出履歴</button>
            ${u.role !== 'admin' ? `<button class="btn btn-sm btn-danger" onclick="deleteUser('${u.uid}')">削除</button>` : ''}
          </td>
        </tr>
      `;
    }).join('');
    
    container.innerHTML = header + body + '</tbody></table>';
  }
  
  // ユーザー追加モーダルを表示
  window.showAddUserModal = function() {
    window.$('userModalTitle').textContent = 'ユーザー追加';
    window.$('userForm').reset();
    window.$('userModal').style.display = 'flex';
  };
  
  // ユーザー編集
  window.editUser = function(uid) {
    const user = usersCache.find(u => u.uid === uid);
    if (!user) return;
    
    window.$('userModalTitle').textContent = 'ユーザー編集';
    window.$('userName').value = user.name || '';
    window.$('userEmail').value = user.email || '';
    window.$('userId').value = user.user_id || '';
    window.$('userRole').value = user.role || 'student';
    window.$('userGrade').value = user.grade || '';
    window.$('userClass').value = user.class || '';
    
    window.$('userForm').dataset.editUid = uid;
    window.$('userModal').style.display = 'flex';
  };
  
  // ユーザー保存
  window.saveUser = async function(event) {
    event.preventDefault();
    
    const form = event.target;
    const editUid = form.dataset.editUid;
    
    const userData = {
      name: window.$('userName').value.trim(),
      email: window.$('userEmail').value.trim(),
      user_id: window.$('userId').value.trim(),
      role: window.$('userRole').value,
      grade: window.$('userGrade').value.trim() || null,
      class: window.$('userClass').value.trim() || null,
      updated_at: firebase.firestore.FieldValue.serverTimestamp()
    };
    
    try {
      const db = window.adminState.db;
      
      if (editUid) {
        // 更新
        await db.collection('users').doc(editUid).update(userData);
        window.showActionResult('更新完了', 'ユーザー情報を更新しました', 'success');
      } else {
        // 新規追加（実際のユーザー作成はAuthenticationで行う必要がある）
        alert('ユーザーの新規作成は、サインアップページから行ってください');
        return;
      }
      
      closeUserModal();
      await loadUsers();
    } catch (e) {
      console.error(e);
      window.showActionResult('エラー', e.message, 'error');
    }
  };
  
  // ユーザー削除
  window.deleteUser = async function(uid) {
    const user = usersCache.find(u => u.uid === uid);
    if (!user) return;
    
    if (!confirm(`${user.name}（${user.email}）を削除しますか？\n\n※Authenticationからも削除する必要があります`)) {
      return;
    }
    
    try {
      const db = window.adminState.db;
      
      // 貸出中チェック
      const loansSnap = await db.collection('loans')
        .where('uid', '==', uid)
        .where('status', '==', 'active')
        .limit(1)
        .get();
      
      if (!loansSnap.empty) {
        window.showActionResult('削除不可', '貸出中の書籍があるため削除できません', 'error');
        return;
      }
      
      await db.collection('users').doc(uid).delete();
      window.showActionResult('削除完了', 'ユーザーを削除しました', 'success');
      await loadUsers();
    } catch (e) {
      console.error(e);
      window.showActionResult('削除失敗', e.message, 'error');
    }
  };
  
  // ユーザーの貸出履歴を表示
  window.viewUserLoans = async function(uid) {
    const user = usersCache.find(u => u.uid === uid);
    if (!user) return;
    
    try {
      const db = window.adminState.db;
      const loansSnap = await db.collection('loans')
        .where('uid', '==', uid)
        .orderBy('checked_out_at', 'desc')
        .limit(20)
        .get();
      
      const loans = loansSnap.docs.map(d => d.data());
      
      let html = `<h3>${user.name}さんの貸出履歴（最新20件）</h3>`;
      
      if (loans.length === 0) {
        html += '<p>貸出履歴がありません</p>';
      } else {
        html += '<table class="preview-table"><thead><tr><th>書名</th><th>貸出日</th><th>返却日</th><th>状態</th></tr></thead><tbody>';
        loans.forEach(loan => {
          const checkoutDate = loan.checked_out_at?.toDate?.() || new Date(loan.checked_out_at);
          const returnDate = loan.returned_at?.toDate?.() || (loan.returned_at ? new Date(loan.returned_at) : null);
          const status = loan.status === 'active' ? '貸出中' : '返却済';
          
          html += `
            <tr>
              <td>${window.escapeHtml(loan.book_title || '-')}</td>
              <td>${checkoutDate.toLocaleDateString('ja-JP')}</td>
              <td>${returnDate ? returnDate.toLocaleDateString('ja-JP') : '-'}</td>
              <td>${status}</td>
            </tr>
          `;
        });
        html += '</tbody></table>';
      }
      
      const container = window.$('userTableContainer');
      if (container) {
        const backBtn = '<button class="btn btn-secondary" onclick="loadUsers()">← 戻る</button>';
        container.innerHTML = backBtn + html;
      }
    } catch (e) {
      console.error(e);
      window.showActionResult('エラー', '貸出履歴の取得に失敗しました', 'error');
    }
  };
  
  // モーダルを閉じる
  window.closeUserModal = function() {
    window.$('userModal').style.display = 'none';
    window.$('userForm').reset();
    delete window.$('userForm').dataset.editUid;
  };
  
  // CSVエクスポート
  window.exportUsersCsv = function() {
    if (!usersCache.length) {
      window.showActionResult('エラー', 'エクスポート対象がありません', 'error');
      return;
    }
    
    const rows = usersCache.map(u => ({
      名前: u.name || '',
      メール: u.email || '',
      ID: u.user_id || '',
      権限: u.role || '',
      学年: u.grade || '',
      クラス: u.class || '',
      現在の貸出: u.currentLoans || 0
    }));
    
    const csv = window.Papa?.unparse ? Papa.unparse(rows) : 
      rows.map(r => Object.values(r).map(v => `"${String(v).replace(/"/g,'""')}"`).join(',')).join('\n');
    
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `users_${new Date().toISOString().slice(0,10)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };
  
  console.log('✅ admin-users.js loaded');
})();
