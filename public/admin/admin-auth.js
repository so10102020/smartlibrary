// ===== 管理者認証・権限管理 =====
(function(){
  'use strict';
  
  // 管理者権限チェック
  async function checkAdminPermission(currentUser) {
    const uid = currentUser?.uid;
    if (!uid) return false;
    
    const db = window.adminState.db;
    try {
      let userDoc = await db.collection('users').doc(uid).get();
      let userData = userDoc.exists ? userDoc.data() : null;
      
      if (!userData && currentUser.email) {
        const byEmail = await db.collection('users')
          .where('email','==', currentUser.email)
          .limit(1)
          .get();
        if (!byEmail.empty) userData = byEmail.docs[0].data();
      }
      
      if (!userData) return false;
      return userData.role === 'admin' || userData.is_admin === true;
    } catch (error) {
      console.error('Admin permission check error:', error);
      return false;
    }
  }
  
  // 管理者認証
  window.verifyAdmin = async function() {
    try {
      await window.waitForFirebase();
      const user = window.adminState.auth.currentUser;
      
      if (!user) {
        window.showMessage('adminAuthMsg', 'ログインが必要です', 'error');
        window.location.href = 'login.html';
        return;
      }
      
      const isAdmin = await checkAdminPermission(user);
      if (!isAdmin) {
        window.adminState.isAuthenticated = false;
        window.showMessage('adminAuthMsg', '管理者権限がありません', 'error');
        return;
      }
      
      window.adminState.isAuthenticated = true;
      window.showMessage('adminAuthMsg', `管理者認証: ${user.email}`, 'success');
      
      const adminAuthSection = document.getElementById('adminAuthSection');
      if (adminAuthSection) adminAuthSection.style.display = 'none';
      
      window.showElement('mainContent', true);
      const params = new URLSearchParams(window.location.search);
      const requestedTab = params.get('tab') || 'dashboard';

      if (requestedTab === 'quick') {
        window.showTab('quick');
        if (typeof window.initQuickRegister === 'function') {
          window.initQuickRegister();
        }
      } else if (requestedTab === 'books') {
        window.showTab('books');
        if (typeof window.initBooksManagement === 'function') {
          window.initBooksManagement();
        }
      } else {
        window.showTab('dashboard');
        if (typeof window.initDashboard === 'function') {
          window.initDashboard();
        }
      }
    } catch (error) {
      console.error('管理者認証エラー:', error);
      window.showMessage('adminAuthMsg', `認証エラー: ${error.message}`, 'error');
    }
  };
  
  // 管理者一覧取得
  async function getAdminList() {
    const db = window.adminState.db;
    const snapshot = await db.collection('users').where('role', '==', 'admin').get();
    const admins = [];
    
    snapshot.forEach(doc => {
      const userData = doc.data();
      admins.push({
        uid: doc.id,
        email: userData.email,
        display_name: userData.display_name || userData.email,
        admin_granted_at: userData.admin_granted_at
      });
    });
    
    return admins;
  }
  
  // 管理者設定UI
  window.showAdminManagement = async function() {
    try {
      const adminList = await getAdminList();
      let html = '<h3>🔧 管理者設定</h3>';
      
      html += `
        <div class="admin-form">
          <h4>管理者権限の付与</h4>
          <div class="form-group">
            <input type="email" id="newAdminEmail" placeholder="メールアドレス">
            <button onclick="addNewAdmin()" class="btn btn-primary">管理者に設定</button>
          </div>
        </div>
      `;
      
      html += '<div class="admin-list"><h4>現在の管理者</h4>';
      if (adminList.length > 0) {
        html += '<ul>';
        adminList.forEach(admin => {
          const grantedDate = admin.admin_granted_at?.toDate?.()?.toLocaleDateString() || '不明';
          html += `
            <li class="admin-item">
              <span>${window.escapeHtml(admin.display_name)} (${window.escapeHtml(admin.email)})</span>
              <span class="admin-date">設定日: ${grantedDate}</span>
              <button onclick="removeAdmin('${window.escapeHtml(admin.email)}')" class="btn btn-sm btn-danger">権限削除</button>
            </li>`;
        });
        html += '</ul>';
      } else {
        html += '<p>管理者が設定されていません</p>';
      }
      html += '</div>';
      
      window.$('adminManagementContent').innerHTML = html;
      window.showElement('adminManagementSection', true);
    } catch (error) {
      window.showActionResult('エラー', '管理者設定の取得に失敗', 'error');
    }
  };
  
  // 管理者追加
  window.addNewAdmin = async function() {
    const email = window.$('newAdminEmail').value.trim();
    if (!email) {
      window.showActionResult('エラー', 'メールアドレスを入力してください', 'error');
      return;
    }
    
    try {
      const db = window.adminState.db;
      const snapshot = await db.collection('users').where('email', '==', email).get();
      
      if (snapshot.empty) {
        throw new Error('ユーザーが見つかりません');
      }
      
      await snapshot.docs[0].ref.update({
        role: 'admin',
        is_admin: true,
        admin_granted_at: firebase.firestore.FieldValue.serverTimestamp()
      });
      
      window.showActionResult('完了', `${email} を管理者に設定しました`, 'success');
      window.$('newAdminEmail').value = '';
      await window.showAdminManagement();
    } catch (error) {
      window.showActionResult('失敗', error.message, 'error');
    }
  };
  
  // 管理者削除
  window.removeAdmin = async function(email) {
    if (!confirm(`${email} の管理者権限を削除しますか？`)) return;
    
    try {
      const db = window.adminState.db;
      const snapshot = await db.collection('users').where('email', '==', email).get();
      
      if (snapshot.empty) {
        throw new Error('ユーザーが見つかりません');
      }
      
      await snapshot.docs[0].ref.update({
        role: 'user',
        is_admin: false,
        admin_removed_at: firebase.firestore.FieldValue.serverTimestamp()
      });
      
      window.showActionResult('完了', `${email} の権限を削除しました`, 'success');
      await window.showAdminManagement();
    } catch (error) {
      window.showActionResult('失敗', error.message, 'error');
    }
  };
  
  console.log('✅ admin-auth.js loaded');
})();
