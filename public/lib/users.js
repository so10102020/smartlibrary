(function () {
  'use strict';

  const db = () => firebase.firestore();
  const ts = () => firebase.firestore.FieldValue.serverTimestamp();

  function $(id) { return document.getElementById(id); }
  function escapeHtml(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function setMsg(id, msg, isError = false) {
    const el = $(id);
    if (!el) return;
    el.textContent = msg;
    el.style.color = isError ? '#c62828' : '#2e7d32';
  }

  async function addUser() {
    const userId = ($("userId")?.value || '').trim();
    const name = ($("userName")?.value || '').trim();
    const role = ($("userRole")?.value || '').trim() || 'student';

    if (!userId || !name) {
      setMsg('userAddMessage', 'ユーザーIDと氏名を入力してください。', true);
      return;
    }

    setMsg('userAddMessage', '登録中...');
    try {
      await db().collection('users').doc(userId).set({
        user_id: userId,
        name,
        name_lc: name.toLowerCase(),
        role,
        created_at: ts(),
      }, { merge: true });
      setMsg('userAddMessage', '登録しました。');
    } catch (e) {
      console.error(e);
      setMsg('userAddMessage', e.message || '登録に失敗しました。', true);
    }
  }

  async function searchUsers() {
    const termRaw = ($("userSearchTerm")?.value || '').trim();
    const term = termRaw.toLowerCase();
    const container = $("usersContainer");
    if (!term || term.length < 2) {
      container.innerHTML = '<p>2文字以上で検索してください。</p>';
      return;
    }

    container.innerHTML = '検索中...';

    try {
      // 1) user_id 完全一致
      const idSnap = await db().collection('users')
        .where('user_id', '==', termRaw)
        .limit(1)
        .get();

      let users = [];
      if (!idSnap.empty) {
        users = idSnap.docs.map(d => d.data());
      } else {
        // 2) name_lc 前方一致
        const nameSnap = await db().collection('users')
          .orderBy('name_lc')
          .startAt(term)
          .endAt(term + '\uf8ff')
          .limit(50)
          .get();
        users = nameSnap.docs.map(d => d.data());
      }

      if (!users.length) {
        container.innerHTML = '<p>該当する利用者は見つかりませんでした。</p>';
        return;
      }

      const html = users.map(u => `
        <div class="result-card">
          <p class="result-meta"><strong>ID:</strong> ${escapeHtml(u.user_id)}</p>
          <p class="result-meta"><strong>氏名:</strong> ${escapeHtml(u.name)}</p>
          <p class="result-meta"><strong>区分:</strong> ${escapeHtml(u.role || '-')}</p>
        </div>
      `).join('');

      container.innerHTML = html;
    } catch (e) {
      console.error(e);
      container.innerHTML = '<p>検索中にエラーが発生しました。</p>';
    }
  }

  // 公開
  window.addUser = addUser;
  window.searchUsers = searchUsers;

  // ユーザー管理画面を表示
  window.showUserManagement = async function() {
    const container = $("userManagementContainer");
    if (!container) return;

    container.innerHTML = `
      <h2>👥 ユーザー管理</h2>
      
      <!-- ユーザー登録セクション -->
      <div class="form-section">
        <h3>新規ユーザー登録</h3>
        <div class="form-grid">
          <div class="form-group">
            <label for="userId">ユーザーID *:</label>
            <input type="text" id="userId" placeholder="学籍番号など" required>
          </div>
          <div class="form-group">
            <label for="userName">氏名 *:</label>
            <input type="text" id="userName" placeholder="山田 太郎" required>
          </div>
          <div class="form-group">
            <label for="userRole">区分:</label>
            <select id="userRole">
              <option value="student">学生</option>
              <option value="teacher">教職員</option>
              <option value="admin">管理者</option>
            </select>
          </div>
        </div>
        <div class="form-actions">
          <button onclick="addUser()" class="btn btn-primary">登録</button>
        </div>
        <div id="userAddMessage" class="message"></div>
      </div>

      <!-- ユーザー検索セクション -->
      <div class="form-section">
        <h3>ユーザー検索</h3>
        <div class="search-group">
          <input type="text" id="userSearchTerm" placeholder="ユーザーIDまたは氏名で検索..." onkeyup="if(event.key==='Enter') searchUsers()">
          <button onclick="searchUsers()" class="btn btn-primary">🔍 検索</button>
        </div>
        <div id="usersContainer" class="results-grid" style="margin-top: 1rem;">
          <p style="color: #666;">2文字以上入力して検索してください</p>
        </div>
      </div>

      <!-- ユーザー一覧（全件表示） -->
      <div class="form-section">
        <h3>登録ユーザー一覧</h3>
        <button onclick="loadAllUsers()" class="btn btn-secondary">全件表示</button>
        <div id="allUsersContainer" class="table-responsive" style="margin-top: 1rem;"></div>
      </div>
    `;

    // 初期表示として全件読み込み
    loadAllUsers();
  };

  // 全ユーザーを読み込む
  window.loadAllUsers = async function() {
    const container = $("allUsersContainer");
    if (!container) return;

    container.innerHTML = '<p>読み込み中...</p>';

    try {
      const snapshot = await db().collection('users')
        .orderBy('created_at', 'desc')
        .limit(100)
        .get();

      if (snapshot.empty) {
        container.innerHTML = '<p>登録ユーザーがいません。</p>';
        return;
      }

      const users = snapshot.docs.map(doc => doc.data());

      const tableHtml = `
        <table class="data-table">
          <thead>
            <tr>
              <th>ユーザーID</th>
              <th>氏名</th>
              <th>メールアドレス</th>
              <th>区分</th>
              <th>登録日</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            ${users.map(u => `
              <tr>
                <td>${escapeHtml(u.user_id || u.uid || '-')}</td>
                <td>${escapeHtml(u.name || '-')}</td>
                <td>${escapeHtml(u.email || '-')}</td>
                <td>${escapeHtml(u.role || 'student')}</td>
                <td>${u.created_at ? new Date(u.created_at.toDate()).toLocaleDateString('ja-JP') : '-'}</td>
                <td>
                  <button class="btn btn-sm btn-secondary" onclick="editUser('${escapeHtml(u.uid || u.user_id)}')">編集</button>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      `;

      container.innerHTML = tableHtml;
    } catch (e) {
      console.error(e);
      container.innerHTML = `<p style="color: #c62828;">エラー: ${e.message}</p>`;
    }
  };

  // ユーザー編集（プレースホルダー）
  window.editUser = function(userId) {
    alert(`ユーザー編集機能（UID: ${userId}）\n今後実装予定です。`);
  };
})();
